/**
 * Resolve the agent identity of whoever invoked `agents browser`.
 *
 * The browser daemon is shared and long-lived, so identity must be captured in
 * the CLI process and forwarded over IPC. Order:
 *
 *   1. Env already set by `agents run` (`AGENT_SESSION_ID` / `AGENT_LAUNCH_ID`)
 *   2. Session-tracker state file under `~/.agents/.cache/terminals/sessions/`
 *      (and the deployed fleet path under `state/sessions/`), keyed by
 *      process.ppid and walked up the ancestor chain
 *   3. Process-table anchor — nearest ancestor whose comm maps to a known
 *      harness via `agentKindFromComm` (derived from SESSION_AGENTS)
 *
 * No per-harness env-var table: the state-file reader and the process-table
 * classifier cover every harness by construction.
 */
import { execFileSync } from 'child_process';
import { resolveActor } from '../actor.js';
import { agentKindFromComm } from '../session/active.js';
import {
  loadHookSessionIndex,
  readStateSessionRecord,
  type HookSessionRecord,
} from '../session/hook-sessions.js';

export interface CallerIdentity {
  actor: string;
  launchId?: string;
  sessionId?: string;
  /** Agent pid when identity came from the process-table anchor. */
  agentPid?: number;
}

const MAX_ANCESTOR_WALK = 16;

/**
 * Read pid→ppid→comm for one process. Returns null when the process is gone
 * or `ps` fails.
 */
function readProc(pid: number): { pid: number; ppid: number; comm: string } | null {
  if (!pid || pid <= 1) return null;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    const m = out.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) return null;
    return {
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      comm: m[3].trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Walk ancestors starting at `startPid` (inclusive). Yields each pid once.
 */
function* ancestorPids(startPid: number): Generator<number> {
  let cur = startPid;
  const seen = new Set<number>();
  for (let i = 0; i < MAX_ANCESTOR_WALK && cur > 1 && !seen.has(cur); i++) {
    seen.add(cur);
    yield cur;
    const proc = readProc(cur);
    if (!proc) return;
    cur = proc.ppid;
  }
}

/**
 * Look up a session-tracker / deployed-hook state record for `pid`.
 * Prefers the richer terminals/sessions index; falls back to the fleet
 * state/sessions path (RUSH-2007).
 */
function stateForPid(pid: number, index: ReturnType<typeof loadHookSessionIndex>): HookSessionRecord | undefined {
  const fromIndex = index.byPid.get(pid);
  if (fromIndex?.session_id) return fromIndex;
  return readStateSessionRecord(pid);
}

/**
 * Resolve caller identity once per CLI process for browser IPC stamping.
 *
 * Starts from `process.ppid` — the shell or harness that launched this
 * `agents browser` invocation — and walks up until a state file or known
 * agent comm is found.
 */
export function resolveCallerIdentity(env: NodeJS.ProcessEnv = process.env): CallerIdentity {
  const actor = resolveActor().id;
  let sessionId = env.AGENT_SESSION_ID || env.AGENTS_SESSION_ID || undefined;
  let launchId = env.AGENT_LAUNCH_ID || undefined;
  let agentPid: number | undefined;

  if (sessionId && launchId) {
    return { actor, sessionId, launchId };
  }

  // Start at ppid: when an agent runs a Bash tool call, the browser CLI's
  // parent is that shell (or the agent itself when launched directly).
  const startPid = typeof process.ppid === 'number' && process.ppid > 0 ? process.ppid : 0;
  if (startPid > 0) {
    let index: ReturnType<typeof loadHookSessionIndex> | undefined;
    try {
      index = loadHookSessionIndex();
    } catch {
      index = undefined;
    }

    for (const pid of ancestorPids(startPid)) {
      if (index) {
        const rec = stateForPid(pid, index);
        if (rec?.session_id) {
          sessionId = sessionId || rec.session_id;
          launchId = launchId || rec.launch_id;
          agentPid = pid;
          break;
        }
      } else {
        const rec = readStateSessionRecord(pid);
        if (rec?.session_id) {
          sessionId = sessionId || rec.session_id;
          launchId = launchId || rec.launch_id;
          agentPid = pid;
          break;
        }
      }
    }

    // Process-table anchor: nearest ancestor whose comm is a known harness.
    // Covers harnesses with no SessionStart hook (and sessions the hook missed).
    //
    // IMPORTANT: stamp as launchId, NEVER as sessionId. A synthetic
    // `agent-pid:<n>` is not a real agent session UUID — if it lands in
    // sessionId, hygiene.taskOwnerIsGone treats it as a dead session (the
    // process-table session probe rejects non-UUID shapes) and reaps the
    // task mid-run. launchId-only tasks are never session-reaped
    // (hygiene.ts: launchId alone is not proof of death).
    if (!sessionId && !launchId) {
      for (const pid of ancestorPids(startPid)) {
        const proc = readProc(pid);
        if (!proc) continue;
        const kind = agentKindFromComm(proc.comm);
        if (kind) {
          launchId = `agent-pid:${pid}`;
          agentPid = pid;
          break;
        }
      }
    }
  }

  return { actor, sessionId, launchId, agentPid };
}

/**
 * True when a live task belongs to this caller. Match on sessionId or
 * launchId — either is enough. A task with no recorded identity never
 * matches a caller that has one (and vice versa for the no-identity case
 * handled separately by the resolver).
 */
export function taskMatchesCaller(
  task: { sessionId?: string; launchId?: string },
  caller: { sessionId?: string; launchId?: string },
): boolean {
  if (caller.sessionId && task.sessionId && caller.sessionId === task.sessionId) return true;
  if (caller.launchId && task.launchId && caller.launchId === task.launchId) return true;
  return false;
}
