/**
 * The secrets-agent: an in-memory broker that holds resolved bundle env after one
 * Touch ID unlock, so concurrent agents don't each prompt.
 *
 * Security model: while unlocked, any same-user process reaching the socket can
 * read it silently — the same trust boundary the keychain already concedes. We
 * bound it with per-bundle opt-in, a TTL (~7d), auto-wipe on sleep/logout, and
 * explicit lock. Nothing touches disk. Off-darwin the broker is unused.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawn, spawnSync, execFileSync, type ChildProcess, type SpawnSyncReturns } from 'child_process';
import { getHelpersDir, readMeta } from '../state.js';
import { isAlive, waitForExit } from '../platform/process.js';
import { getKeychainHelperPath } from './install-helper.js';
import { getCliVersion, getCliVersionFresh } from '../version.js';
import { getCliLaunch } from '../cli-entry.js';
import type { SecretsBundle } from './bundles.js';
import { GLOBAL_HARNESS, bundleScopeChain } from './scope.js';
import { deleteLeaseSession, rehydrateSessions, pruneSessionsOnSleep } from './session-store.js';
import { serviceManagerRegistrationAllowed } from '../service-manifest.js';
import { SYNC_GET_CMD, SYNC_PING_CMD, SYNC_LOCK_CMD } from './sync-commands.js';
import { MAX_LEASE_MS, MIN_LEASE_MS } from './lease.js';
import { selectLeasedEnv, type SecretLease } from './lease.js';
import { emitSecretAudit } from './audit.js';
import { isDaemonServiceEnabled } from '../daemon-services.js';

// Re-exported from scope.ts to break the agent.ts ↔ session-store.ts import cycle.
export { GLOBAL_HARNESS, bundleScopeChain };

/** Bumped when the wire protocol changes; a client that pings a mismatched
 * server kills and respawns it rather than talking a stale dialect. */
const PROTOCOL_VERSION = 3;

/** Default lifetime of an unlocked bundle when `--ttl` is not given. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

/**
 * Whether the secrets broker service is enabled in daemon service config.
 */
export function isSecretsBrokerEnabled(): boolean {
  return isDaemonServiceEnabled('secrets-broker');
}

/**
 * Reserved store-key prefix for the `secrets list` metadata snapshot cache.
 * Keyed by a hash of the keychain name-set; adding/removing/renaming a bundle
 * changes the key and invalidates passively. The '!' sentinel cannot collide
 * with a real bundle name and is safe as argv.
 */
export const META_CACHE_PREFIX = '!meta:';

/** After the store goes empty (all bundles locked or expired) for this long,
 * the broker exits so no idle process lingers holding a socket. */
const IDLE_EXIT_MS = 5 * 60 * 1000; // 5m

/** How often the broker sweeps expired entries. */
const SWEEP_INTERVAL_MS = 30 * 1000;

/** How many times a starting broker probes an in-use socket before treating its
 * owner as gone. One probe is not enough: the broker is single-threaded, so a
 * large read or the startup rehydrate can outlast a single ping budget while the
 * process is healthy. */
const BIND_PROBE_ATTEMPTS = 3;
/** How long a broker teardown waits for the old process to actually exit before
 * clearing its socket + ownership record. */
const BROKER_STOP_GRACE_MS = 3000;
/** Pause between those probes. */
const BIND_PROBE_INTERVAL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Timeouts for the synchronous broker clients. Parent `spawnSync` budgets are
 * looser than socket budgets so a slow child boot isn't misreported as "broker
 * down" (which costs a Touch ID prompt).
 */
const SOCKET_GET_TIMEOUT_MS = 2000;
const SOCKET_PING_TIMEOUT_MS = 700;
const SOCKET_LOCK_TIMEOUT_MS = 2000;
const SYNC_GET_TIMEOUT_MS = 4000;
const SYNC_PING_TIMEOUT_MS = 2500;
const SYNC_LOCK_TIMEOUT_MS = 4000;

// Re-exported from sync-commands.ts so index.ts can share the same argv tokens
// without importing this module (would create a cycle/startup cost).
export { SYNC_GET_CMD, SYNC_PING_CMD, SYNC_LOCK_CMD } from './sync-commands.js';

/**
 * Decide whether a persistent broker should exit so launchd relaunches it on
 * freshly-installed code. Only when the store is empty: exiting with held
 * bundles would force a re-prompt. Deferring protects against rapid upgrades
 * wiping the hot cache (#435).
 */
export function shouldSelfHealForUpgrade(
  persistent: boolean,
  storeSize: number,
  runningVersion: string,
  onDiskVersion: string,
): boolean {
  if (!persistent) return false;
  if (storeSize > 0) return false; // hot cache — defer rather than wipe unlocks
  if (runningVersion === 'unknown' || onDiskVersion === 'unknown') return false;
  return onDiskVersion !== runningVersion;
}

/**
 * Client-side twin: may only tear down a version-skewed broker when it holds
 * no real unlocks, otherwise every held bundle re-prompts (#435).
 */
export function shouldTeardownVersionSkewedBroker(realHeldBundles: number): boolean {
  return realHeldBundles === 0;
}

/**
 * Whether a client may evict a version-skewed broker. A daemon-hosted broker
 * must never be client-evicted: the daemon owns the socket via ownerPath(), so
 * unlinking it would orphan the broker until daemon restart (#435).
 */
export function shouldClientEvictSkewedBroker(
  daemonRunning: boolean,
  realHeldBundles: number,
): boolean {
  if (daemonRunning) return false;
  return shouldTeardownVersionSkewedBroker(realHeldBundles);
}

export interface StoredBundle {
  bundle: SecretsBundle;
  env: Record<string, string>;
  /** epoch ms; the entry is gone once Date.now() passes this. */
  expiresAt: number;
  harness: string;
  lease?: SecretLease;
}

/** One unlocked bundle as reported by `status`. */
export interface AgentStatusEntry {
  name: string;
  expiresAt: number;
  keyCount: number;
  harness: string;
  leaseId?: string;
  keys?: string[];
}

function onDarwin(): boolean {
  return process.platform === 'darwin';
}

/**
 * Build the broker's in-memory store from durable sessions so unlocks survive
 * restart/upgrade. Empty off darwin or when nothing was held.
 */
function rehydrateStore(now: number = Date.now()): Map<string, StoredBundle> {
  const store = new Map<string, StoredBundle>();
  for (const { name, entry } of rehydrateSessions(now)) {
    const harness = entry.harness || GLOBAL_HARNESS;
    store.set(scopedBundleKey(name, harness), { bundle: entry.bundle, env: entry.env, expiresAt: entry.expiresAt, harness, lease: entry.lease });
  }
  return store;
}

/** Broker runtime dir (0700). Override with AGENTS_SECRETS_AGENT_DIR for tests. */
function agentDir(): string {
  const dir = process.env.AGENTS_SECRETS_AGENT_DIR || path.join(getHelpersDir(), 'secrets-agent');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

function socketPath(): string {
  return path.join(agentDir(), 'agent.sock');
}

/** Public accessor for the broker's socket path — `agents daemon status`/`services` reads it for display. */
export function secretsBrokerSocketPath(): string {
  return socketPath();
}

function pidPath(): string {
  return path.join(agentDir(), 'agent.pid');
}

/**
 * Per-broker capability token path (0600 inside the 0700 agent dir). The file
 * permission is the authorization boundary.
 */
function tokenPath(): string {
  return path.join(agentDir(), 'agent.token');
}

/**
 * Path of the current socket owner's pid. NOT `agent.pid`, which is the
 * standalone service's O_EXCL single-instance claim. Separating them prevents a
 * standby standalone from seeing a live holder and exiting in a restart loop.
 */
function ownerPath(): string {
  return path.join(agentDir(), 'agent.owner');
}

/**
 * Read the current broker capability token. A restart mints a new token, so a
 * stale read fails soft and the caller falls back to a direct keychain read.
 */
export function readAgentToken(): string | null {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf-8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Mint and persist a fresh capability token (0600) at socket-bind time. */
function writeAgentToken(): string {
  const token = randomBytes(32).toString('hex');
  const fp = tokenPath();
  fs.writeFileSync(fp, token, { mode: 0o600 });
  try { fs.chmodSync(fp, 0o600); } catch { /* dir 0700 already gates it */ }
  return token;
}

/**
 * Argv for re-invoking this CLI with a hidden subcommand. Uses getCliLaunch so
 * both JS-entry and Bun-standalone installs work; the old `process.argv[1]`
 * approach broke on standalone builds with a virtual `/$bunfs/root/agents` path.
 */
function cliSpawn(sub: string[]): { cmd: string; args: string[] } {
  const { command, args } = getCliLaunch(sub);
  return { cmd: command, args };
}

function brokerSpawn(): { cmd: string; args: string[] } {
  return cliSpawn(['secrets', '_agent-run']);
}

// ─── Legacy standalone launchd service (retired, #416) ───────────────────────
// The broker is now hosted by the always-on daemon. The functions below only
// detect and retire a plist left by older versions so the daemon owns the socket.

const SERVICE_LABEL = 'com.phnx-labs.agents-secrets-agent';

// LaunchAgents dir. A relocated test dir is not launchd-managed, so retirement
// there is pure file removal.
function launchAgentsDir(): string {
  return process.env.AGENTS_SECRETS_LAUNCHAGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function servicePlistPath(): string {
  return path.join(launchAgentsDir(), `${SERVICE_LABEL}.plist`);
}

/** True if a legacy standalone-broker launchd plist is still installed. */
export function secretsAgentServiceInstalled(): boolean {
  return onDarwin() && fs.existsSync(servicePlistPath());
}

/**
 * Retire the legacy standalone launchd service so the daemon owns the socket.
 * Idempotent; does not wipe held bundles.
 */
export function retireLegacySecretsAgentService(): void {
  if (!onDarwin() || !secretsAgentServiceInstalled()) return;
  const plist = servicePlistPath();
  // Only the real LaunchAgents dir is launchd-managed; a relocated (test) dir
  // has no bootstrapped job, so skip launchctl and just remove the plist.
  // Also skip launchctl under a redirected HOME: launchctl is per-user-session
  // and HOME-independent, so a sandboxed process would still talk to the real
  // launchd (RUSH-2968).
  const reg = serviceManagerRegistrationAllowed();
  if (!process.env.AGENTS_SECRETS_LAUNCHAGENTS_DIR && reg.allowed) {
    const uid = process.getuid?.() ?? 0;
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: ['ignore', 'ignore', 'ignore'] }); }
    catch { try { execFileSync('launchctl', ['unload', '-w', plist], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* not loaded */ } }
  } else if (!reg.allowed) {
    process.stderr.write(`[agents] ${reg.reason}\n`);
  }
  try { fs.unlinkSync(plist); } catch { /* already gone */ }
}

/**
 * Stop the persistent broker for `agents secrets stop`: wipe held bundles, then
 * retire any legacy standalone service. The daemon-hosted broker itself is left
 * running because it backs unrelated background work.
 */
export async function uninstallSecretsAgentService(): Promise<void> {
  if (!onDarwin()) return;
  await agentLock(); // wipe the in-memory store before retiring the legacy service
  retireLegacySecretsAgentService();
}

// ─── Wire protocol ───────────────────────────────────────────────────────────
// Newline-delimited JSON: one request object per line, one response line back.

export type Request =
  | { cmd: 'ping' }
  | { cmd: 'get'; name: string; harness?: string; token?: string }
  | { cmd: 'load'; name: string; harness?: string; bundle: SecretsBundle; env: Record<string, string>; ttlMs: number; lease?: SecretLease; token?: string; snapshotAt?: number }
  | { cmd: 'lock'; name?: string; token?: string }
  | { cmd: 'revoke'; leaseId: string; token?: string }
  | { cmd: 'status'; token?: string };

export type Response =
  | { ok: true; cmd: 'ping'; version: number; cliVersion: string }
  | { ok: true; cmd: 'get'; hit: false }
  | { ok: true; cmd: 'get'; hit: true; bundle: SecretsBundle; env: Record<string, string>; lease?: SecretLease }
  | { ok: true; cmd: 'load' }
  | { ok: true; cmd: 'lock'; wiped: number }
  | { ok: true; cmd: 'revoke'; wiped: number }
  | { ok: true; cmd: 'status'; entries: AgentStatusEntry[] }
  | { ok: false; error: string };

// ─── Broker server (runs in the detached `secrets _agent-run` process) ───────

/**
 * Count of real unlocked bundles, excluding the internal `secrets list` metadata
 * cache. A metadata-only store must read as empty so it doesn't block upgrade
 * self-heal or idle-exit (#435). Exported for tests.
 */
export function realBundleCount(store: Map<string, StoredBundle>): number {
  let n = 0;
  for (const e of store.values()) if (!e.bundle.name.startsWith(META_CACHE_PREFIX)) n++;
  return n;
}

export function scopedBundleKey(name: string, harness: string): string {
  return `${harness}:${name}`;
}

/** Pure request handler over the in-memory store. Exported for tests. */
export function handleAgentRequest(
  store: Map<string, StoredBundle>,
  req: Request,
  now: number = Date.now(),
  // Eviction tombstones: reject loads whose snapshot predates the eviction so a
  // detached auto-load can't re-populate stale state.
  evictedAt: Map<string, number> = new Map(),
): Response {
  switch (req.cmd) {
    case 'ping':
      // Report the running version, not on-disk, so clients detect pre-upgrade brokers.
      return { ok: true, cmd: 'ping', version: PROTOCOL_VERSION, cliVersion: getCliVersion() };
    case 'get': {
      // own-harness → global: scoped grants win, unscoped unlocks serve all.
      for (const scope of bundleScopeChain(req.harness)) {
        const key = scopedBundleKey(req.name, scope);
        const e = store.get(key);
        if (!e) continue;
        if (now >= e.expiresAt) {
          store.delete(key);
          if (e.lease) {
            deleteLeaseSession(e.lease.id);
            emitSecretAudit({ event: 'secrets.lease-expire', bundle: e.bundle.name, operation: 'lease-expire', source: 'broker', status: 'success', keys: e.lease.keys, keyCount: e.lease.keys.length, agent: e.lease.harness });
          }
          continue;
        }
        return { ok: true, cmd: 'get', hit: true, bundle: e.bundle, env: e.env, lease: e.lease };
      }
      return { ok: true, cmd: 'get', hit: false };
    }
    case 'load': {
      const evictedTs = evictedAt.get(req.name);
      if (evictedTs !== undefined && req.snapshotAt !== undefined && req.snapshotAt <= evictedTs) {
        // Reject loads captured before a mutating write evicted this name.
        return { ok: false, error: `stale load for '${req.name}': snapshot predates an eviction` };
      }
      const harness = req.harness || GLOBAL_HARNESS;
      let env = req.env;
      if (req.lease) {
        try { env = selectLeasedEnv(req.lease, req.env, now); }
        catch (err) { return { ok: false, error: (err as Error).message }; }
      }
      store.set(scopedBundleKey(req.name, harness), { bundle: req.bundle, env, expiresAt: req.lease?.expiresAt ?? now + req.ttlMs, harness, lease: req.lease });
      return { ok: true, cmd: 'load' };
    }
    case 'lock': {
      if (req.name) {
        let wiped = 0;
        for (const [key, entry] of store) if (entry.bundle.name === req.name && store.delete(key)) wiped++;
        evictedAt.set(req.name, now);
        return { ok: true, cmd: 'lock', wiped };
      }
      const wiped = store.size;
      for (const entry of store.values()) evictedAt.set(entry.bundle.name, now);
      store.clear();
      return { ok: true, cmd: 'lock', wiped };
    }
    case 'revoke': {
      let wiped = 0;
      for (const [key, entry] of store) if (entry.lease?.id === req.leaseId && store.delete(key)) wiped++;
      return { ok: true, cmd: 'revoke', wiped };
    }
    case 'status': {
      const entries: AgentStatusEntry[] = [];
      for (const [name, e] of store) {
        if (now >= e.expiresAt) continue;
        if (e.bundle.name.startsWith(META_CACHE_PREFIX)) continue; // internal list cache
        entries.push({ name: e.bundle.name, expiresAt: e.expiresAt, keyCount: Object.keys(e.env).length, harness: e.harness, leaseId: e.lease?.id, keys: e.lease?.keys });
      }
      return { ok: true, cmd: 'status', entries };
    }
  }
}

/**
 * Wipe the in-memory store only on SLEEP, not screen-lock (already gated by the
 * login password). Exported for regression coverage of the LOCK-survives /
 * SLEEP-wipes contract.
 */
export function shouldWipeOnWatchEvent(chunk: string): boolean {
  return /\bSLEEP\b/.test(chunk);
}

/**
 * Authorization gate: every request except `ping` must carry the per-broker
 * capability token from the 0600 token file. `ping` stays unauthenticated so
 * clients can probe reachability before reading the token. Fail closed. Exported
 * for tests.
 */
export function isRequestAuthorized(req: Request, expectedToken: string | null): boolean {
  if (req.cmd === 'ping') return true;
  if (!expectedToken) return false;
  return req.token === expectedToken;
}

type BrokerConnectionHandler = (conn: net.Socket) => void;

/**
 * Build the socket `connection` handler shared by standalone and daemon-hosted
 * brokers. Newline-framed JSON in, one response line out, with per-request token
 * lookup so rotation on restart is picked up.
 */
export function makeConnectionHandler(
  handle: (req: Request) => Response,
  token: () => string | null,
): BrokerConnectionHandler {
  return (conn: net.Socket) => {
    conn.setEncoding('utf-8');
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let resp: Response;
        try {
          const req = JSON.parse(line) as Request;
          resp = isRequestAuthorized(req, token())
            ? handle(req)
            : { ok: false, error: 'unauthorized' };
        } catch (err) {
          resp = { ok: false, error: (err as Error).message };
        }
        conn.write(JSON.stringify(resp) + '\n');
      }
    });
    conn.on('error', () => { /* client vanished mid-request; ignore */ });
  };
}

/**
 * Whether a live process still owns the broker pid file. A single missed ping
 * isn't proof of death: the single-threaded broker can blow the ping budget
 * while healthy. The pid file is the second liveness signal that makes reclaim
 * safe.
 */
/** Drop our ownership record only if it is still ours. */
export function releaseBrokerPid(): void {
  try {
    if (parseInt(fs.readFileSync(ownerPath(), 'utf-8').trim(), 10) === process.pid) {
      fs.unlinkSync(ownerPath());
    }
  } catch { /* absent or unreadable — nothing to release */ }
}

export function brokerPidAlive(): boolean {
  try {
    const holder = parseInt(fs.readFileSync(ownerPath(), 'utf-8').trim(), 10);
    return !isNaN(holder) && holder !== process.pid && isAlive(holder);
  } catch {
    return false; // no pid file → nothing claims ownership
  }
}

/**
 * Bind the shared broker socket without stealing it from a live owner. Uses
 * retries plus pid-file liveness, not a single ping, to decide "unreachable".
 */
async function bindBrokerSocket(
  sock: string,
  onConnection: BrokerConnectionHandler,
): Promise<net.Server | null> {
  const listenOnce = (): Promise<net.Server | 'inuse'> =>
    new Promise((resolve, reject) => {
      const server = net.createServer(onConnection);
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') resolve('inuse');
        else reject(err);
      };
      server.once('error', onError);
      server.listen(sock, () => {
        try { fs.chmodSync(sock, 0o600); } catch { /* dir 0700 already gates it */ }
        // Mint the token and record ownership only once we are the confirmed owner.
        try { writeAgentToken(); } catch { /* dir 0700 gates the socket regardless */ }
        try { fs.writeFileSync(ownerPath(), String(process.pid)); } catch { /* dir 0700 gates it */ }
        resolve(server);
      });
    });

  let bound = await listenOnce();
  if (bound !== 'inuse') return bound;

  // Give a busy owner several chances before concluding it is gone.
  for (let attempt = 0; attempt < BIND_PROBE_ATTEMPTS; attempt++) {
    if ((await agentPing()).reachable) return null;
    if (attempt < BIND_PROBE_ATTEMPTS - 1) await delay(BIND_PROBE_INTERVAL_MS);
  }
  // Refuse to steal from a process that still owns the pid file.
  if (brokerPidAlive()) {
    throw new Error(
      `Secrets broker socket is held by a live process that is not answering: ${sock}. ` +
      `Run 'agents secrets lock --all' then retry, or stop the stuck broker.`,
    );
  }

  try { fs.unlinkSync(sock); } catch { /* disappeared between probe and reclaim */ }
  bound = await listenOnce();
  if (bound !== 'inuse') return bound;
  if ((await agentPing()).reachable) return null;
  throw new Error(`Secrets broker socket is in use but unreachable: ${sock}`);
}

/**
 * Run the standalone broker in the foreground. Spawned by ensureAgentRunning via
 * `agents secrets _agent-run`. Serves the socket, sweeps expired entries, wipes
 * on sleep, and self-exits when idle.
 */
export async function runSecretsAgent(
  opts: { service?: boolean } = {},
): Promise<{ close(): void | Promise<void> } | null> {
  if (!onDarwin()) return null; // nothing to broker without biometry prompts
  // Persistent launchd service must never idle-exit; launchd would cold-start again.
  const persistent = opts.service === true;

  // O_EXCL single-instance guard.
  const pidFile = pidPath();
  try {
    const fd = fs.openSync(pidFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      const holder = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(holder) && isAlive(holder)) return null; // another broker is live
      // Stale pid — reclaim it.
      try { fs.unlinkSync(pidFile); } catch { /* race; fall through */ }
      fs.writeFileSync(pidFile, String(process.pid));
    } else {
      throw err;
    }
  }

  const store = rehydrateStore();
  // Track when the store last held something so idle brokers exit.
  let emptySince = Date.now();
  const sock = socketPath();

  const releasePid = () => {
    try {
      if (parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10) === process.pid) {
        fs.unlinkSync(pidFile);
      }
    } catch { /* gone or no longer ours */ }
  };

  // Register lifecycle handlers before socket arbitration so a standby service
  // still releases its pid-file lease on kickstart/bootout.
  let standbyTimer: NodeJS.Timeout | null = null;
  let cleanupActive: (() => void) | null = null;
  let shuttingDown = false;
  const onSigterm = () => shutdown(0);
  const onSigint = () => shutdown(0);
  const detachSignals = () => {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
  };
  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (standbyTimer) {
      clearTimeout(standbyTimer);
      standbyTimer = null;
    }
    if (cleanupActive) cleanupActive();
    else releasePid();
    process.exit(code);
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  // Capture the running version so the sweep can self-heal onto upgraded code.
  const runningVersion = getCliVersion();

  // "Warmth" for self-heal / idle-exit counts only real unlocked bundles, NOT
  // the internal `secrets list` metadata cache (#524). Otherwise a 7d-TTL list
  // cache would keep the store non-empty and (a) block the persistent broker
  // from self-healing onto a freshly-installed version for up to a week (#435's
  // gate is size===0), and (b) stop a one-off broker from ever idle-exiting. The
  // metadata cache is a disposable list snapshot — wiping it on upgrade/idle
  // costs at most one extra prompt on the next `secrets list`.
  const sweep = () => {
    const now = Date.now();
    for (const [name, e] of store) if (now >= e.expiresAt) {
      store.delete(name);
      if (e.lease) {
        deleteLeaseSession(e.lease.id);
        emitSecretAudit({ event: 'secrets.lease-expire', bundle: e.bundle.name, operation: 'lease-expire', source: 'broker', status: 'success', keys: e.lease.keys, keyCount: e.lease.keys.length, agent: e.lease.harness });
      }
    }
    const live = realBundleCount(store);
    // Self-heal only while no real unlocks are held (#435).
    if (live === 0 &&
        shouldSelfHealForUpgrade(persistent, live, runningVersion, getCliVersionFresh())) {
      shutdown(0);
      return;
    }
    if (live === 0) {
      if (!persistent && now - emptySince >= IDLE_EXIT_MS) shutdown(0);
    } else {
      emptySince = now;
    }
  };

  const evictedAt = new Map<string, number>();
  const handle = (req: Request): Response => {
    const resp = handleAgentRequest(store, req, Date.now(), evictedAt);
    if (realBundleCount(store) > 0) emptySince = Date.now();
    return resp;
  };

  const onConnection = makeConnectionHandler(handle, readAgentToken);

  let server: net.Server | null = null;
  do {
    try {
      server = await bindBrokerSocket(sock, onConnection);
    } catch (err) {
      detachSignals();
      releasePid();
      throw err;
    }
    if (!server && persistent) {
      // Stay quiescent rather than returning, or launchd KeepAlive would restart-loop.
      do {
        await new Promise<void>((resolve) => {
          standbyTimer = setTimeout(() => {
            standbyTimer = null;
            resolve();
          }, 1000);
        });
      } while ((await agentPing()).reachable);
    }
  } while (!server && persistent);
  if (!server) {
    detachSignals();
    releasePid();
    return null;
  }

  let watcher: ChildProcess | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  // Sync cleanup for signal-driven exit: can't await 'close', so fire-and-forget.
  cleanupActive = () => {
    store.clear();
    if (sweepTimer) clearInterval(sweepTimer);
    try { watcher?.kill(); } catch { /* already gone */ }
    try { server.close(); } catch { /* not listening */ }
    try { fs.unlinkSync(sock); } catch { /* gone */ }
    releaseBrokerPid();
    releasePid();
  };

  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);

  // Auto-lock on sleep. Wipe on SLEEP; screen-lock alone survives. If the helper
  // predates watch-lock, fall back to TTL-only.
  try {
    watcher = spawn(getKeychainHelperPath(), ['watch-lock'], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout?.setEncoding('utf-8');
    watcher.stdout?.on('data', (chunk: string) => {
      if (shouldWipeOnWatchEvent(chunk)) {
        store.clear();
        emptySince = Date.now();
        // Default (non-durable) sessions re-lock on sleep; durable ones survive.
        pruneSessionsOnSleep();
      }
    });
    watcher.on('error', () => { watcher = null; });
  } catch {
    watcher = null;
  }

  return {
    async close() {
      if (shuttingDown) return;
      shuttingDown = true;
      detachSignals();
      store.clear();
      if (sweepTimer) clearInterval(sweepTimer);
      try { watcher?.kill(); } catch { /* already gone */ }
      await closeServerBounded(server);
      try { fs.unlinkSync(sock); } catch { /* gone */ }
      releaseBrokerPid();
      releasePid();
    },
  };
}

/**
 * Host the secrets broker inside the always-on daemon (#416). Serves the same
 * socket/protocol as the standalone broker, but daemon-safe: no pid-file guard,
 * no process.exit/SIG handlers, no self-heal/idle-exit (the daemon owns the
 * lifecycle). Returns null off-darwin.
 */
export async function startHostedBroker(): Promise<{ close(): void | Promise<void> } | null> {
  if (!onDarwin()) return null; // nothing to broker without biometry prompts

  const store = rehydrateStore();
  const sock = socketPath();

  const evictedAt = new Map<string, number>();
  const handle = (req: Request): Response => handleAgentRequest(store, req, Date.now(), evictedAt);
  const onConn = makeConnectionHandler(handle, readAgentToken);

  const server = await bindBrokerSocket(sock, onConn);
  if (!server) return null;

  // TTL eviction only. The daemon is always-on and owns its own lifecycle.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [name, e] of store) {
      if (now < e.expiresAt) continue;
      store.delete(name);
      if (e.lease) {
        deleteLeaseSession(e.lease.id);
        emitSecretAudit({ event: 'secrets.lease-expire', bundle: e.bundle.name, operation: 'lease-expire', source: 'broker', status: 'success', keys: e.lease.keys, keyCount: e.lease.keys.length, agent: e.lease.harness });
      }
    }
  }, SWEEP_INTERVAL_MS);

  // Auto-lock on sleep, same as the standalone broker.
  let watcher: ChildProcess | null = null;
  try {
    watcher = spawn(getKeychainHelperPath(), ['watch-lock'], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout?.setEncoding('utf-8');
    watcher.stdout?.on('data', (chunk: string) => {
      if (shouldWipeOnWatchEvent(chunk)) {
        store.clear();
        pruneSessionsOnSleep();
      }
    });
    watcher.on('error', () => { watcher = null; });
  } catch {
    watcher = null;
  }

  return {
    async close() {
      store.clear();
      clearInterval(sweepTimer);
      try { watcher?.kill(); } catch { /* already gone */ }
      await closeServerBounded(server);
      try { fs.unlinkSync(sock); } catch { /* gone */ }
      releaseBrokerPid();
    },
  };
}

/** How long to wait for net.Server.close()'s 'close' event before giving up. */
const SERVER_CLOSE_TIMEOUT_MS = 2_000;

/**
 * Wait for net.Server.close()'s 'close' event (or a bounded timeout) so a
 * successor bind doesn't race a half-closed socket (RUSH-2421).
 */
export function closeServerBounded(
  server: net.Server,
  timeoutMs: number = SERVER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      server.close(() => finish());
    } catch {
      // Already closed / not listening — treat as released.
      finish();
    }
  });
}

// ─── Client ──────────────────────────────────────────────────────────────────

/** Open the socket, send one request, resolve the one response. Async path. */
function request(req: Request, timeoutMs = 2000): Promise<Response | null> {
  // Attach the capability token to every command except ping.
  const authedReq: Request = req.cmd === 'ping' ? req : { ...req, token: readAgentToken() ?? undefined };
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath());
    let buf = '';
    let done = false;
    const finish = (r: Response | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.destroy(); } catch { /* already closed */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    conn.on('error', () => finish(null));
    conn.on('connect', () => conn.write(JSON.stringify(authedReq) + '\n'));
    conn.setEncoding('utf-8');
    conn.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try { finish(JSON.parse(buf.slice(0, nl)) as Response); }
      catch { finish(null); }
    });
  });
}

/** Cheap socket-existence check so the never-unlocked path stays a single stat. */
export function agentSocketExists(): boolean {
  return onDarwin() && fs.existsSync(socketPath());
}

/**
 * Spawn one of the `__secrets-*` sync clients via `getCliLaunch`. The old
 * `process.execPath -e` pattern broke on the bun-compiled Mach-O binary
 * (1.20.53); routing through getCliLaunch fixes both install shapes. The
 * subcommands are intercepted in index.ts before commander/startup so a cache
 * hit doesn't fork detached syncs or run update checks.
 */
export function syncClientLaunch(sub: string[], agentsBin?: string): { command: string; args: string[] } {
  return agentsBin ? getCliLaunch(sub, agentsBin) : getCliLaunch(sub);
}

function syncClient(sub: string[], timeout: number): SpawnSyncReturns<string> | null {
  // Soft on every failure: the fast path must fall through to the real keychain
  // read. getCliLaunch can throw on broken installs; crashing there turns a
  // graceful fallback into a failure at the worst time.
  try {
    const { command, args } = syncClientLaunch(sub);
    return spawnSync(command, args, { encoding: 'utf-8', timeout });
  } catch {
    return null;
  }
}

/**
 * Synchronous read for the hot path. Returns null on any failure so the caller
 * falls through to the real keychain. macOS only.
 */
export function agentGetSync(name: string, harness: string = GLOBAL_HARNESS): { bundle: SecretsBundle; env: Record<string, string>; lease?: SecretLease } | null {
  if (!isSecretsBrokerEnabled()) return null;
  if (!agentSocketExists()) return null;
  const r = syncClient([SYNC_GET_CMD, name, harness], SYNC_GET_TIMEOUT_MS);
  if (!r || r.status !== 0 || !r.stdout) return null;
  try {
    const o = JSON.parse(lastLine(r.stdout)) as { bundle: SecretsBundle; env: Record<string, string>; lease?: SecretLease };
    if (!o || typeof o !== 'object' || !o.env) return null;
    return { bundle: o.bundle, env: o.env, lease: o.lease };
  } catch {
    return null;
  }
}

/**
 * Last non-empty line of a child's stdout — the payload line. Anchors on the
 * terminator so any future CLI startup chatter on stdout doesn't break JSON.parse
 * and silently turn cache hits into misses.
 */
export function lastLine(stdout: string): string {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return '';
}

/**
 * Synchronous liveness check: is a broker actually listening? Gates the
 * synchronous warm path so a stale socket doesn't drag a foreground read
 * through a cold-start. macOS only.
 */
export function agentReachableSync(): boolean {
  if (!onDarwin()) return false;
  if (!agentSocketExists()) return false;
  const r = syncClient([SYNC_PING_CMD], SYNC_PING_TIMEOUT_MS);
  return r !== null && r.status === 0 && !r.error;
}

/**
 * Synchronously evict one bundle after a mutating write so the broker doesn't
 * serve a stale snapshot for the hold window. Best-effort silent no-op. macOS only.
 */
export function agentEvictSync(name: string): void {
  if (!onDarwin()) return;
  if (!agentSocketExists()) return;
  // No try/catch: syncClient swallows its own failures and returns null.
  syncClient([SYNC_LOCK_CMD, name], SYNC_LOCK_TIMEOUT_MS);
}

// ─── Top-level `__secrets-*` sync-client entrypoints ────────────────────────
// Dispatched from index.ts before commander/startup so cache hits stay cheap.

/** Body of `__secrets-get <name>`. Exit 0 = hit, 3 = miss/down. */
export async function runAgentGetSync(name: string, harness: string = GLOBAL_HARNESS): Promise<number> {
  const r = await request({ cmd: 'get', name, harness }, SOCKET_GET_TIMEOUT_MS);
  if (r?.ok === true && r.cmd === 'get' && r.hit) {
    // Terminate with a newline and await the write callback; an unflushed pipe
    // write would be truncated on exit and cost a Touch ID prompt.
    const payload = JSON.stringify({ bundle: r.bundle, env: r.env, lease: r.lease }) + '\n';
    await new Promise<void>((resolve) => { process.stdout.write(payload, () => resolve()); });
    return 0;
  }
  return 3;
}

/** Body of `__secrets-ping`. Exit 0 = listening broker, 3 = nothing there.
 * Does not gate on PROTOCOL_VERSION so version-skewed brokers still answer reads. */
export async function runAgentPingSync(): Promise<number> {
  const r = await request({ cmd: 'ping' }, SOCKET_PING_TIMEOUT_MS);
  return r?.ok === true && r.cmd === 'ping' ? 0 : 3;
}

/** Body of `__secrets-lock <name>`. Best-effort evict; exit 0 even when no
 * broker answers. An empty name is refused to avoid accidentally locking ALL
 * bundles. */
export async function runAgentLockSync(name: string): Promise<number> {
  if (!name) return 3;
  await request({ cmd: 'lock', name }, SOCKET_LOCK_TIMEOUT_MS);
  return 0;
}

// Key inside the cached entry's env that holds the JSON metadata snapshot.
const META_SNAPSHOT_KEY = '__snapshot__';

/**
 * Read the cached `secrets list` metadata snapshot for a keychain name-set hash.
 * Reuses agentGetSync. The name-set hash is the cache key, so add/remove/rename
 * yields a clean miss.
 */
export function agentGetMetaSync(nameSetHash: string): SecretsBundle[] | null {
  if (!onDarwin()) return null;
  const hit = agentGetSync(META_CACHE_PREFIX + nameSetHash);
  const raw = hit?.env?.[META_SNAPSHOT_KEY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SecretsBundle[]) : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: populate the broker with a metadata snapshot so the next
 * `secrets list` within the hold window is prompt-free. Stored under a reserved
 * META_CACHE_PREFIX key; snapshot travels over stdin. macOS only.
 */
export function agentAutoLoadMetaSync(nameSetHash: string, bundles: SecretsBundle[], ttlMs: number): void {
  if (!onDarwin()) return;
  const key = META_CACHE_PREFIX + nameSetHash;
  const placeholder: SecretsBundle = { name: key, vars: {} };
  agentAutoLoadSync(key, placeholder, { [META_SNAPSHOT_KEY]: JSON.stringify(bundles) }, ttlMs);
}

/** True unless `secrets.agent.auto` is explicitly disabled in agents.yaml. The
 * broker is the mechanism that delivers the `daily` default policy (one Touch ID
 * per ~7d), so auto-caching is ON by default; opt out with
 * `secrets.agent.auto: false`. Best-effort; an unreadable meta reads as on. */
export function secretsAgentAutoEnabled(): boolean {
  try {
    return readMeta().secrets?.agent?.auto !== false;
  } catch {
    return true;
  }
}

/** Default `sleepPersist` for a new unlock when `--durable` is not passed. OFF by
 * default (the secure split default: survive restart, re-lock on sleep); set
 * `secrets.agent.durable: true` in agents.yaml to make every unlock sleep-durable.
 * Best-effort; an unreadable meta reads as off. */
export function secretsAgentDurable(): boolean {
  try {
    return readMeta().secrets?.agent?.durable === true;
  } catch {
    return false;
  }
}

/** Minimum / maximum bounds for the configurable hold window. A too-small value
 * would defeat the broker (constant re-prompts); a too-large one pins secrets in
 * memory far longer than intended. */
export const MIN_HOLD_MS = MIN_LEASE_MS;
export const MAX_HOLD_MS = MAX_LEASE_MS;

/**
 * How long an unlocked / auto-cached bundle is held before the next read
 * re-prompts. Defaults to DEFAULT_TTL_MS (7d); override with
 * `secrets.agent.holdMs` (milliseconds) in agents.yaml — e.g. 86400000 for a 24h
 * cap. Clamped to [MIN_HOLD_MS, MAX_HOLD_MS] so a typo can neither disable the
 * hold nor pin a secret in memory indefinitely. Best-effort: an unreadable or
 * non-numeric value falls back to the 7d default. Pure except for the meta read.
 */
export function secretsHoldMs(): number {
  try {
    return clampHoldMs(readMeta().secrets?.agent?.holdMs);
  } catch {
    return DEFAULT_TTL_MS;
  }
}

/** Pure clamp for a configured `holdMs`: a positive finite number is bounded to
 * [MIN_HOLD_MS, MAX_HOLD_MS]; anything else (absent, 0, negative, NaN, non-number)
 * falls back to the 7d default. Exported for direct unit testing. */
export function clampHoldMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return Math.min(Math.max(Math.floor(v), MIN_HOLD_MS), MAX_HOLD_MS);
  }
  return DEFAULT_TTL_MS;
}

/**
 * Fire-and-forget: populate the broker with a freshly-resolved bundle so the
 * NEXT process reads it without a prompt. Used by the auto-cache path after a
 * real keychain read of a `daily`-policy bundle, so the NEXT concurrent read is
 * silent. Env travels over stdin, never argv.
 *
 * Reliability (this is what makes `daily` actually "stick"): when a broker is
 * ALREADY listening, warm it SYNCHRONOUSLY with a bounded wait so the bundle is
 * held by the time this process exits. The old detached-only path lost the race
 * under load — a short-lived reader (`agents secrets export`, a release-script
 * loop) exited before the unref'd worker connected, so the cache silently never
 * populated and every read re-prompted despite the `daily` policy. Only when the
 * broker must COLD-START (no socket yet) do we fall back to the detached worker,
 * so a first-ever read never blocks on a multi-second broker boot.
 *
 * The worker reuses the robust `ensureAgentRunning` path (spawn-then-ping) rather
 * than a tight inline retry loop. Best-effort; never throws. macOS only.
 */
export function agentAutoLoadSync(
  name: string,
  bundle: SecretsBundle,
  env: Record<string, string>,
  ttlMs: number,
  harness: string = GLOBAL_HARNESS,
  lease?: SecretLease,
  // When the caller read the bundle from the keychain — lets the broker
  // reject this load if an eviction lands in between (tombstones, above).
  snapshotAt?: number,
): void {
  if (!onDarwin()) return;
  if (!isSecretsBrokerEnabled()) return;
  const payload = JSON.stringify({ name, bundle, env, ttlMs, harness, lease, snapshotAt });
  // Broker actually LISTENING → deterministic synchronous warm (bounded; the read
  // already paid a Touch ID, so <1s here is invisible). We gate on a real liveness
  // ping, NOT mere socket-file existence: a broker that died leaving its socket
  // behind (crash, OOM, or the version-skew teardown in this file) would otherwise
  // drag this FOREGROUND read through the worker's 20s cold-start budget on every
  // read. A dead/stale socket fails the ping fast, so we drop straight to the
  // detached path (which does the cold-start + stale-socket cleanup off the hot
  // path) — restoring "a dead broker costs the foreground read nothing".
  if (agentReachableSync()) {
    try {
      const { cmd, args } = cliSpawn(['secrets', '_agent-load']);
      const r = spawnSync(cmd, args, { input: payload, timeout: 3000, stdio: ['pipe', 'ignore', 'ignore'] });
      if (!r.error && r.status === 0) return;
    } catch {
      // fall through to the detached best-effort path
    }
  }
  try {
    const { cmd, args } = cliSpawn(['secrets', '_agent-load']);
    const worker = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    worker.stdin?.write(payload);
    worker.stdin?.end();
    worker.unref();
  } catch {
    // best-effort: the next read just pops Touch ID as it would today
  }
}

/**
 * Body of the hidden `secrets _agent-load` worker. Reads one `{name, bundle,
 * env, ttlMs}` payload from stdin, ensures the broker is up (robust, generous
 * budget), and loads the bundle into it.
 *
 * Exit code is load-truthful: 0 ONLY when the bundle was actually loaded into a
 * reachable broker; non-zero on any failure (malformed payload, broker couldn't
 * be brought up, or the load transport failed). The synchronous caller
 * (agentAutoLoadSync) relies on this to decide whether to skip the detached
 * fallback — a bare "process exited 0" would otherwise be a false-positive
 * success that silently reintroduces the very re-prompt storm this path fixes.
 */
export async function runAgentLoadFromStdin(): Promise<void> {
  if (!onDarwin()) return;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let payload: { name?: string; bundle?: SecretsBundle; env?: Record<string, string>; ttlMs?: number; harness?: string; lease?: SecretLease; snapshotAt?: number };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    process.exitCode = 1; // malformed payload — nothing loaded
    return;
  }
  if (!payload || !payload.name || !payload.bundle || !payload.env) {
    process.exitCode = 1;
    return;
  }
  // Generous budget: the broker is a cold-starting full CLI; under load it can
  // take several seconds to bind. We're detached, so waiting costs nothing.
  if (!(await ensureAgentRunning(20000))) {
    process.exitCode = 1; // broker couldn't be brought up — did NOT load
    return;
  }
  const loaded = await agentLoad(payload.name, payload.bundle, payload.env, payload.ttlMs ?? DEFAULT_TTL_MS, payload.harness ?? GLOBAL_HARNESS, payload.lease, payload.snapshotAt);
  if (!loaded) process.exitCode = 1; // transport failed — did NOT load
}

/** Store a resolved bundle in the broker. Returns false on transport failure. */
export async function agentLoad(
  name: string,
  bundle: SecretsBundle,
  env: Record<string, string>,
  ttlMs: number,
  harness: string = GLOBAL_HARNESS,
  lease?: SecretLease,
  snapshotAt?: number,
): Promise<boolean> {
  const r = await request({ cmd: 'load', name, bundle, env, ttlMs, harness, lease, snapshotAt });
  return r?.ok === true && r.cmd === 'load';
}

/** Wipe one bundle (or all if name omitted) from the broker. Returns the count
 * wiped, or 0 when no broker is running. */
export async function agentLock(name?: string): Promise<number> {
  const r = await request({ cmd: 'lock', name });
  return r?.ok === true && r.cmd === 'lock' ? r.wiped : 0;
}

/** List currently-unlocked bundles, or [] when no broker is running. The
 * internal `secrets list` metadata-cache entry is filtered out here as well as
 * server-side: during a rollout a NEW client can talk to an OLD broker that
 * predates the server-side exclusion, so this keeps the internal entry from
 * surfacing in `agents secrets status` in that skew window. */
export async function agentStatus(): Promise<AgentStatusEntry[]> {
  const r = await request({ cmd: 'status' });
  const entries = r?.ok === true && r.cmd === 'status' ? r.entries : [];
  return entries.filter((e) => !e.name.startsWith(META_CACHE_PREFIX));
}

/** Ping result: whether a broker is reachable + speaking our protocol, and the
 * version of the code it's running (for staleness detection). */
export async function agentPing(): Promise<{ reachable: boolean; cliVersion?: string }> {
  if (!agentSocketExists()) return { reachable: false };
  const r = await request({ cmd: 'ping' });
  if (r?.ok === true && r.cmd === 'ping' && r.version === PROTOCOL_VERSION) {
    return { reachable: true, cliVersion: r.cliVersion };
  }
  return { reachable: false };
}

/**
 * Ensure a broker is running and reachable. Returns true once the socket answers
 * a ping. macOS only.
 *
 * Prefers the always-on daemon, which hosts the broker socket (#416): retire any
 * legacy standalone launchd service so the daemon owns the socket, then bring the
 * daemon up (Path 0) — one supervised backbone that survives the whole login
 * session, so subsequent reads never cold-start. Only when the daemon can't be
 * used do we fall back to a one-off detached broker (Path 1) — the model that
 * gets starved under heavy load, so it's last.
 */
export async function ensureAgentRunning(timeoutMs = 5000): Promise<boolean> {
  if (!onDarwin()) return false;
  if (!isSecretsBrokerEnabled()) return false;

  // Self-heal: if a broker is reachable but running pre-upgrade code (its
  // reported version != the version on disk now), tear it down so the paths
  // below bring up a fresh one on current code. A current, reachable broker is
  // accepted immediately — and so is a version-skewed one that still holds
  // real unlocks (see shouldTeardownVersionSkewedBroker: wiping a hot cache
  // re-prompts Touch ID for every held bundle).
  const ping = await agentPing();
  if (ping.reachable) {
    if (ping.cliVersion === undefined || ping.cliVersion === getCliVersionFresh()) return true;
    // A reachable but version-skewed broker: tear it down ONLY when no daemon
    // hosts it and it holds no unlocks. Evicting a daemon-hosted broker orphans
    // the daemon's socket and starts the Touch ID storm — see
    // shouldClientEvictSkewedBroker.
    const { isDaemonRunning } = await import('../daemon/daemon.js');
    if (!shouldClientEvictSkewedBroker(isDaemonRunning(), (await agentStatus()).length)) return true;
    await teardownStaleBroker();
  }

  // A legacy standalone secrets-agent service may still be installed from an
  // older version. Retire it (#416 step 2) so the always-on daemon owns the
  // broker socket rather than racing a launchd job for it. No-op when no legacy
  // plist is present. We only reach here when nothing is already reachable, so
  // retiring never disrupts a warm broker.
  retireLegacySecretsAgentService();

  // Path 0 (#416): the always-on daemon hosts the broker socket — one supervised
  // backbone rather than a separate launchd service. If bringing the daemon up
  // makes the broker answer, we're done.
  try {
    const { ensureDaemonStarted } = await import('../daemon/daemon.js');
    if (ensureDaemonStarted()) {
      const d0 = Date.now() + timeoutMs;
      while (Date.now() < d0) {
        if ((await agentPing()).reachable) return true;
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  } catch { /* daemon path unavailable — fall through to the one-off spawn */ }

  // Path 1 (fallback): one-off detached broker when the daemon can't host it.
  // Clear a stale socket/pid first.
  const stalePid = (() => {
    try { return parseInt(fs.readFileSync(pidPath(), 'utf-8').trim(), 10); }
    catch { return NaN; }
  })();
  if (!isNaN(stalePid) && isAlive(stalePid)) {
    try { process.kill(stalePid, 'SIGTERM'); } catch { /* already dead */ }
    // Wait for it to actually go before clearing its socket and ownership
    // record. Unlinking them under a live broker is what leaves an orphan
    // holding every unlocked bundle in RAM with no way to reach it — and it also
    // destroys the very record brokerPidAlive() reads, so the successor sees an
    // ownerless socket and reclaims it regardless.
    waitForExit(stalePid, BROKER_STOP_GRACE_MS);
  }
  try { fs.unlinkSync(socketPath()); } catch { /* gone */ }
  try { fs.unlinkSync(pidPath()); } catch { /* gone */ }
  try { fs.unlinkSync(ownerPath()); } catch { /* gone */ }

  const { cmd, args } = brokerSpawn();
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await agentPing()).reachable) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Tear down a stale broker (running pre-upgrade code) so a fresh one can take
 * over. Retire any legacy standalone service first (#416 step 2) so the daemon —
 * not the old launchd job — hosts the fresh broker, then kill the process and
 * clear its socket/pid. The caller then brings the daemon-hosted broker up.
 */
async function teardownStaleBroker(): Promise<void> {
  retireLegacySecretsAgentService();
  const pid = (() => { try { return parseInt(fs.readFileSync(pidPath(), 'utf-8').trim(), 10); } catch { return NaN; } })();
  if (!isNaN(pid) && isAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    waitForExit(pid, BROKER_STOP_GRACE_MS); // same reason as ensureAgentRunning
  }
  try { fs.unlinkSync(socketPath()); } catch { /* gone */ }
  try { fs.unlinkSync(pidPath()); } catch { /* gone */ }
  try { fs.unlinkSync(ownerPath()); } catch { /* gone */ }
}
