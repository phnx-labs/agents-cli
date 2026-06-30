// JSON-RPC client for the computer-helper.
//
// Two transports, picked at runtime:
//   - socket: ~/.agents/.cache/helpers/computer.sock (or COMPUTER_HELPER_SOCKET
//     env) when the launchd daemon is installed and listening. Sub-50ms per
//     call. Path is internal scratch — sibling of browser.sock.
//   - stdio: spawn the helper binary as a child process per call. Used in
//     dev (no install-helper) and as a fallback. The legacy probe.py and
//     drive-capcut.py scripts in rush/agents still use this shape.
//
// Both transports share the same line-delimited JSON-RPC wire format:
//   in:  {"id":N,"method":"...","params":{...}}
//   out: {"id":N,"result":{...}} or {"id":N,"error":{"code":"...","message":"..."}}

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createConnection, type Socket } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getHelpersDir, getLogsDir, getUserPermissionsDir, getPermissionsDir } from './state.js';

export interface RPCResponse {
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface ComputerClient {
  call(method: string, params?: Record<string, unknown>): Promise<RPCResponse>;
  close(): Promise<void>;
}

// Resolve the socket path used by the launchd-managed daemon. Internal
// scratch — lives under getHelpersDir() (~/.agents/.cache/helpers/),
// matching browser.sock.
export function resolveSocketPath(): string {
  const envPath = process.env.COMPUTER_HELPER_SOCKET;
  if (envPath && envPath.length > 0) return envPath;
  return path.join(getHelpersDir(), 'computer.sock');
}

// Default log path for the launchd-managed daemon. Lives in the cache/logs/
// bucket (matches the scheduler daemon's logs.jsonl convention).
export function resolveLogPath(): string {
  return path.join(getLogsDir(), 'computer-helper.log');
}

// Policy file the helper reads at startup and on SIGHUP. Sibling of
// computer.sock under ~/.agents/.cache/helpers/. Allow-list of bare bundle
// ids (e.g. "com.apple.mail"), derived from Computer(...) patterns in
// ~/.agents/permissions/groups/.
export function resolvePolicyPath(): string {
  return path.join(getHelpersDir(), 'computer-policy.json');
}

// Walk all permission group YAMLs (user dir wins on name collision) and
// collect Computer(<bundle-id>) patterns from each group's `allow:` list.
// Returns distinct bundle ids. Line-by-line regex extraction matches
// buildPermissionsFromGroups: YAML parsers stumble on the nested quotes in
// some rule values, but the strict pattern below catches our shape cleanly.
export function loadComputerAllowList(): string[] {
  const seenFiles = new Set<string>();
  const allowed = new Set<string>();

  for (const baseDir of [getUserPermissionsDir(), getPermissionsDir()]) {
    const groupsDir = path.join(baseDir, 'groups');
    if (!fs.existsSync(groupsDir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(groupsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

      // User dir wins on filename collision.
      const stem = entry.name.replace(/\.(yaml|yml)$/, '');
      if (seenFiles.has(stem)) continue;
      seenFiles.add(stem);

      const filePath = path.join(groupsDir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      // Strict regex: optional whitespace, dash, quoted Computer(<id>).
      // Only honors `allow:` lines — `deny:` Computer patterns would be a
      // contradiction (everything is deny-by-default already).
      let inAllow = false;
      for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const sectionMatch = line.match(/^(\w+)\s*:\s*$/);
        if (sectionMatch) {
          inAllow = sectionMatch[1] === 'allow';
          continue;
        }
        if (!inAllow) continue;
        const ruleMatch = line.match(/^\s*-\s*"Computer\(([^)]+)\)"\s*$/);
        if (ruleMatch) {
          const bundleId = ruleMatch[1].trim();
          if (bundleId.length > 0) allowed.add(bundleId);
        }
      }
    }
  }

  return [...allowed].sort();
}

// Write the policy file the helper reads at startup and on SIGHUP.
// Mode 0600 — same lockdown as the socket (lives in the user-owned cache
// dir, but be explicit).
export function writeComputerPolicy(allowedBundleIds: string[]): void {
  const dir = getHelpersDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const policy = { allow: allowedBundleIds };
  fs.writeFileSync(resolvePolicyPath(), JSON.stringify(policy, null, 2), { mode: 0o600 });
}

// Peer-auth (F5): the helper reads a list of executable paths it will
// accept connections from. Anything else — `nc`, `/usr/bin/python3`, a
// random electron app — gets the socket closed before its first RPC.
// File mirrors computer-policy.json: JSON, mode 0600, missing/unparseable
// means deny-everything.
export function resolvePeersPath(): string {
  return path.join(getHelpersDir(), 'computer-peers.json');
}

// Default peer set: this exact `agents` CLI binary plus Rush.app if it's
// installed. realpath() the symlink chain so we record the on-disk path
// the helper will see via proc_pidpath, not the shim path.
//
// Why path-based instead of codesign-team-id? The agents CLI is unsigned
// today (npm distribution), and even if we sign Rush.app the team-id
// check would need a separate roundtrip. Path is concrete and fast; the
// daemon already runs as the user so anyone who can swap a binary at
// these paths can do worse via other means.
export function loadDefaultPeers(): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    try {
      out.add(fs.realpathSync(p));
    } catch {
      out.add(p);
    }
  };

  // The Node executable currently running the CLI. This is what
  // proc_pidpath() will report when the CLI calls into the daemon.
  if (process.execPath) add(process.execPath);

  // Rush.app — the consumer Electron client. Both the helper-binary and
  // the main app binary are possible callers depending on how Rush wires
  // the RPC client.
  const rushCandidates = [
    '/Applications/Rush.app/Contents/MacOS/Rush',
    '/Applications/Rush.app/Contents/MacOS/Electron',
  ];
  for (const p of rushCandidates) {
    if (fs.existsSync(p)) add(p);
  }

  return [...out].sort();
}

// Write the peer-auth allow list. Same mode 0600 + atomic-ish semantics
// as the policy file. The daemon picks it up at startup and on SIGHUP.
export function writeComputerPeers(allowedExecPaths: string[]): void {
  const dir = getHelpersDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvePeersPath(), JSON.stringify({ allow: allowedExecPaths }, null, 2), { mode: 0o600 });
}

// Resolve the helper executable inside the dist .app bundle. Used by the
// stdio fallback and by install-helper to find the source bundle.
export function resolveHelperExec(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Local build (running from the agents-cli checkout).
    path.resolve(here, '..', '..', 'packages', 'computer-helper', 'dist', 'ComputerHelper.app', 'Contents', 'MacOS', 'ComputerHelper'),
    // Bundled with the npm package (later: CDN download lands here).
    path.resolve(here, '..', 'computer-helper', 'ComputerHelper.app', 'Contents', 'MacOS', 'ComputerHelper'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Resolve the dist .app bundle directory (not the inner exec).
export function resolveHelperApp(): string | null {
  const exec = resolveHelperExec();
  if (!exec) return null;
  // exec = <bundle>/Contents/MacOS/ComputerHelper
  return path.resolve(exec, '..', '..', '..');
}

// Resolve the TCP endpoint for the Windows daemon (computer-helper-win), if
// configured. The Windows helper binds loopback TCP (Program.cs) and the CLI
// reaches it over an `ssh -L` tunnel, so the endpoint is a local forwarded
// port. COMPUTER_HELPER_TCP is "host:port" (host defaults to 127.0.0.1);
// COMPUTER_HELPER_TOKEN is the shared secret sent in the first `auth` frame.
export function resolveTcpEndpoint(): { host: string; port: number; token: string | null } | null {
  const raw = process.env.COMPUTER_HELPER_TCP;
  if (!raw || raw.length === 0) return null;
  const [hostPart, portPart] = raw.includes(':') ? raw.split(':') : ['127.0.0.1', raw];
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0) return null;
  const token = process.env.COMPUTER_HELPER_TOKEN;
  return { host: hostPart || '127.0.0.1', port, token: token && token.length > 0 ? token : null };
}

// Pick the best transport. Precedence:
//   1. COMPUTER_HELPER_TCP -> the Windows daemon over a (tunneled) TCP port.
//   2. the macOS launchd socket if it exists.
//   3. spawning the helper as a subprocess (legacy/dev fallback).
export function openComputerClient(): ComputerClient {
  const tcp = resolveTcpEndpoint();
  if (tcp) {
    return new TcpClient(tcp.host, tcp.port, tcp.token);
  }
  const sockPath = resolveSocketPath();
  if (fs.existsSync(sockPath)) {
    return new SocketClient(sockPath);
  }
  const helperExec = resolveHelperExec();
  if (!helperExec) {
    throw new Error('helper not built. Run: ./packages/computer-helper/scripts/build.sh debug');
  }
  return new StdioClient(helperExec);
}

// Per-call RPC timeout. Without it a hung daemon (deadlocked connection
// queue, stopped process) hangs the CLI forever — the waiter map never
// settles. 30s clears every daemon-side ceiling (wait caps at 30s,
// launch_app at 10s, screenshot at 5s). Overridable for slower flows.
export const RPC_TIMEOUT_MS = 30_000;

export function resolveRpcTimeoutMs(env: string | undefined): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : RPC_TIMEOUT_MS;
}

// Shared waiter map + line parser. Both transports plug their reader into
// `handleChunk` and their writer into `send`.
abstract class BaseClient implements ComputerClient {
  protected buf = '';
  protected waiters = new Map<number, (r: RPCResponse) => void>();
  protected nextId = 1;
  protected closed = false;

  protected handleChunk(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as RPCResponse;
        const id = typeof obj.id === 'number' ? obj.id : null;
        if (id !== null && this.waiters.has(id)) {
          const resolve = this.waiters.get(id)!;
          this.waiters.delete(id);
          resolve(obj);
        }
      } catch {
        // Drop garbage; helper diagnostics go to stderr / log file.
      }
    }
  }

  protected failPending(code: string, message: string): void {
    for (const [id, resolve] of this.waiters) {
      resolve({ id, error: { code, message } });
    }
    this.waiters.clear();
  }

  async call(method: string, params?: Record<string, unknown>): Promise<RPCResponse> {
    if (this.closed) {
      return { id: null, error: { code: 'helper_exited', message: 'helper not running' } };
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} }) + '\n';
    const timeoutMs = resolveRpcTimeoutMs(process.env.COMPUTER_HELPER_RPC_TIMEOUT_MS);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.delete(id)) {
          resolve({ id, error: { code: 'rpc_timeout', message: `helper did not respond within ${timeoutMs}ms` } });
        }
      }, timeoutMs);
      // Resolve as an error (never reject) so callers flow through unwrap()
      // uniformly, matching failPending's contract.
      this.waiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.send(payload);
    });
  }

  protected abstract send(payload: string): void;
  abstract close(): Promise<void>;
}

class SocketClient extends BaseClient {
  private sock: Socket;

  constructor(socketPath: string) {
    super();
    this.sock = createConnection({ path: socketPath });
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => this.handleChunk(chunk));
    this.sock.on('error', (err) => {
      this.closed = true;
      this.failPending('socket_error', err.message);
    });
    this.sock.on('close', () => {
      this.closed = true;
      this.failPending('helper_exited', 'socket closed before reply');
    });
  }

  protected send(payload: string): void {
    this.sock.write(payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.sock.end();
    await new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      this.sock.on('close', () => resolve());
    });
  }
}

// TCP transport for the Windows daemon (computer-helper-win). The daemon
// binds loopback only (Program.cs); the CLI reaches it over an `ssh -L`
// tunnel, so `host` is typically 127.0.0.1 + a forwarded port. When a token
// is configured the daemon accepts only an `auth` frame until authenticated,
// so we send that first and gate every other call on it.
class TcpClient extends BaseClient {
  private sock: Socket;
  private authReady: Promise<void>;

  constructor(host: string, port: number, token: string | null) {
    super();
    this.sock = createConnection({ host, port });
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => this.handleChunk(chunk));
    this.sock.on('error', (err) => {
      this.closed = true;
      this.failPending('socket_error', err.message);
    });
    this.sock.on('close', () => {
      this.closed = true;
      this.failPending('helper_exited', 'tcp connection closed before reply');
    });
    // Kick off the auth handshake synchronously so its frame (id 1) is the
    // first thing written. No token → daemon is open (tunnel-gated).
    this.authReady = token ? this.authenticate(token) : Promise.resolve();
  }

  private async authenticate(token: string): Promise<void> {
    const res = await super.call('auth', { token });
    if (res.error) throw new Error(`computer-helper auth failed: ${res.error.code}`);
  }

  async call(method: string, params?: Record<string, unknown>): Promise<RPCResponse> {
    if (method !== 'auth') {
      try {
        await this.authReady;
      } catch (e) {
        return { id: null, error: { code: 'auth_failed', message: (e as Error).message } };
      }
    }
    return super.call(method, params);
  }

  protected send(payload: string): void {
    this.sock.write(payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.sock.end();
    await new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      this.sock.on('close', () => resolve());
    });
  }
}

class StdioClient extends BaseClient {
  private proc: ChildProcessWithoutNullStreams;

  constructor(helperPath: string) {
    super();
    this.proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.handleChunk(chunk));
    this.proc.on('exit', () => {
      this.closed = true;
      this.failPending('helper_exited', 'helper exited before reply');
    });
  }

  protected send(payload: string): void {
    this.proc.stdin.write(payload);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      this.proc.on('exit', () => resolve());
    });
  }
}

// Describe which transport is currently in use. Useful for diagnostics
// like `agents computer status`.
export function describeTransport(): { kind: 'socket' | 'stdio' | 'none'; path: string | null } {
  const sockPath = resolveSocketPath();
  if (fs.existsSync(sockPath)) return { kind: 'socket', path: sockPath };
  const exec = resolveHelperExec();
  if (exec) return { kind: 'stdio', path: exec };
  return { kind: 'none', path: null };
}
