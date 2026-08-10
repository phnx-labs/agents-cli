/**
 * Reap the helper processes an exited agent leaves behind (RUSH-2521).
 *
 * ## The leak
 *
 * An interactive agent runs as the leaf of a detached tmux pane
 * (`runInTmux` → `createSession`, [`../exec.ts`](../exec.ts)). Anything the
 * harness spawns — MCP servers, background daemons, `exec` helper trees — is a
 * child of that pane. When the agent exits, the kernel SIGHUPs the pane's
 * FOREGROUND process group only. A helper that put itself in its own process
 * group, or that ignores SIGHUP, survives: it reparents to init and keeps its
 * memory forever. Measured on the fleet: one pane holding 2.5 GB of Claude Code
 * background daemons 22 days after its session ended, and 34 orphaned
 * `cgraph-mcp --daemon` processes on a single worker.
 *
 * ## Why attribution is by ENVIRONMENT, not by pid ancestry / tty / pgid
 *
 * Every obvious OS handle is destroyed by exactly the event we are detecting:
 *
 * - **ppid ancestry** — an orphan is reparented to init the instant its parent
 *   dies, so the chain back to the pane is gone.
 * - **controlling terminal** — POSIX disassociates the controlling terminal from
 *   every process in a session when the session leader exits, so the orphan's
 *   `tty` reads `?`. Verified on Linux: an orphan under a dead pane leader shows
 *   `tty=?` while its own pane still reports `pane_tty=/dev/pts/6`.
 * - **process group** — the helpers that survive are precisely the ones that
 *   left the pane's process group (that is why they survived the SIGHUP).
 * - **POSIX session id** — durable and correct, but not portable: `ps -o sid=`
 *   exists on Linux and does not exist on macOS (`ps: sid: keyword not found`),
 *   `ps -o sess=` reports 0 there, and `pgrep -s` is Linux-only.
 *
 * What DOES survive all of it is the process environment. `runInTmux` stamps
 * `AGENT_TMUX_SESSION_NAME` into the pane env ([`../exec.ts`](../exec.ts)), and
 * every descendant inherits it — including a reparented one. So a process
 * carrying `AGENT_TMUX_SESSION_NAME=<name>` is attributable to that tmux session
 * with no heuristics at all, and tmux itself is the liveness oracle for whether
 * that session's agent is still running.
 *
 * ## The second tier: harness daemons that scrub the environment
 *
 * Claude Code's background pool (`claude … daemon run`, which owns the
 * `bg-pty-host` / `bg-spare` processes) starts with a clean environment, so tier
 * one cannot see it. It does, however, declare its owner in its own argv:
 * `daemon run --origin transient --spawned-by {"label":"claude",…,"pid":3834601}`.
 * A pool whose declared spawner pid is dead is unowned, so it and its descendants
 * are reaped. That rule lives in {@link DETACHED_HELPER_RULES} rather than an
 * inline `if (agent === 'claude')`, so another harness that detaches helpers the
 * same way is one table entry.
 *
 * ## Safety
 *
 * Nothing is killed without positive proof its owner is gone:
 *
 * - a tmux session that still exists AND whose agent pane process is alive
 *   protects every process it owns;
 * - a tmux session with a client attached protects every process it owns,
 *   whatever the pane state;
 * - the reaping process itself, its ancestors, pid 1, and every long-lived
 *   agents-cli service ({@link isProtectedAgentsService}) are never candidates.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Ceiling on the `ps` snapshot so a wedged `ps` can never stall the daemon tick. */
const PS_TIMEOUT_MS = 10_000;

/** Grace between SIGTERM and SIGKILL for a reaped orphan. */
export const REAP_GRACE_MS = 2_000;

/** Env var `runInTmux` stamps into the pane, inherited by every descendant. */
export const TMUX_SESSION_ENV = 'AGENT_TMUX_SESSION_NAME';

/** One process, with the fields the reaper attributes on. */
export interface AgentProcess {
  pid: number;
  ppid: number;
  /** Full command line (`ps -o args=`). */
  args: string;
  /** Value of {@link TMUX_SESSION_ENV} inherited from the pane, when present. */
  tmuxSession?: string;
}

/** Liveness of the tmux session that owns a set of processes. */
export interface PaneOwner {
  /** The session's agent pane process is still running. */
  agentAlive: boolean;
  /** A client is attached to the session — a human is looking at it. */
  attached: boolean;
}

/** Why a process was selected, for human output and tests. */
export type OrphanReason = 'tmux-session-gone' | 'tmux-agent-exited' | 'detached-helper';

export interface OrphanCandidate {
  pid: number;
  args: string;
  reason: OrphanReason;
  /** Owning tmux session, when the process carried the marker. */
  tmuxSession?: string;
}

export interface OrphanReapResult {
  /** Processes signalled (SIGTERM, escalated to SIGKILL when they ignore it). */
  killed: number;
  /** One human-readable line per reaped process. */
  details: string[];
  /** Selected candidates, whether or not they were killed (`dryRun`). */
  candidates: OrphanCandidate[];
}

/**
 * A harness that detaches helper daemons from the session environment, and the
 * pid it records as their owner.
 *
 * Registry rather than per-agent branches: a second harness with the same shape
 * is one entry, and the completeness of the table is what a reviewer checks.
 */
export interface DetachedHelperRule {
  /** Harness id, for the reap detail line. */
  agent: string;
  /** Owner pid the helper declares in its own argv, or undefined when it is not this rule's process. */
  spawnerPid(args: string): number | undefined;
}

/**
 * Claude Code's background daemon pool. Its argv carries a JSON `--spawned-by`
 * blob naming the claude process that started it, e.g.
 * `claude.exe daemon run --origin transient --spawned-by {"label":"claude","cwd":"/…","pid":3834601}`.
 * The `bg-pty-host` / `bg-spare` workers are its children and are reaped as
 * descendants rather than matched individually — they carry no owner of their own.
 */
const CLAUDE_BG_DAEMON: DetachedHelperRule = {
  agent: 'claude',
  spawnerPid(args: string): number | undefined {
    if (!/\bdaemon\s+run\b/.test(args)) return undefined;
    const m = /--spawned-by\s+.*?"pid"\s*:\s*(\d+)/.exec(args);
    if (!m) return undefined;
    const pid = parseInt(m[1], 10);
    return Number.isFinite(pid) && pid > 1 ? pid : undefined;
  },
};

export const DETACHED_HELPER_RULES: DetachedHelperRule[] = [CLAUDE_BG_DAEMON];

/**
 * Long-lived agents-cli services that must never be reaped, even when they
 * inherited a pane's environment because the CLI invocation that started them
 * happened to run inside an agent pane.
 *
 * This is a safety invariant, not a fallback: the routines daemon runs this very
 * reaper, so killing it would make the reaper delete its own executor, and the
 * secrets broker holds the keychain session every live agent depends on.
 */
export function isProtectedAgentsService(args: string): boolean {
  return /\b__daemon-run\b/.test(args)
    || /\bsecrets\s+_agent-run\b/.test(args)
    || /\bMenubarHelper\b/.test(args)
    || /\bAgents CLI\.app\b/.test(args);
}

/** Is this pid currently running? Signal-0 probe, matching `platform/process.ts`. */
function livePid(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Pure. Select the processes whose owning agent is provably gone.
 *
 * `owners` maps a tmux session name to its liveness; a name ABSENT from the map
 * is a session tmux no longer has, which is the strongest orphan signal there is.
 */
export function selectOrphanProcesses(
  procs: AgentProcess[],
  owners: Map<string, PaneOwner>,
  opts: { protectedPids: Set<number>; isAlive?: (pid: number) => boolean },
): OrphanCandidate[] {
  const isAlive = opts.isAlive ?? livePid;
  const eligible = (p: AgentProcess): boolean =>
    p.pid > 1 && !opts.protectedPids.has(p.pid) && !isProtectedAgentsService(p.args);

  const out: OrphanCandidate[] = [];
  const seen = new Set<number>();
  const push = (p: AgentProcess, reason: OrphanReason): void => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    out.push({ pid: p.pid, args: p.args, reason, tmuxSession: p.tmuxSession });
  };

  // Tier 1 — inherited pane marker with a dead owner.
  for (const p of procs) {
    if (!p.tmuxSession || !eligible(p)) continue;
    const owner = owners.get(p.tmuxSession);
    if (!owner) {
      push(p, 'tmux-session-gone');
      continue;
    }
    // An attached client or a live agent pane process is a hard exclusion.
    if (owner.attached || owner.agentAlive) continue;
    push(p, 'tmux-agent-exited');
  }

  // Tier 2 — a detached helper daemon whose declared spawner is dead, plus the
  // workers it owns. Its own descendants are pulled in because they carry no
  // owner declaration of their own.
  const seeds: AgentProcess[] = [];
  for (const p of procs) {
    if (!eligible(p)) continue;
    for (const rule of DETACHED_HELPER_RULES) {
      const spawner = rule.spawnerPid(p.args);
      if (spawner === undefined || isAlive(spawner)) continue;
      seeds.push(p);
      break;
    }
  }
  if (seeds.length > 0) {
    const byPid = new Map(procs.map(p => [p.pid, p]));
    for (const seed of descendantsOf(procs, seeds.map(s => s.pid))) {
      const p = byPid.get(seed);
      if (p && eligible(p)) push(p, 'detached-helper');
    }
  }

  return out;
}

/**
 * Pure. `seeds` plus every process reachable from them through ppid links.
 * Depth is bounded by the table size, so a ppid cycle (which the kernel cannot
 * produce, but a malformed snapshot could) terminates.
 */
export function descendantsOf(procs: AgentProcess[], seeds: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

/** Pure. Parse `ps -A -o pid=,ppid=,args=` output. */
export function parseProcessRows(stdout: string): AgentProcess[] {
  const rows: AgentProcess[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, args: m[3].trim() });
  }
  return rows;
}

/**
 * Pure. Extract the pane marker from a blob that contains the process
 * environment — a NUL-separated `/proc/<pid>/environ` on Linux, or the
 * space-separated `KEY=VALUE` tail macOS `ps -E` appends after the command.
 * Session names are `[A-Za-z0-9_-]` ({@link ../tmux/session.ts} `VALID_NAME`),
 * so the value ends at the first character outside that set.
 */
export function parseTmuxSessionMarker(blob: string): string | undefined {
  const m = new RegExp(`(?:^|[\\s\\0])${TMUX_SESSION_ENV}=([A-Za-z0-9_-]{1,64})`).exec(blob);
  return m ? m[1] : undefined;
}

/** Pure. Parse `tmux list-panes -a -F '#{session_name}\t#{pane_pid}\t#{session_attached}'`. */
export function parsePaneOwners(stdout: string, isAlive: (pid: number) => boolean = livePid): Map<string, PaneOwner> {
  const owners = new Map<string, PaneOwner>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const name = parts[0];
    if (!name) continue;
    const panePid = parseInt(parts[1], 10);
    const attached = parts[2].trim() !== '0';
    const prev = owners.get(name);
    const agentAlive = Number.isFinite(panePid) && isAlive(panePid);
    owners.set(name, {
      agentAlive: (prev?.agentAlive ?? false) || agentAlive,
      attached: (prev?.attached ?? false) || attached,
    });
  }
  return owners;
}

/**
 * Snapshot the process table with each process's pane marker.
 *
 * Two readers because no single command works on both platforms: Linux exposes
 * `/proc/<pid>/environ` (one cheap read per pid), while macOS has no `/proc` and
 * instead lets `ps -E` print a process's own-uid environment after its command.
 * Windows has no tmux integration at all, so it returns an empty table rather
 * than pretending to reap.
 */
export async function readAgentProcesses(): Promise<AgentProcess[]> {
  if (process.platform === 'win32') return [];
  const hasProc = fs.existsSync('/proc/self/environ');
  const args = hasProc ? ['-A', '-o', 'pid=,ppid=,args='] : ['-A', '-E', '-o', 'pid=,ppid=,args='];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: PS_TIMEOUT_MS }));
  } catch {
    return [];
  }
  const rows = parseProcessRows(stdout);
  if (!hasProc) {
    // `ps -E` already appended the environment to the args column.
    for (const row of rows) row.tmuxSession = parseTmuxSessionMarker(row.args);
    return rows;
  }
  for (const row of rows) {
    let blob: string;
    try {
      blob = fs.readFileSync(`/proc/${row.pid}/environ`, 'utf8');
    } catch {
      continue; // exited between ps and the read, or not ours to inspect
    }
    row.tmuxSession = parseTmuxSessionMarker(blob);
  }
  return rows;
}

/** Read every tmux session's ownership state from one socket. */
export async function readPaneOwners(socket: string): Promise<Map<string, PaneOwner>> {
  if (!fs.existsSync(socket)) return new Map();
  const { runTmux } = await import('./binary.js');
  const res = await runTmux({
    socket,
    args: ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{session_attached}'],
    throwOnError: false,
  }).catch(() => null);
  if (!res || res.code !== 0) return new Map();
  return parsePaneOwners(res.stdout);
}

/**
 * Ownership across every socket that could own a marked process, merged so a
 * session that is live on ANY of them protects its processes.
 *
 * The union is load bearing, not defensive: the process table is machine-wide,
 * so a reap driven from a non-default socket (`agents sessions reap --socket`,
 * or a test's temp socket) would otherwise see every real agent's marker with no
 * matching session and classify a whole box's live helpers as orphans.
 */
async function readAllPaneOwners(socket: string): Promise<Map<string, PaneOwner>> {
  const { getDefaultSocketPath } = await import('./paths.js');
  const merged = new Map<string, PaneOwner>();
  for (const sock of new Set([socket, getDefaultSocketPath()].filter(Boolean))) {
    for (const [name, owner] of await readPaneOwners(sock)) {
      const prev = merged.get(name);
      merged.set(name, {
        agentAlive: (prev?.agentAlive ?? false) || owner.agentAlive,
        attached: (prev?.attached ?? false) || owner.attached,
      });
    }
  }
  return merged;
}

/** Pids the reaper must never signal: itself and its whole ancestor chain. */
function selfProtectedPids(procs: AgentProcess[]): Set<number> {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const out = new Set<number>([process.pid]);
  let cursor = process.ppid;
  // Bounded by the table size — an ancestor walk cannot exceed it.
  for (let i = 0; i <= procs.length && cursor > 1; i += 1) {
    out.add(cursor);
    cursor = byPid.get(cursor)?.ppid ?? 0;
  }
  return out;
}

/** SIGTERM every candidate, then SIGKILL whatever ignored it. */
async function terminate(candidates: OrphanCandidate[], graceMs: number): Promise<number> {
  let signalled = 0;
  for (const c of candidates) {
    try {
      process.kill(c.pid, 'SIGTERM');
      signalled += 1;
    } catch { /* already gone */ }
  }
  if (signalled === 0) return 0;
  await new Promise(resolve => setTimeout(resolve, graceMs));
  for (const c of candidates) {
    if (!livePid(c.pid)) continue;
    try { process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return signalled;
}

function describe(c: OrphanCandidate): string {
  const where = c.tmuxSession ? ` [${c.tmuxSession}]` : '';
  return `pid ${c.pid}${where} (${c.reason}): ${c.args.slice(0, 120)}`;
}

/**
 * Reap every helper process whose owning agent has exited.
 *
 * Called from the daemon's periodic tick and from `agents sessions reap`. Panes
 * are read BEFORE processes so a session that disappears mid-scan is treated as
 * gone (reapable) rather than as a live owner.
 */
export async function reapOrphanAgentProcesses(
  opts: { socket: string; dryRun?: boolean; graceMs?: number } = { socket: '' },
): Promise<OrphanReapResult> {
  const result: OrphanReapResult = { killed: 0, details: [], candidates: [] };
  if (process.platform === 'win32') return result;

  const owners = await readAllPaneOwners(opts.socket);
  const procs = await readAgentProcesses();
  if (procs.length === 0) return result;

  const candidates = selectOrphanProcesses(procs, owners, { protectedPids: selfProtectedPids(procs) });
  result.candidates = candidates;
  if (candidates.length === 0) return result;

  result.details = candidates.map(describe);
  if (opts.dryRun) return result;
  result.killed = await terminate(candidates, opts.graceMs ?? REAP_GRACE_MS);
  return result;
}

/**
 * Reap the helper processes belonging to ONE tmux session, on the teardown path.
 *
 * `killSession` calls this so an agent's helpers die with the session that owned
 * them instead of waiting for the next daemon tick. The tmux session is being
 * destroyed by the caller, so ownership needs no liveness check — anything still
 * carrying this session's marker is leftover by definition.
 */
export async function reapProcessesForTmuxSession(
  name: string,
  opts: { dryRun?: boolean; graceMs?: number } = {},
): Promise<OrphanReapResult> {
  const result: OrphanReapResult = { killed: 0, details: [], candidates: [] };
  if (process.platform === 'win32') return result;

  const procs = await readAgentProcesses();
  if (procs.length === 0) return result;

  const protectedPids = selfProtectedPids(procs);
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const owned = procs.filter(p => p.tmuxSession === name);
  // Descendants too: a helper that scrubbed its own environment (so it carries
  // no marker) is still attributable through the marked process that spawned it.
  const candidates: OrphanCandidate[] = [];
  for (const pid of descendantsOf(procs, owned.map(p => p.pid))) {
    const p = byPid.get(pid);
    if (!p || p.pid <= 1 || protectedPids.has(p.pid) || isProtectedAgentsService(p.args)) continue;
    candidates.push({ pid: p.pid, args: p.args, reason: 'tmux-agent-exited', tmuxSession: name });
  }
  result.candidates = candidates;
  if (candidates.length === 0) return result;

  result.details = candidates.map(describe);
  if (opts.dryRun) return result;
  result.killed = await terminate(candidates, opts.graceMs ?? REAP_GRACE_MS);
  return result;
}
