/**
 * The secrets-agent: a local broker that holds resolved bundle env in memory
 * after a single Touch ID unlock, so concurrent agent processes don't each pop
 * their own prompt.
 *
 * Why this exists: every secret item carries a biometry access control, and
 * macOS refuses to cache that across processes — N concurrent `agents run`
 * spawns = N Touch ID prompts (see src/lib/secrets/bundles.ts). The Swift
 * helper's LAContext only deduplicates reads *within one process*. This broker
 * is the ssh-agent answer: `agents secrets unlock <bundle>` decrypts the bundle
 * once (one prompt), ships the resolved env here, and every later read returns
 * from memory over a user-only Unix socket — no prompt.
 *
 * Security model (deliberate): while a bundle is unlocked, any same-user
 * process that can reach the socket reads it silently. That's strictly the same
 * trust boundary the keychain already concedes (docs/secrets.md: the ACL is
 * user-presence, not code-identity — any same-user process can pop the prompt
 * and read), minus the visible prompt. We bound it with: explicit per-bundle
 * opt-in (nothing is held unless you `unlock` it), an absolute TTL (~7d), an
 * auto-wipe on sleep / logout, and `agents secrets lock`. A bare screen-lock is
 * NOT a wipe (the login password already gates it). Nothing ever touches disk.
 *
 * macOS only: Linux libsecret has no biometry prompt, so there's nothing to
 * deduplicate — every entry point here no-ops off darwin.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import { getHelpersDir, readMeta } from '../state.js';
import { isAlive } from '../platform/process.js';
import { getKeychainHelperPath } from './install-helper.js';
import { getCliVersion, getCliVersionFresh } from '../version.js';
import type { SecretsBundle } from './bundles.js';

/** Bumped when the wire protocol changes; a client that pings a mismatched
 * server kills and respawns it rather than talking a stale dialect. */
const PROTOCOL_VERSION = 1;

/** Default lifetime of an unlocked bundle when `--ttl` is not given. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

/**
 * Reserved store-key prefix for the `secrets list` metadata snapshot cache.
 * The broker holds the resolved bundle-metadata array (names/policy/timestamps,
 * NO resolved secret values beyond the literals already in metadata) keyed by a
 * hash of the current keychain bundle name-set, so the second and later
 * `secrets list` within the hold window read metadata without a Touch ID
 * prompt. Keyed by the name-set hash so adding/removing/renaming a bundle
 * changes the key and misses the cache automatically — no active invalidation.
 * The '!' sentinel can never collide with a real bundle name
 * (BUNDLE_NAME_PATTERN requires an alphanumeric first char) and is safe as
 * spawnSync argv (unlike a NUL byte); `status` hides these entries.
 */
export const META_CACHE_PREFIX = '!meta:';

/** After the store goes empty (all bundles locked or expired) for this long,
 * the broker exits so no idle process lingers holding a socket. */
const IDLE_EXIT_MS = 5 * 60 * 1000; // 5m

/** How often the broker sweeps expired entries. */
const SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * Decide whether a persistent broker should self-heal onto freshly-installed
 * code (exit so launchd relaunches it). Only when the store is EMPTY: exiting
 * with bundles still unlocked wipes them from memory, so the next reader falls
 * back to a direct keychain read and re-prompts for Touch ID. Deferring the
 * restart until the cache is idle (TTL-expired / slept) means an
 * in-place `npm i -g` never wipes a hot cache — the new code is adopted at the
 * next quiet moment instead. See #435: rapid repeated upgrades wiped a hot
 * cache on every bump and produced a recurring Touch ID storm.
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
 * Client-side twin of shouldSelfHealForUpgrade: whether ensureAgentRunning may
 * tear down a reachable broker whose running version differs from the client's
 * on-disk version. Only while it holds NO real unlocks — tearing down a hot
 * broker wipes every held bundle, so the next read of each one re-prompts for
 * Touch ID. On a machine where installed versions churn (dev builds stamp a
 * fresh 0.0.0-dev.<sha> on every install; an npm copy and a dev copy invoke in
 * turn), an unguarded teardown produced a rolling Touch ID storm — the exact
 * failure #435 fixed on the server side. A hot, protocol-compatible broker
 * keeps serving; its own sweep adopts the new code at the next quiet moment.
 */
export function shouldTeardownVersionSkewedBroker(realHeldBundles: number): boolean {
  return realHeldBundles === 0;
}

export interface StoredBundle {
  bundle: SecretsBundle;
  env: Record<string, string>;
  /** epoch ms; the entry is gone once Date.now() passes this. */
  expiresAt: number;
}

/** One unlocked bundle as reported by `status`. */
export interface AgentStatusEntry {
  name: string;
  expiresAt: number;
  keyCount: number;
}

function onDarwin(): boolean {
  return process.platform === 'darwin';
}

/** Broker runtime dir under the regenerable cache, locked to the user (0700).
 * AGENTS_SECRETS_AGENT_DIR overrides the location — a test seam so the suite can
 * run a real broker on a temp socket without touching the user's real dir. */
function agentDir(): string {
  const dir = process.env.AGENTS_SECRETS_AGENT_DIR || path.join(getHelpersDir(), 'secrets-agent');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

function socketPath(): string {
  return path.join(agentDir(), 'agent.sock');
}

function pidPath(): string {
  return path.join(agentDir(), 'agent.pid');
}

/**
 * Argv for re-invoking THIS cli with a hidden subcommand, so a side-by-side dev
 * build spawns its own helpers rather than the registry-installed one. We always
 * go through `process.execPath` (the node binary) with the JS entrypoint as the
 * first arg — the entrypoint isn't reliably executable in dev builds (invoked as
 * `node dist/index.js`, no +x), so spawning it directly EACCES'd.
 */
function cliSpawn(sub: string[]): { cmd: string; args: string[] } {
  const argv1 = process.argv[1];
  const entry = argv1 && fs.existsSync(argv1) ? argv1 : null;
  if (entry) return { cmd: process.execPath, args: [entry, ...sub] };
  // No resolvable entrypoint (unusual) — fall back to the PATH shim.
  let bin = 'agents';
  try { bin = execFileSync('which', ['agents'], { encoding: 'utf-8' }).trim(); } catch { /* default */ }
  return { cmd: bin, args: sub };
}

function brokerSpawn(): { cmd: string; args: string[] } {
  return cliSpawn(['secrets', '_agent-run']);
}

// ─── Legacy standalone launchd service (retired, #416 step 2) ────────────────
// Earlier versions ran the broker as its own launchd user service
// (com.phnx-labs.agents-secrets-agent, shipped in 1.20.20) so a heavily-loaded
// machine couldn't starve an on-demand cold start. That role now belongs to the
// always-on daemon, which hosts the broker socket-first (#416 step 1) — one
// supervised backbone instead of a second service. The functions below no
// longer INSTALL the standalone service; they only DETECT and RETIRE a plist
// left by an older version so the daemon can take over the socket. The upgrade
// migration (postinstall) and `ensureAgentRunning` both drive the retire path.

const SERVICE_LABEL = 'com.phnx-labs.agents-secrets-agent';

// LaunchAgents dir is relocatable for tests via AGENTS_SECRETS_LAUNCHAGENTS_DIR.
// A relocated dir is NOT launchd-managed (launchd only bootstraps plists from
// the real ~/Library/LaunchAgents), so retirement there is a pure file removal.
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
 * Retire the legacy standalone secrets-agent launchd service: bootout the job
 * (falling back to the legacy `unload`) and remove its plist so the always-on
 * daemon owns the broker socket. Idempotent and best-effort — a no-op when no
 * legacy plist is present. Does NOT wipe held bundles: the booted-out process's
 * memory is gone anyway, and the daemon-hosted broker starts fresh.
 */
export function retireLegacySecretsAgentService(): void {
  if (!onDarwin() || !secretsAgentServiceInstalled()) return;
  const plist = servicePlistPath();
  // Only the real LaunchAgents dir is launchd-managed; a relocated (test) dir
  // has no bootstrapped job, so skip launchctl and just remove the plist.
  if (!process.env.AGENTS_SECRETS_LAUNCHAGENTS_DIR) {
    const uid = process.getuid?.() ?? 0;
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: ['ignore', 'ignore', 'ignore'] }); }
    catch { try { execFileSync('launchctl', ['unload', '-w', plist], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* not loaded */ } }
  }
  try { fs.unlinkSync(plist); } catch { /* already gone */ }
}

/**
 * Stop the persistent broker for `agents secrets stop`: wipe whatever the broker
 * holds (forces Touch ID again on the next read), then retire any legacy
 * standalone service. The daemon-hosted broker itself is left running — it is
 * the always-on backbone, and stopping it would take down unrelated background
 * work (routines, browser IPC, session-sync).
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
  | { cmd: 'get'; name: string }
  | { cmd: 'load'; name: string; bundle: SecretsBundle; env: Record<string, string>; ttlMs: number }
  | { cmd: 'lock'; name?: string }
  | { cmd: 'status' };

export type Response =
  | { ok: true; cmd: 'ping'; version: number; cliVersion: string }
  | { ok: true; cmd: 'get'; hit: false }
  | { ok: true; cmd: 'get'; hit: true; bundle: SecretsBundle; env: Record<string, string> }
  | { ok: true; cmd: 'load' }
  | { ok: true; cmd: 'lock'; wiped: number }
  | { ok: true; cmd: 'status'; entries: AgentStatusEntry[] }
  | { ok: false; error: string };

// ─── Broker server (runs in the detached `secrets _agent-run` process) ───────

/**
 * Pure request handler over the in-memory store. Extracted so the store
 * semantics (lazy expiry on get/status, lock-one vs lock-all, load TTL) are
 * unit-testable with a controlled `now`, without a socket or a spawned process.
 * Mutates `store` in place; returns the wire response.
 */
/**
 * Count of real unlocked bundles in the store, excluding the internal
 * `secrets list` metadata cache. Used to decide broker "warmth" for self-heal
 * and idle-exit: a metadata-only store must read as empty so a disposable list
 * cache never blocks an upgrade restart (#435) or an idle one-off broker from
 * exiting. Pure + exported for unit testing.
 */
export function realBundleCount(store: Map<string, StoredBundle>): number {
  let n = 0;
  for (const name of store.keys()) if (!name.startsWith(META_CACHE_PREFIX)) n++;
  return n;
}

export function handleAgentRequest(
  store: Map<string, StoredBundle>,
  req: Request,
  now: number = Date.now(),
): Response {
  switch (req.cmd) {
    case 'ping':
      // Report the version of the code this broker is RUNNING (getCliVersion
      // caches the value from the broker's startup), not the on-disk version.
      // A client compares this to its own fresh on-disk read; a mismatch means
      // the broker is running pre-upgrade code and should be restarted.
      return { ok: true, cmd: 'ping', version: PROTOCOL_VERSION, cliVersion: getCliVersion() };
    case 'get': {
      const e = store.get(req.name);
      if (!e || now >= e.expiresAt) {
        if (e) store.delete(req.name); // drop expired on read
        return { ok: true, cmd: 'get', hit: false };
      }
      return { ok: true, cmd: 'get', hit: true, bundle: e.bundle, env: e.env };
    }
    case 'load':
      store.set(req.name, { bundle: req.bundle, env: req.env, expiresAt: now + req.ttlMs });
      return { ok: true, cmd: 'load' };
    case 'lock': {
      if (req.name) {
        return { ok: true, cmd: 'lock', wiped: store.delete(req.name) ? 1 : 0 };
      }
      const wiped = store.size;
      store.clear();
      return { ok: true, cmd: 'lock', wiped };
    }
    case 'status': {
      const entries: AgentStatusEntry[] = [];
      for (const [name, e] of store) {
        if (now >= e.expiresAt) continue;
        if (name.startsWith(META_CACHE_PREFIX)) continue; // internal list cache, not a user bundle
        entries.push({ name, expiresAt: e.expiresAt, keyCount: Object.keys(e.env).length });
      }
      return { ok: true, cmd: 'status', entries };
    }
  }
}

/**
 * Decide whether a `watch-lock` helper line should wipe the in-memory store.
 * The helper emits `LOCK` on screen-lock / screensaver and `SLEEP` on system
 * sleep. We wipe on SLEEP only: a bare screen-lock is already gated by the login
 * password, and with the ~7d hold, re-authing after every lock would defeat the
 * point. Logout needs no line — it tears down the launchd session and kills the
 * broker outright. Pure + exported so the LOCK-survives / SLEEP-wipes contract
 * has direct regression coverage (the inline stdout handler isn't unit-testable).
 */
export function shouldWipeOnWatchEvent(chunk: string): boolean {
  return /\bSLEEP\b/.test(chunk);
}

type BrokerConnectionHandler = (conn: net.Socket) => void;

/**
 * Bind the shared broker socket without stealing it from another live owner.
 * Both the standalone service and daemon-hosted broker use this single path so
 * either startup order is safe: a reachable owner wins, while an unreachable
 * stale socket is reclaimed once.
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
        resolve(server);
      });
    });

  let bound = await listenOnce();
  if (bound !== 'inuse') return bound;
  if ((await agentPing()).reachable) return null;

  try { fs.unlinkSync(sock); } catch { /* disappeared between probe and reclaim */ }
  bound = await listenOnce();
  if (bound !== 'inuse') return bound;
  if ((await agentPing()).reachable) return null;
  throw new Error(`Secrets broker socket is in use but unreachable: ${sock}`);
}

/**
 * Run the broker in the foreground. Spawned detached by ensureAgentRunning via
 * `agents secrets _agent-run`. Holds the store in memory, serves the socket,
 * sweeps expired entries, wipes on sleep, and self-exits when idle.
 */
export async function runSecretsAgent(
  opts: { service?: boolean } = {},
): Promise<{ close(): void } | null> {
  if (!onDarwin()) return null; // nothing to broker without biometry prompts
  // When launchd keeps us alive as a persistent service, never idle-exit:
  // exiting would just make launchd cold-start us again, reintroducing the
  // startup-under-load fragility the service exists to avoid.
  const persistent = opts.service === true;

  // Single-instance guard: O_EXCL pid file. If a live broker already holds it,
  // exit quietly — the existing one keeps serving.
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

  const store = new Map<string, StoredBundle>();
  // emptySince tracks the last moment the store held something; the sweep exits
  // the process once it's been empty for IDLE_EXIT_MS so no idle broker lingers.
  let emptySince = Date.now();
  const sock = socketPath();

  const releasePid = () => {
    try {
      if (parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10) === process.pid) {
        fs.unlinkSync(pidFile);
      }
    } catch { /* gone or no longer ours */ }
  };

  // Register lifecycle handlers before socket arbitration. A persistent
  // launchd service may spend its whole lifetime as the standby loser, and a
  // kickstart/bootout during that wait must still release its pid-file lease.
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

  // Capture the version of the code we're running so the sweep can detect when
  // an in-place upgrade has landed and self-heal onto it. getCliVersion caches
  // this value for the process lifetime; getCliVersionFresh re-reads on disk.
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
    for (const [name, e] of store) if (now >= e.expiresAt) store.delete(name);
    const live = realBundleCount(store);
    // Self-heal onto a newer in-place install — but ONLY while no real unlocks
    // are held, so we never wipe live unlocks and force a re-prompt (#435). A
    // metadata-only store still self-heals (the list cache is disposable).
    if (live === 0 &&
        shouldSelfHealForUpgrade(persistent, live, runningVersion, getCliVersionFresh())) {
      shutdown(0); // KeepAlive relaunches on the new code
      return;
    }
    if (live === 0) {
      if (!persistent && now - emptySince >= IDLE_EXIT_MS) shutdown(0);
    } else {
      emptySince = now;
    }
  };

  const handle = (req: Request): Response => {
    const resp = handleAgentRequest(store, req);
    if (realBundleCount(store) > 0) emptySince = Date.now();
    return resp;
  };

  const onConnection = (conn: net.Socket) => {
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
          resp = handle(JSON.parse(line) as Request);
        } catch (err) {
          resp = { ok: false, error: (err as Error).message };
        }
        conn.write(JSON.stringify(resp) + '\n');
      }
    });
    conn.on('error', () => { /* client vanished mid-request; ignore */ });
  };

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
      // launchd KeepAlive would immediately relaunch a persistent loser if it
      // returned here. Stay quiescent instead, then claim the socket if the
      // daemon-hosted owner goes away. The pid file keeps launchd/manual starts
      // from creating additional waiters while this process is standing by.
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
  cleanupActive = () => {
    store.clear();
    if (sweepTimer) clearInterval(sweepTimer);
    try { watcher?.kill(); } catch { /* already gone */ }
    try { server.close(); } catch { /* not listening */ }
    try { fs.unlinkSync(sock); } catch { /* gone */ }
    releasePid();
  };

  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);

  // Auto-lock on sleep. The signed helper emits LOCK / SLEEP lines; we wipe
  // everything on SLEEP (and, implicitly, logout — that tears down the launchd
  // session and kills this in-memory broker). A bare screen-lock is deliberately
  // NOT a wipe: with the ~7d hold, re-prompting after every lock would defeat the
  // point, and a locked screen is already gated by the login password. If the
  // installed helper predates watch-lock (exits non-zero immediately), we fall
  // back to TTL-only and log nothing — the unlock already warned when
  // lock_on_sleep couldn't be armed.
  try {
    watcher = spawn(getKeychainHelperPath(), ['watch-lock'], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout?.setEncoding('utf-8');
    watcher.stdout?.on('data', (chunk: string) => {
      if (shouldWipeOnWatchEvent(chunk)) {
        store.clear();
        emptySince = Date.now();
      }
    });
    watcher.on('error', () => { watcher = null; });
  } catch {
    watcher = null;
  }

  return {
    close() {
      if (shuttingDown) return;
      shuttingDown = true;
      detachSignals();
      cleanupActive?.();
    },
  };
}

/**
 * Host the secrets broker inside the always-on daemon (#416).
 *
 * Serves the SAME socket and wire protocol as the standalone `runSecretsAgent`
 * — so every existing client (`agentGetSync`, `agentPing`, `agentAutoLoadSync`)
 * keeps working unchanged, no PROTOCOL_VERSION bump — but it is daemon-safe:
 *
 *   - no pid-file single-instance guard (the daemon owns the instance);
 *   - no `process.exit`, no SIGTERM/SIGINT handlers, no self-heal/idle-exit
 *     (those would kill the daemon — the daemon is the always-on backbone and
 *     manages its own version/lifecycle). The sweep only TTL-evicts.
 *
 * The caller (`runDaemon`) normally invokes this only when no broker answers
 * its initial ping. Binding still arbitrates ownership through the same shared
 * path as the standalone service: a live owner wins, while only an unreachable
 * stale socket is reclaimed. Returns a handle the daemon closes on shutdown,
 * or null off-darwin (nothing to broker without biometry).
 */
export async function startHostedBroker(): Promise<{ close(): void } | null> {
  if (!onDarwin()) return null;

  const store = new Map<string, StoredBundle>();
  const sock = socketPath(); // agentDir() creates the 0700 dir as a side effect

  const handle = (req: Request): Response => handleAgentRequest(store, req);
  const onConn = (conn: net.Socket) => {
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
          resp = handle(JSON.parse(line) as Request);
        } catch (err) {
          resp = { ok: false, error: (err as Error).message };
        }
        conn.write(JSON.stringify(resp) + '\n');
      }
    });
    conn.on('error', () => { /* client vanished mid-request; ignore */ });
  };

  const server = await bindBrokerSocket(sock, onConn);
  if (!server) return null;

  // TTL eviction ONLY. Unlike the standalone broker's sweep, there is no
  // self-heal-exit or idle-exit here — the daemon is always-on and owns the
  // upgrade/lifecycle path; a broker that called process.exit() would take the
  // whole daemon down with it.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [name, e] of store) if (now >= e.expiresAt) store.delete(name);
  }, SWEEP_INTERVAL_MS);

  // Auto-lock on sleep, same as the standalone broker: the signed helper emits
  // LOCK/SLEEP lines; wipe the in-memory store on a wipe-worthy event.
  let watcher: ChildProcess | null = null;
  try {
    watcher = spawn(getKeychainHelperPath(), ['watch-lock'], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout?.setEncoding('utf-8');
    watcher.stdout?.on('data', (chunk: string) => {
      if (shouldWipeOnWatchEvent(chunk)) store.clear();
    });
    watcher.on('error', () => { watcher = null; });
  } catch {
    watcher = null;
  }

  return {
    close() {
      store.clear();
      clearInterval(sweepTimer);
      try { watcher?.kill(); } catch { /* already gone */ }
      try { server.close(); } catch { /* not listening */ }
      try { fs.unlinkSync(sock); } catch { /* gone */ }
    },
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

/** Open the socket, send one request, resolve the one response. Async path —
 * used by the unlock/lock/status commands, which already run in async actions. */
function request(req: Request, timeoutMs = 2000): Promise<Response | null> {
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
    conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
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

/** True if a broker socket exists at all. Cheap; gates the sync read so the
 * never-unlocked path stays a single stat. */
export function agentSocketExists(): boolean {
  return onDarwin() && fs.existsSync(socketPath());
}

/**
 * Inline node program for the synchronous read fast-path. `readAndResolveBundleEnv`
 * is synchronous and called synchronously everywhere, so we can't await a socket
 * round-trip — but spawning the full CLI to do it would load every command. This
 * minimal `node -e` client connects, asks for one bundle, prints the resolved
 * {bundle, env} as JSON, and exits 0 (hit) / 3 (miss or agent down). argv after
 * -e: [execPath, <socket>, <name>].
 */
const SYNC_GET_PROGRAM = `
const net = require('net');
const sock = process.argv[1], name = process.argv[2];
const c = net.createConnection(sock);
let buf = '';
const miss = () => { try { c.destroy(); } catch (e) {} process.exit(3); };
const timer = setTimeout(miss, 2000);
c.on('error', miss);
c.on('connect', () => c.write(JSON.stringify({ cmd: 'get', name }) + '\\n'));
c.setEncoding('utf-8');
c.on('data', (d) => {
  buf += d;
  const nl = buf.indexOf('\\n');
  if (nl < 0) return;
  clearTimeout(timer);
  let r; try { r = JSON.parse(buf.slice(0, nl)); } catch (e) { return miss(); }
  try { c.destroy(); } catch (e) {}
  if (r && r.ok && r.hit) { process.stdout.write(JSON.stringify({ bundle: r.bundle, env: r.env })); process.exit(0); }
  process.exit(3);
});
`;

/**
 * Synchronous read for the hot path. Returns the cached resolved bundle, or
 * null if the agent isn't running / doesn't hold this bundle / anything fails
 * (soft — caller falls through to the real keychain). macOS only.
 */
export function agentGetSync(name: string): { bundle: SecretsBundle; env: Record<string, string> } | null {
  if (!agentSocketExists()) return null;
  const r = spawnSync(process.execPath, ['-e', SYNC_GET_PROGRAM, socketPath(), name], {
    encoding: 'utf-8',
    timeout: 3000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const o = JSON.parse(r.stdout) as { bundle: SecretsBundle; env: Record<string, string> };
    if (!o || typeof o !== 'object' || !o.env) return null;
    return { bundle: o.bundle, env: o.env };
  } catch {
    return null;
  }
}

/**
 * Inline node program for the synchronous evict path. Mirrors SYNC_GET_PROGRAM:
 * writeBundle is synchronous and called synchronously everywhere, so a stale
 * broker entry must be evicted without awaiting a socket round-trip. Sends one
 * {cmd:'lock', name} and exits 0 (evicted or nothing held) / 3 (agent down).
 * argv after -e: [execPath, <socket>, <name>].
 */
const SYNC_LOCK_PROGRAM = `
const net = require('net');
const sock = process.argv[1], name = process.argv[2];
const c = net.createConnection(sock);
let buf = '';
const down = () => { try { c.destroy(); } catch (e) {} process.exit(3); };
const timer = setTimeout(down, 2000);
c.on('error', down);
c.on('connect', () => c.write(JSON.stringify({ cmd: 'lock', name }) + '\\n'));
c.setEncoding('utf-8');
c.on('data', (d) => {
  buf += d;
  const nl = buf.indexOf('\\n');
  if (nl < 0) return;
  clearTimeout(timer);
  try { c.destroy(); } catch (e) {}
  process.exit(0);
});
`;

/**
 * Synchronously evict one bundle from the broker. Called after a mutating
 * keychain write (add / rotate / remove / rename / delete) so the broker never
 * keeps serving the pre-write snapshot for up to the ~7d hold — the next read
 * re-resolves from the keychain (one prompt) and re-caches fresh values.
 * Best-effort: no broker, no socket, or any failure is a silent no-op.
 * macOS only.
 */
export function agentEvictSync(name: string): void {
  if (!onDarwin()) return;
  if (!agentSocketExists()) return;
  try {
    spawnSync(process.execPath, ['-e', SYNC_LOCK_PROGRAM, socketPath(), name], { timeout: 3000 });
  } catch { /* best-effort */ }
}

// Key inside the cached entry's env that holds the JSON metadata snapshot.
const META_SNAPSHOT_KEY = '__snapshot__';

/**
 * Read the cached `secrets list` metadata snapshot for the given keychain
 * name-set hash, or null on miss / no broker / off-darwin. Reuses the value
 * fast-path socket read (agentGetSync) — no prompt, no wire change. The hash is
 * the cache key: a changed name-set (bundle added/removed/renamed) yields a
 * different key and therefore a clean miss, so the stale set is never served.
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
 * Fire-and-forget: populate the broker with a freshly-read metadata snapshot so
 * the next `secrets list` within the hold window renders without a prompt.
 * Stored as an ordinary entry (placeholder bundle, snapshot in env) under the
 * reserved META_CACHE_PREFIX key; the snapshot travels over stdin to the
 * detached worker (never argv/disk), same as value caching. macOS only.
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

/**
 * Fire-and-forget: populate the broker with a freshly-resolved bundle so the
 * NEXT process reads it without a prompt. Used by the auto-cache path after a
 * real keychain read of a `daily`-policy bundle. Adds no latency to the caller
 * — it spawns a detached `secrets _agent-load` worker (passing the resolved env
 * over stdin, never argv) and returns immediately.
 *
 * The worker reuses the robust `ensureAgentRunning` path (spawn-then-ping with a
 * generous budget) rather than a tight inline retry loop: under heavy load the
 * broker is itself a cold-starting full CLI and can take several seconds to bind
 * the socket, so a short fixed budget would give up before it's ready and the
 * cache would silently never populate. Best-effort; never throws. macOS only.
 */
export function agentAutoLoadSync(
  name: string,
  bundle: SecretsBundle,
  env: Record<string, string>,
  ttlMs: number,
): void {
  if (!onDarwin()) return;
  try {
    const { cmd, args } = cliSpawn(['secrets', '_agent-load']);
    const worker = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    worker.stdin?.write(JSON.stringify({ name, bundle, env, ttlMs }));
    worker.stdin?.end();
    worker.unref();
  } catch {
    // best-effort: the next read just pops Touch ID as it would today
  }
}

/**
 * Body of the hidden `secrets _agent-load` worker. Reads one `{name, bundle,
 * env, ttlMs}` payload from stdin, ensures the broker is up (robust, generous
 * budget), and loads the bundle into it. Detached from the originating read, so
 * its latency is invisible — which is why it can afford a long ensure budget.
 */
export async function runAgentLoadFromStdin(): Promise<void> {
  if (!onDarwin()) return;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let payload: { name?: string; bundle?: SecretsBundle; env?: Record<string, string>; ttlMs?: number };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return; // malformed payload — nothing to load
  }
  if (!payload || !payload.name || !payload.bundle || !payload.env) return;
  // Generous budget: the broker is a cold-starting full CLI; under load it can
  // take several seconds to bind. We're detached, so waiting costs nothing.
  if (!(await ensureAgentRunning(20000))) return;
  await agentLoad(payload.name, payload.bundle, payload.env, payload.ttlMs ?? DEFAULT_TTL_MS);
}

/** Store a resolved bundle in the broker. Returns false on transport failure. */
export async function agentLoad(
  name: string,
  bundle: SecretsBundle,
  env: Record<string, string>,
  ttlMs: number,
): Promise<boolean> {
  const r = await request({ cmd: 'load', name, bundle, env, ttlMs });
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

  // Self-heal: if a broker is reachable but running pre-upgrade code (its
  // reported version != the version on disk now), tear it down so the paths
  // below bring up a fresh one on current code. A current, reachable broker is
  // accepted immediately — and so is a version-skewed one that still holds
  // real unlocks (see shouldTeardownVersionSkewedBroker: wiping a hot cache
  // re-prompts Touch ID for every held bundle).
  const ping = await agentPing();
  if (ping.reachable) {
    if (ping.cliVersion === undefined || ping.cliVersion === getCliVersionFresh()) return true;
    if (!shouldTeardownVersionSkewedBroker((await agentStatus()).length)) return true;
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
    const { ensureDaemonStarted } = await import('../daemon.js');
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
  }
  try { fs.unlinkSync(socketPath()); } catch { /* gone */ }
  try { fs.unlinkSync(pidPath()); } catch { /* gone */ }

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
  if (!isNaN(pid) && isAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  try { fs.unlinkSync(socketPath()); } catch { /* gone */ }
  try { fs.unlinkSync(pidPath()); } catch { /* gone */ }
}
