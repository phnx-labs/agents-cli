/**
 * Reconcile a local host-task record against the remote run's ground truth.
 *
 * A detached `--host` run outlives the local follower: it keeps running and
 * writes its exit code to `<id>.exit` on the host even if the laptop sleeps or
 * the SSH connection drops mid-follow. When that happens the local record is
 * left at `status:'running'` forever, because the only path that finalizes it
 * (dispatch's post-follow `updateTask`) never runs. This module re-reads the
 * remote `.exit` on demand — from `agents hosts ps` / `logs` — and heals the
 * record. We only ever CONFIRM completion; an unreachable host or an absent
 * `.exit` leaves the record `running` (we never guess failure).
 */

import { sshExec, sshReachable, type SshExecResult } from '../ssh-exec.js';
import { updateTask, terminalPatch, type HostTask } from './tasks.js';

export type RemoteExitState =
  | { state: 'running' } //     .exit absent, or present-but-empty (mid-write) → not finished
  | { state: 'done'; code: number } // .exit holds an exit code → finished
  | { state: 'unreachable' }; //  ssh itself failed → can't tell, don't touch the record

/**
 * Classify a `cat <remoteExit>` result into a remote run state. Pure: all the
 * bug-prone branching (ssh-failure vs absent vs empty vs coded) lives here so it
 * can be unit-tested without a live host. ssh's own connection failure surfaces
 * as code 255, a spawn error/timeout as `code === null`; neither is the remote
 * command's exit and both mean "unreachable". An empty read is "still running"
 * (the `.exit` is written only after the run ends, so absent `cat` → exit 1 →
 * empty stdout, and a truncate-then-write mid-race is a sub-ms empty window).
 */
export function classifyExit(res: Pick<SshExecResult, 'code' | 'stdout' | 'timedOut'>): RemoteExitState {
  if (res.timedOut || res.code === null || res.code === 255) return { state: 'unreachable' };
  const out = res.stdout.trim();
  if (out === '') return { state: 'running' };
  const code = parseInt(out, 10);
  return { state: 'done', code: Number.isFinite(code) ? code : 0 };
}

/**
 * Read a task's remote `.exit` over ssh and classify it. `remoteExit` is a
 * $HOME-prefixed path with a safe (hex) basename — intentionally unquoted so the
 * remote shell expands $HOME (same contract as progress.ts's fetch).
 */
export function readRemoteExit(target: string, remoteExit: string, timeoutMs = 6000): RemoteExitState {
  return classifyExit(sshExec(target, `cat ${remoteExit} 2>/dev/null`, { timeoutMs, multiplex: true }));
}

/**
 * Heal one record. Terminal records are immutable (and never re-probed); a
 * `running` record is resolved to completed/failed only when the remote `.exit`
 * holds a code. Returns the (possibly updated) task.
 */
export function reconcileTask(task: HostTask): HostTask {
  if (task.status !== 'running') return task;
  const st = readRemoteExit(task.target, task.remoteExit);
  if (st.state !== 'done') return task;
  return updateTask(task.id, terminalPatch(st.code)) ?? task;
}

/**
 * Heal a list of records for a listing (`agents hosts ps`). Only `running` tasks
 * are probed; each host is reachability-checked ONCE (deduped by target) so a
 * down host costs a single short timeout instead of one per task, and its tasks
 * are left `running` rather than falsely failed. Sequential by design — with the
 * shared ssh control socket the live-host reads are sub-100ms, and a parallel
 * (async) ssh path is deliberately out of scope.
 */
export function reconcileRunningTasks(tasks: HostTask[]): HostTask[] {
  const running = tasks.filter((t) => t.status === 'running');
  if (running.length === 0) return tasks;

  const reachable = new Map<string, boolean>();
  const patched = new Map<string, HostTask>();
  for (const t of running) {
    if (!reachable.has(t.target)) reachable.set(t.target, sshReachable(t.target, 6000));
    if (!reachable.get(t.target)) continue; // host down → leave running
    const st = readRemoteExit(t.target, t.remoteExit);
    if (st.state === 'done') {
      const updated = updateTask(t.id, terminalPatch(st.code));
      if (updated) patched.set(t.id, updated);
    }
  }
  return tasks.map((t) => patched.get(t.id) ?? t);
}
