/**
 * tmux session lifecycle.
 *
 * Public surface used by both `agents tmux` commands and external consumers
 * (swarmify, `agents teams` with a future multiplexer mode). Every state
 * change goes through here so the CLI surface stays a thin parser.
 *
 * Liveness model: tmux itself owns liveness. The `<name>.json` meta files are
 * pure provenance — `listSessions()` always reconciles them against
 * `tmux list-sessions` and prunes stale entries on the fly.
 */

import * as fs from 'fs';
import { runTmux, TmuxCommandError } from './binary.js';
import { ensureTmuxDir, getDefaultSocketPath, getSessionMetaPath } from './paths.js';

/** Tmux session names must not contain `.` or `:` — those are reserved for window/pane addressing. */
const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Provenance written alongside each live tmux session. */
export interface SessionMeta {
  name: string;
  socket: string;
  createdAt: number;
  /** Initial command launched in the first pane (informational — tmux owns the actual process). */
  cmd?: string;
  /** Working directory the session was created in. */
  cwd?: string;
  /** Who created this session — useful for `agents sessions --active` attribution. */
  source: 'cli' | 'extension' | 'teams' | 'external';
  /** Free-form labels callers can stamp (e.g. `{ agent: 'claude', vscodePid: 1234 }`). */
  labels?: Record<string, string>;
}

export interface CreateSessionOptions {
  name: string;
  cmd?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  socket?: string;
  source?: SessionMeta['source'];
  labels?: Record<string, string>;
  /** When the named session already exists, kill it before creating. */
  replace?: boolean;
  /** When the named session already exists, return it instead of failing. */
  attachExisting?: boolean;
  /** Initial window dimensions for the detached session. tmux clamps to client size on attach. */
  width?: number;
  height?: number;
}

export interface ListedSession {
  name: string;
  socket: string;
  /** Unix epoch seconds reported by tmux (`session_created`). */
  createdAtTmux: number;
  windows: number;
  attached: boolean;
  meta?: SessionMeta;
}

export class TmuxSessionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TmuxSessionError';
  }
}

/** Reject invalid session names early — tmux's error for `.`/`:` is cryptic. */
export function assertValidSessionName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new TmuxSessionError(
      `Invalid session name: "${name}". Use 1-64 characters from [A-Za-z0-9_-]. tmux disallows '.' and ':'.`,
    );
  }
}

/** Slugify an arbitrary string into a valid session name. Useful for swarmify auto-generated names. */
export function slugifyName(input: string): string {
  const s = input.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || `s-${Date.now()}`;
}

/** True when a session by this name currently exists on the given socket. */
export async function hasSession(name: string, socket?: string): Promise<boolean> {
  assertValidSessionName(name);
  const sock = socket ?? getDefaultSocketPath();
  const res = await runTmux({
    socket: sock,
    args: ['has-session', '-t', `=${name}`],
    throwOnError: false,
  });
  return res.code === 0;
}

/**
 * Create a new detached session. Throws when the name is already taken unless
 * `replace` or `attachExisting` is set.
 */
export async function createSession(opts: CreateSessionOptions): Promise<SessionMeta> {
  assertValidSessionName(opts.name);
  ensureTmuxDir();

  const socket = opts.socket ?? getDefaultSocketPath();
  if (opts.cwd && !fs.existsSync(opts.cwd)) {
    throw new TmuxSessionError(`cwd does not exist: ${opts.cwd}`);
  }

  const existed = await hasSession(opts.name, socket);
  if (existed) {
    if (opts.attachExisting) {
      const meta = readSessionMeta(opts.name);
      return meta ?? {
        name: opts.name,
        socket,
        createdAt: Date.now(),
        source: opts.source ?? 'cli',
      };
    }
    if (!opts.replace) {
      throw new TmuxSessionError(
        `Session "${opts.name}" already exists. Use --replace to overwrite or --attach-existing to reuse it.`,
      );
    }
    await killSession(opts.name, socket);
  }

  // Set remain-on-exit BEFORE the child command can finish — a fast-exiting
  // cmd (e.g. `echo BRIEF && true`) would otherwise collapse the only session,
  // exit the server, and the follow-up `set-option` would race with "no
  // server running". Server-wide (`-g`) is applied in the same tmux
  // invocation as new-session so they share one server lifetime.
  const args = ['set-option', '-g', 'remain-on-exit', 'on', ';', 'new-session', '-d', '-s', opts.name];
  if (opts.width)  args.push('-x', String(opts.width));
  if (opts.height) args.push('-y', String(opts.height));
  if (opts.cwd)    args.push('-c', opts.cwd);
  // Separator + child command. tmux passes the rest verbatim to exec, so no
  // shell escaping is required — array args end-to-end.
  if (opts.cmd) {
    args.push('--', 'sh', '-c', opts.cmd);
  }

  await runTmux({ socket, args, env: opts.env });

  const meta: SessionMeta = {
    name: opts.name,
    socket,
    createdAt: Date.now(),
    cmd: opts.cmd,
    cwd: opts.cwd,
    source: opts.source ?? 'cli',
    labels: opts.labels,
  };
  writeSessionMeta(meta);
  return meta;
}

/** Kill one named session. Idempotent — killing a non-existent session is a no-op. */
export async function killSession(name: string, socket?: string): Promise<boolean> {
  assertValidSessionName(name);
  const sock = socket ?? getDefaultSocketPath();
  const existed = await hasSession(name, sock);
  if (!existed) {
    removeSessionMeta(name);
    return false;
  }
  try {
    await runTmux({ socket: sock, args: ['kill-session', '-t', `=${name}`] });
  } catch (err) {
    if (err instanceof TmuxCommandError && err.code !== 0) {
      // Already dead by the time the kill landed — treat as success.
    } else {
      throw err;
    }
  }
  removeSessionMeta(name);
  return true;
}

/**
 * Kill every session on the shared server AND the server itself, then prune
 * meta files. Wipes the socket so the next `new` starts from a clean slate.
 */
export async function killAll(socket?: string): Promise<number> {
  const sock = socket ?? getDefaultSocketPath();
  let count = 0;
  try {
    const sessions = await listSessions({ socket: sock });
    count = sessions.length;
    await runTmux({ socket: sock, args: ['kill-server'], throwOnError: false });
  } catch {
    // Server already gone — that's a successful kill-all.
  }
  // Clear meta files for every session we knew about.
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch { /* race-tolerant */ }
    }
  }
  // Stale socket can survive kill-server on some platforms — sweep it.
  try { fs.unlinkSync(sock); } catch { /* may not exist */ }
  return count;
}

/**
 * Map every pane id (`%N`) on a socket to its `session:window.pane` attach
 * target, in one batched `tmux list-panes -a` call. `%116 -> main:2.0` is a
 * valid `tmux attach -t main:2` / `tmux select-window -t main:2` target — a
 * human jump target, unlike the bare `%pane` send-keys id. Because it walks
 * every pane (not just one-per-session), it also surfaces multiple agents that
 * share a session across windows. Best-effort: returns an empty map on any
 * failure (tmux gone, foreign socket) so callers fall back to the raw pane id.
 */
export async function mapPanesToTargets(socket?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let res;
  try {
    res = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{pane_id} #{session_name}:#{window_index}.#{pane_index}'],
      throwOnError: false,
    });
  } catch {
    return out;
  }
  if (res.code !== 0) return out;
  for (const line of res.stdout.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) out.set(line.slice(0, sp), line.slice(sp + 1).trim());
  }
  return out;
}

/**
 * List live sessions on the socket. Reconciles meta JSONs against tmux's view:
 *  - tmux session with no meta → returned without `meta` (external session)
 *  - meta file with no tmux session → meta deleted (stale)
 */
export async function listSessions(opts: { socket?: string } = {}): Promise<ListedSession[]> {
  const socket = opts.socket ?? getDefaultSocketPath();
  if (!fs.existsSync(socket)) {
    // No server has ever run — clean orphan metas defensively.
    pruneAllMetas();
    return [];
  }

  // Pipe-separated format so we don't need to parse tmux's variable-width default output.
  const fmt = '#{session_name}|#{session_created}|#{session_windows}|#{session_attached}';
  const res = await runTmux({
    socket,
    args: ['list-sessions', '-F', fmt],
    throwOnError: false,
  });

  // tmux returns nonzero with "no server running" or "no sessions" — both mean empty.
  if (res.code !== 0) {
    if (/no server running|no sessions|error connecting/i.test(res.stderr)) {
      pruneAllMetas();
      return [];
    }
    throw new TmuxCommandError(`tmux list-sessions failed: ${res.stderr}`, res.stderr, res.stdout, res.code);
  }

  const lines = res.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const out: ListedSession[] = [];
  const liveNames = new Set<string>();
  for (const line of lines) {
    const [name, createdRaw, windowsRaw, attachedRaw] = line.split('|');
    if (!name) continue;
    liveNames.add(name);
    out.push({
      name,
      socket,
      createdAtTmux: parseInt(createdRaw, 10) || 0,
      windows: parseInt(windowsRaw, 10) || 1,
      attached: attachedRaw === '1',
      meta: readSessionMeta(name) ?? undefined,
    });
  }

  // Drop metas with no matching live session.
  pruneOrphanMetas(liveNames);
  return out;
}

export interface SplitOptions {
  name: string;
  direction: 'h' | 'v';
  cmd?: string;
  cwd?: string;
  socket?: string;
}

/**
 * Split the active pane of a session. Returns the new pane's tmux pane id
 * (e.g. `%3`) so callers can target it later via `send`/`capture`.
 */
export async function splitPane(opts: SplitOptions): Promise<string> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  if (opts.cwd && !fs.existsSync(opts.cwd)) {
    throw new TmuxSessionError(`cwd does not exist: ${opts.cwd}`);
  }

  // tmux split-window directions: -h splits the pane left/right (sibling on the
  // right); -v splits top/bottom. swarmify treats H as "below" and V as "side"
  // — keep tmux semantics (h=left/right, v=top/bottom) and document it.
  // Pane-target ops use the bare name (no =) — the '=' exact-match modifier is
  // a session-only feature; pane targets reject it with "can't find pane".
  // Slug validation already guarantees the name is unambiguous.
  const args = ['split-window', `-${opts.direction}`, '-t', opts.name, '-P', '-F', '#{pane_id}'];
  if (opts.cwd) args.push('-c', opts.cwd);
  if (opts.cmd) args.push('--', 'sh', '-c', opts.cmd);

  const res = await runTmux({ socket, args });
  return res.stdout.trim();
}

export interface SendOptions {
  name: string;
  /** Pane id (e.g. `%2`) or pane index (`0`, `1`) — appended after the session name when targeting a specific pane. */
  pane?: string;
  /** The literal characters to type into the pane. */
  keys: string;
  /** When true, do NOT append Enter at the end. */
  noEnter?: boolean;
  /**
   * When true, treat `keys` as a single literal string (-l flag). When false
   * (default), tmux interprets named keys like `C-c`, `Enter`, `Escape`.
   */
  raw?: boolean;
  socket?: string;
}

/** Send keystrokes to a session's active pane (or a specific pane via :pane). */
export async function sendKeys(opts: SendOptions): Promise<void> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  // Bare name (no =) for pane targets — see note in splitPane.
  const target = opts.pane ? `${opts.name}.${opts.pane}` : opts.name;
  const args = ['send-keys', '-t', target];
  if (opts.raw) args.push('-l');
  args.push(opts.keys);
  if (!opts.noEnter) args.push('Enter');
  await runTmux({ socket, args });
}

export interface CaptureOptions {
  name: string;
  pane?: string;
  /** Number of lines from history to include (default: visible screen only). */
  lines?: number;
  /** Keep ANSI escape sequences (default strips them). */
  ansi?: boolean;
  socket?: string;
}

/** Capture pane contents as a string. The cleaned form is what humans see. */
export async function capturePane(opts: CaptureOptions): Promise<string> {
  assertValidSessionName(opts.name);
  const socket = opts.socket ?? getDefaultSocketPath();
  // Bare name (no =) for pane targets — see note in splitPane.
  const target = opts.pane ? `${opts.name}.${opts.pane}` : opts.name;
  const args = ['capture-pane', '-p', '-t', target];
  if (opts.ansi) args.push('-e');
  if (opts.lines && opts.lines > 0) {
    // -S -N means "start N lines back from current view"; we use -S -<lines> -E -.
    args.push('-S', `-${opts.lines}`);
  }
  const res = await runTmux({ socket, args });
  return res.stdout;
}

/** Read a session's provenance JSON, if present. */
export function readSessionMeta(name: string): SessionMeta | null {
  try {
    const raw = fs.readFileSync(getSessionMetaPath(name), 'utf8');
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

function writeSessionMeta(meta: SessionMeta): void {
  ensureTmuxDir();
  fs.writeFileSync(getSessionMetaPath(meta.name), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

function removeSessionMeta(name: string): void {
  try { fs.unlinkSync(getSessionMetaPath(name)); } catch { /* may not exist */ }
}

function pruneOrphanMetas(liveNames: Set<string>): void {
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    if (!liveNames.has(name)) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch { /* race-tolerant */ }
    }
  }
}

function pruneAllMetas(): void {
  const dir = ensureTmuxDir();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch { /* race-tolerant */ }
    }
  }
}
