/**
 * Abandoned browser-task reaper (RUSH-2622).
 *
 * `agents browser done` / `stop` already close a task's tabs, but agents
 * routinely never call them — the run ends, the process exits, and the task's
 * tabs stay open in the profile window forever. Over a day of fleet activity
 * that is dozens of leftover tabs in Comet/Chrome.
 *
 * This closes the loop from the other end: a periodic pass that finds tasks
 * nobody is driving any more and stops them.
 *
 * Two independent reasons, both conservative:
 *
 *   - `session-dead` — the task recorded WHICH agent session (`sessionId`) or
 *     WHICH run (`launchId`) started it, and neither is alive on this host.
 *     That is the honest end of the task: the thing that would have called
 *     `done` no longer exists.
 *   - `idle` — nothing has touched the task for `idleMs` (default 30 minutes).
 *     The catch-all for a task with no recorded identity (a human running
 *     `agents browser start` by hand) or an agent that stalled without exiting.
 *
 * Closing always goes through `BrowserService.stop`, never a direct
 * `Target.closeTarget`, so history, the session cache, the target cache, and
 * forked-profile teardown all stay on the one code path that already handles
 * them. Two things this deliberately never does: touch a tab that is not in
 * `task.tabs` (a tab the user opened themselves is not ours to close), and kill
 * the profile window or the browser process because one task went idle.
 */
import { isPidAlive, isSessionIdLiveOnProcessTable } from '../session/active.js';
import { listPidSessionEntries, sessionIdFromLivePid, type PidSessionEntry } from '../session/pid-registry.js';
import type { ReapResult, ReapedTask, Task } from './types.js';

/** Default idle window before an untouched task is reaped. */
export const DEFAULT_IDLE_MS = 30 * 60_000;

/**
 * The slice of `BrowserService` the reaper needs. Structural, so a test drives
 * it with a stub and `BrowserService` satisfies it without an import — which
 * also keeps this module off the service's import cycle.
 */
export interface ReapableService {
  listTasks(): Array<{ profile: string; task: Task }>;
  recordStatus(taskName: string): Promise<{ recording: boolean }>;
  stop(taskName: string): Promise<{ ok: boolean; profile?: string }>;
}

/**
 * Injectable liveness sources. Same shape as `feed-post.ts`
 * (`input.listEntries ?? listPidSessionEntries`, feed-post.ts:119) — the
 * defaults are the real registry and the real process table, so a test can
 * substitute them without mocking a module.
 */
export interface ReapDeps {
  listEntries?: () => PidSessionEntry[];
  pidAlive?: (pid: number, startedAtMs?: number) => boolean;
  sessionIdOfPid?: (pid: number) => string | undefined;
  sessionLiveOnProcessTable?: (sessionId: string) => Promise<boolean>;
}

export interface ReapOptions {
  /** Idle window in ms. Default {@link DEFAULT_IDLE_MS}. */
  idleMs?: number;
  /** Clock, injectable for tests. Default `Date.now()`. */
  now?: number;
  /** Report what would be closed without closing anything. */
  dryRun?: boolean;
  deps?: ReapDeps;
}

/**
 * Session and launch ids belonging to a process that is alive right now.
 *
 * Built from the per-pid launch registry, filtered to live pids —
 * `isPidAlive(pid, startedAtMs)` rather than a bare existence check, so a pid
 * the OS recycled onto an unrelated process does not read as a live agent.
 * An entry with no recorded `sessionId` still contributes one when the live
 * process carries `--session-id` on its argv, which is the RUSH-2384 recovery
 * path the registry itself documents (pid-registry.ts:102-107).
 */
function liveIdentities(deps: ReapDeps): { sessions: Set<string>; launches: Set<string> } {
  const listEntries = deps.listEntries ?? listPidSessionEntries;
  const alive = deps.pidAlive ?? isPidAlive;
  const sessionIdOf = deps.sessionIdOfPid ?? sessionIdFromLivePid;

  const sessions = new Set<string>();
  const launches = new Set<string>();
  for (const entry of listEntries()) {
    if (!alive(entry.pid, entry.startedAtMs)) continue;
    const sessionId = entry.sessionId ?? sessionIdOf(entry.pid);
    if (sessionId) sessions.add(sessionId);
    if (entry.launchId) launches.add(entry.launchId);
  }
  return { sessions, launches };
}

/**
 * True when every identity the task carries says its owner is gone.
 *
 * A task with NEITHER a `sessionId` nor a `launchId` is never session-reaped —
 * there is nothing to prove dead, so it is left to the idle rule. When a task
 * carries both and only one resolves live, it counts as live: a half-resolved
 * identity is not proof of death, and the cost of being wrong here is closing a
 * working agent's tabs.
 *
 * The registry can be missing an entry for a live agent (a wrapper pid exited,
 * a prune wiped it, the agent was not launched via `agents run` —
 * pid-registry.ts:102-107), so a session the registry cannot vouch for gets a
 * second, authoritative check against the process table: a live process
 * carrying `--session-id <id>` in its argv. Only then is it called dead.
 */
async function ownerIsGone(
  task: Task,
  live: { sessions: Set<string>; launches: Set<string> },
  deps: ReapDeps,
): Promise<boolean> {
  if (!task.sessionId && !task.launchId) return false;

  if (task.launchId && live.launches.has(task.launchId)) return false;

  if (task.sessionId) {
    if (live.sessions.has(task.sessionId)) return false;
    const onProcessTable = deps.sessionLiveOnProcessTable ?? ((id: string) => isSessionIdLiveOnProcessTable(id));
    if (await onProcessTable(task.sessionId)) return false;
  }

  return true;
}

/**
 * Stop every task whose owner is gone or that has sat untouched past `idleMs`.
 *
 * Returns what it closed and how many it left alone. A task that is mid-
 * recording is always left alone: reaping it would truncate a capture the user
 * asked for, and an in-flight recording is itself proof the task is in use.
 */
export async function reapAbandonedTasks(
  service: ReapableService,
  opts: ReapOptions = {},
): Promise<ReapResult> {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const now = opts.now ?? Date.now();
  const deps = opts.deps ?? {};
  const live = liveIdentities(deps);

  const closed: ReapedTask[] = [];
  let skipped = 0;

  for (const { profile, task } of service.listTasks()) {
    if ((await service.recordStatus(task.name)).recording) {
      skipped++;
      continue;
    }

    let reason: ReapedTask['reason'] | undefined;
    if (await ownerIsGone(task, live, deps)) {
      reason = 'session-dead';
    } else if (now - (task.lastActionAt ?? task.createdAt) >= idleMs) {
      reason = 'idle';
    }

    if (!reason) {
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      closed.push({ task: task.name, profile, reason });
      continue;
    }

    const result = await service.stop(task.name);
    if (result.ok) {
      closed.push({ task: task.name, profile: result.profile ?? profile, reason });
    } else {
      // `stop` reports not-found only when the task already left the map — a
      // concurrent `done`, or a profile torn down mid-pass. Nothing was closed,
      // so it is not reported as closed.
      skipped++;
    }
  }

  return { closed, skipped };
}
