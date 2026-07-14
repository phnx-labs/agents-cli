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
  /**
   * The first pane's id (`%N`) captured at creation. The exact send-keys /
   * attach handle for the agent that runs in this session — recorded so
   * `agents sessions --active` and the spawn-wrap path (src/lib/exec.ts) don't
   * have to re-query it. Absent for pre-existing/`attach-existing` sessions.
   */
  pane?: string;
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
  // `-P -F '#{pane_id}'` prints the new session's first pane id on stdout so we
  // can record the exact `%N` handle without a follow-up `list-panes`.
  const args = ['set-option', '-g', 'remain-on-exit', 'on', ';', 'new-session', '-d', '-s', opts.name, '-P', '-F', '#{pane_id}'];
  if (opts.width)  args.push('-x', String(opts.width));
  if (opts.height) args.push('-y', String(opts.height));
  if (opts.cwd)    args.push('-c', opts.cwd);
  // Separator + child command. tmux passes the rest verbatim to exec, so no
  // shell escaping is required — array args end-to-end.
  if (opts.cmd) {
    args.push('--', 'sh', '-c', opts.cmd);
  }

  const res = await runTmux({ socket, args, env: opts.env });
  // Only the new-session command in the `;`-chained invocation emits output.
  const pane = /^%\d+$/.test(res.stdout.trim()) ? res.stdout.trim() : undefined;

  const meta: SessionMeta = {
    name: opts.name,
    socket,
    createdAt: Date.now(),
    cmd: opts.cmd,
    cwd: opts.cwd,
    source: opts.source ?? 'cli',
    labels: opts.labels,
    pane,
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

/** One tmux client attached to the shared server. */
export interface TmuxClient {
  /** Controlling TTY of the terminal running `tmux attach` (e.g. '/dev/ttys004'). */
  tty: string;
  /** PID of the `tmux attach` client process — the leaf whose ancestry names the host app. */
  pid: number;
  /** The `session:window.pane` the client is currently displaying. */
  target: string;
}

/**
 * List every client attached to the shared server, with the terminal PID and
 * the session/window/pane it's viewing. This is how "viewing in <app> tab N"
 * resolves: a client's `pid` walks the process ancestry to name the host app,
 * and its `target` says which session it's attached to. Best-effort — returns
 * an empty list on any failure (no server, foreign socket) so the renderer
 * degrades to "detached".
 */
export async function listClients(socket?: string): Promise<TmuxClient[]> {
  let res;
  try {
    res = await runTmux({
      socket,
      args: ['list-clients', '-F', '#{client_tty} #{client_pid} #{session_name}:#{window_index}.#{pane_index}'],
      throwOnError: false,
    });
  } catch {
    return [];
  }
  if (res.code !== 0) return [];
  const out: TmuxClient[] = [];
  for (const line of res.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp1 = t.indexOf(' ');
    if (sp1 < 0) continue;
    const sp2 = t.indexOf(' ', sp1 + 1);
    if (sp2 < 0) continue;
    const tty = t.slice(0, sp1);
    const pid = parseInt(t.slice(sp1 + 1, sp2), 10);
    const target = t.slice(sp2 + 1).trim();
    if (!Number.isFinite(pid) || !target) continue;
    out.push({ tty, pid, target });
  }
  return out;
}

/** A dead pane's exit status, read from tmux while the pane lingers under remain-on-exit. */
export interface PaneExit {
  /** True once the process that ran in the pane has exited (pane is dead). */
  dead: boolean;
  /** Exit status of the dead pane's process, when tmux reports it. */
  status?: number;
}

/**
 * Read whether a pane's process has exited and, if so, its exit status. Used by
 * the spawn-wrap path to recover the wrapped agent's exit code after the attach
 * client returns. Returns `{ dead: false }` when tmux can't answer (session gone,
 * pane missing) so the caller treats an unreadable pane as "still alive / detach".
 */
export async function paneExitStatus(pane: string, socket?: string): Promise<PaneExit> {
  let res;
  try {
    res = await runTmux({
      socket,
      args: ['display-message', '-pt', pane, '-p', '#{pane_dead} #{pane_dead_status}'],
      throwOnError: false,
    });
  } catch {
    return { dead: false };
  }
  if (res.code !== 0) return { dead: false };
  const [deadRaw, statusRaw] = res.stdout.trim().split(/\s+/);
  const status = statusRaw !== undefined && statusRaw !== '' ? parseInt(statusRaw, 10) : undefined;
  return { dead: deadRaw === '1', status: Number.isFinite(status) ? status : undefined };
}

/**
 * Bind a per-session hook. Used by the spawn-wrap path to install a `pane-died`
 * hook that detaches the attach client the instant the wrapped agent exits (the
 * global `remain-on-exit on` otherwise leaves the client staring at a dead pane).
 * Best-effort — returns false when tmux rejects the hook so callers do not
 * stamp a schema marker and daemon reconciliation can retry later.
 */
export async function setSessionHook(name: string, hook: string, command: string, socket?: string): Promise<boolean> {
  assertValidSessionName(name);
  const sock = socket ?? getDefaultSocketPath();
  const result = await runTmux({
    socket: sock,
    args: ['set-hook', '-t', name, hook, command],
    throwOnError: false,
  }).catch(() => null);
  return result?.code === 0;
}

/**
 * Schema version of the `pane-died` hook installed on managed `agents run`
 * sessions. Bump whenever the hook's SHAPE changes so the daemon reconcile
 * (reconcileSessionHooks) knows to re-stamp live sessions a prior binary left on
 * an older shape.
 *   v1 — the original unconditional `detach-client`: ANY pane death (including a
 *        user exiting a split they opened) tore down the whole client.
 *   v2 — `#{hook_pane}`-guarded: only the AGENT pane dying detaches; a user
 *        split's death runs `kill-pane`, closing just that split.
 *   v3 — the else-branch pins its target via
 *        `run-shell "tmux -S <socket> kill-pane -t #{hook_pane}"`. Untargeted
 *        kill-pane resolves "current pane" inside the hook context, which goes
 *        nondeterministic on a loaded detached server (CI flake #965: the dead
 *        split survived as a husk); run-shell format-expands its command at
 *        fire time, so the event pane is always the target.
 *   v4 — `run-shell -C "kill-pane -t #{hook_pane}"` executes the targeted command
 *        in the tmux server instead of launching a second tmux client against
 *        the same socket from inside the hook. That self-client could race the
 *        server under load and leave the dead split behind.
 */
export const AGENT_HOOK_SCHEMA = 4;
/** Per-session tmux user-option that records which AGENT_HOOK_SCHEMA a session's hook is at. */
const HOOK_SCHEMA_OPTION = '@ag_hook_schema';

/**
 * The guarded `pane-died` hook. Detach the client ONLY when the agent pane dies
 * (so the blocking attach in runInTmux returns and the exit status can be read);
 * a user split's death runs the else-branch, closing just that split. The
 * else-branch goes through `run-shell -C` with an explicit `-t #{hook_pane}`
 * target: tmux format-expands the command at fire time and executes it inside
 * the server command queue, so the event pane is always the one killed without
 * launching a second tmux client against the same socket. A bare `kill-pane`
 * relied on the hook context supplying a "current pane", while an external
 * self-client could race the server under load. Single source of truth: both
 * the spawn-wrap (exec.ts) and the daemon reconcile build the hook here, so the
 * two can never drift.
 */
export function agentPaneDiedHook(sessionName: string, agentPane: string): string {
  return `if -F '#{==:#{hook_pane},${agentPane}}' 'detach-client -s =${sessionName}' 'run-shell -C "kill-pane -t #{hook_pane}"'`;
}

/** Stamp a session's hook-schema marker to the current version. */
export async function markSessionHookSchema(name: string, socket?: string): Promise<void> {
  const sock = socket ?? getDefaultSocketPath();
  await runTmux({ socket: sock, args: ['set-option', '-t', name, HOOK_SCHEMA_OPTION, String(AGENT_HOOK_SCHEMA)], throwOnError: false }).catch(() => {});
}

/** Read a session's hook-schema marker; undefined when unset (pre-marker sessions). */
async function readHookSchema(name: string, socket: string): Promise<string | undefined> {
  const res = await runTmux({ socket, args: ['show-options', '-v', '-t', name, HOOK_SCHEMA_OPTION], throwOnError: false }).catch(() => null);
  if (!res || res.code !== 0) return undefined;
  const v = res.stdout.trim();
  return v === '' ? undefined : v;
}

/**
 * Lowest pane id (`%N`) in a session — the first pane created, i.e. the agent
 * pane, since user splits are always created later and get higher ids. Fallback
 * for sessions whose SessionMeta (which records the agent pane) predates meta
 * persistence. Undefined when the session has no panes (already torn down).
 */
async function lowestPaneId(name: string, socket: string): Promise<string | undefined> {
  const res = await runTmux({ socket, args: ['list-panes', '-t', name, '-F', '#{pane_id}'], throwOnError: false }).catch(() => null);
  if (!res || res.code !== 0) return undefined;
  const ids = res.stdout.split('\n').map(l => l.trim()).filter(id => /^%\d+$/.test(id));
  if (!ids.length) return undefined;
  return ids.reduce((lo, id) => (parseInt(id.slice(1), 10) < parseInt(lo.slice(1), 10) ? id : lo));
}

/**
 * Retrofit the current guarded `pane-died` hook onto every managed `agents run`
 * session whose hook predates AGENT_HOOK_SCHEMA. Idempotent and NON-DESTRUCTIVE:
 * it only `set-hook`s (never kills a pane or detaches a client), so a long-lived
 * shared server started by a pre-fix binary — whose still-running sessions carry
 * the old unconditional hook that kicked the user out of the whole view when they
 * exited a split — self-heals in place, without waiting for those agents to exit
 * or for the server to be recycled.
 *
 * The daemon calls this on a light interval. The per-session `@ag_hook_schema`
 * marker makes steady-state a cheap no-op: a session already at the current
 * schema is skipped. Only run-wrapped sessions (`ag-` prefix) are touched — an
 * externally-created session on the socket keeps whatever hook it set.
 */
export async function reconcileSessionHooks(socket?: string): Promise<{ scanned: number; reconciled: number }> {
  const sock = socket ?? getDefaultSocketPath();
  if (!fs.existsSync(sock)) return { scanned: 0, reconciled: 0 };
  let sessions: ListedSession[];
  try {
    sessions = await listSessions({ socket: sock });
  } catch {
    return { scanned: 0, reconciled: 0 };
  }
  let reconciled = 0;
  for (const s of sessions) {
    if (!s.name.startsWith('ag-')) continue; // only run-wrapped sessions
    if (await readHookSchema(s.name, sock) === String(AGENT_HOOK_SCHEMA)) continue;
    const agentPane = s.meta?.pane ?? await lowestPaneId(s.name, sock);
    if (!agentPane) continue;
    const installed = await setSessionHook(s.name, 'pane-died', agentPaneDiedHook(s.name, agentPane), sock);
    if (!installed) continue;
    await markSessionHookSchema(s.name, sock);
    reconciled++;
  }
  return { scanned: sessions.length, reconciled };
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
