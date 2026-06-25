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
 * opt-in (nothing is held unless you `unlock` it), an absolute TTL, auto-lock
 * on screen-lock / sleep, and `agents secrets lock`. Nothing ever touches disk.
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
import type { SecretsBundle } from './bundles.js';

/** Bumped when the wire protocol changes; a client that pings a mismatched
 * server kills and respawns it rather than talking a stale dialect. */
const PROTOCOL_VERSION = 1;

/** Default lifetime of an unlocked bundle when `--ttl` is not given. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** After the store goes empty (all bundles locked or expired) for this long,
 * the broker exits so no idle process lingers holding a socket. */
const IDLE_EXIT_MS = 5 * 60 * 1000; // 5m

/** How often the broker sweeps expired entries. */
const SWEEP_INTERVAL_MS = 30 * 1000;

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

// ─── Wire protocol ───────────────────────────────────────────────────────────
// Newline-delimited JSON: one request object per line, one response line back.

export type Request =
  | { cmd: 'ping' }
  | { cmd: 'get'; name: string }
  | { cmd: 'load'; name: string; bundle: SecretsBundle; env: Record<string, string>; ttlMs: number }
  | { cmd: 'lock'; name?: string }
  | { cmd: 'status' };

export type Response =
  | { ok: true; cmd: 'ping'; version: number }
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
export function handleAgentRequest(
  store: Map<string, StoredBundle>,
  req: Request,
  now: number = Date.now(),
): Response {
  switch (req.cmd) {
    case 'ping':
      return { ok: true, cmd: 'ping', version: PROTOCOL_VERSION };
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
        entries.push({ name, expiresAt: e.expiresAt, keyCount: Object.keys(e.env).length });
      }
      return { ok: true, cmd: 'status', entries };
    }
  }
}

/**
 * Run the broker in the foreground. Spawned detached by ensureAgentRunning via
 * `agents secrets _agent-run`. Holds the store in memory, serves the socket,
 * sweeps expired entries, wipes on screen-lock/sleep, and self-exits when idle.
 */
export async function runSecretsAgent(): Promise<void> {
  if (!onDarwin()) return; // nothing to broker without biometry prompts

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
      if (!isNaN(holder) && isAlive(holder)) return; // another broker is live
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
  try { fs.unlinkSync(sock); } catch { /* no stale socket */ }

  const sweep = () => {
    const now = Date.now();
    for (const [name, e] of store) if (now >= e.expiresAt) store.delete(name);
    if (store.size === 0) {
      if (now - emptySince >= IDLE_EXIT_MS) shutdown(0);
    } else {
      emptySince = now;
    }
  };

  const handle = (req: Request): Response => {
    const resp = handleAgentRequest(store, req);
    if (store.size > 0) emptySince = Date.now();
    return resp;
  };

  const server = net.createServer((conn) => {
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
  });

  let watcher: ChildProcess | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    store.clear();
    if (sweepTimer) clearInterval(sweepTimer);
    try { watcher?.kill(); } catch { /* already gone */ }
    try { server.close(); } catch { /* not listening */ }
    try { fs.unlinkSync(sock); } catch { /* gone */ }
    try { if (parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10) === process.pid) fs.unlinkSync(pidFile); } catch { /* gone */ }
    process.exit(code);
  };

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => {
      try { fs.chmodSync(sock, 0o600); } catch { /* dir 0700 already gates it */ }
      resolve();
    });
  });

  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);

  // Auto-lock on screen-lock / sleep. The signed helper emits LOCK / SLEEP
  // lines; on any of them we wipe everything. If the installed helper predates
  // watch-lock (exits non-zero immediately), we fall back to TTL-only and log
  // nothing — the unlock already warned when lock_on_sleep couldn't be armed.
  try {
    watcher = spawn(getKeychainHelperPath(), ['watch-lock'], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout?.setEncoding('utf-8');
    watcher.stdout?.on('data', (chunk: string) => {
      if (/\b(LOCK|SLEEP)\b/.test(chunk)) {
        store.clear();
        emptySince = Date.now();
      }
    });
    watcher.on('error', () => { watcher = null; });
  } catch {
    watcher = null;
  }
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

/** True when `secrets.agent.auto` is enabled in agents.yaml. Best-effort; a
 * missing/unreadable meta reads as off. */
export function secretsAgentAutoEnabled(): boolean {
  try {
    return readMeta().secrets?.agent?.auto === true;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget: populate the broker with a freshly-resolved bundle so the
 * NEXT process reads it without a prompt. Used by the auto-cache path after a
 * real keychain read of a `session`-tier bundle. Adds no latency to the caller
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

/** List currently-unlocked bundles, or [] when no broker is running. */
export async function agentStatus(): Promise<AgentStatusEntry[]> {
  const r = await request({ cmd: 'status' });
  return r?.ok === true && r.cmd === 'status' ? r.entries : [];
}

/** Is a broker live and speaking our protocol version? */
async function agentPing(): Promise<boolean> {
  if (!agentSocketExists()) return false;
  const r = await request({ cmd: 'ping' });
  return r?.ok === true && r.cmd === 'ping' && r.version === PROTOCOL_VERSION;
}

/**
 * Ensure a broker is running and reachable, spawning one detached if not.
 * Returns true once the socket answers a ping. On protocol-version skew, kills
 * the stale broker and respawns. macOS only.
 */
export async function ensureAgentRunning(timeoutMs = 5000): Promise<boolean> {
  if (!onDarwin()) return false;
  if (await agentPing()) return true;

  // Socket exists but ping failed → stale/old broker. Kill it before respawn.
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
  const child = spawn(cmd, args, {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await agentPing()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
