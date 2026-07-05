/**
 * Local record of dispatched host tasks.
 *
 * Each dispatch writes a `<id>.json` sidecar next to its `<id>.log` (and the
 * remote's `<id>.exit`) under ~/.agents/.cache/hosts/, so `agents hosts ps/logs`
 * can list runs and follow output across CLI invocations. (Folding these into
 * the cloud SQLite store so `agents cloud ps` sees them is a fast-follow — it
 * needs care around the cloud status-refresh path.)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../state.js';

export type HostTaskStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface HostTask {
  id: string;
  host: string;
  target: string;
  agent: string;
  prompt: string;
  pid?: number;
  /**
   * The agent session id the remote run was launched with (Claude only — the
   * only agent that accepts `--session-id` to force a NEW session's id). Lets
   * `agents sessions`/resume-by-id map a discovered session back to the host it
   * lives on. Absent for agents that don't take an explicit session id.
   */
  sessionId?: string;
  /** Remote paths (under the host's ~/.agents/.cache/hosts/). */
  remoteLog: string;
  remoteExit: string;
  status: HostTaskStatus;
  exitCode?: number;
  createdAt: string;
  finishedAt?: string;
}

export function hostsCacheDir(): string {
  return path.join(getCacheDir(), 'hosts');
}

function taskFile(id: string): string {
  return path.join(hostsCacheDir(), `${id}.json`);
}

/** Local path we mirror a task's remote log into while following. */
export function localLogPath(id: string): string {
  return path.join(hostsCacheDir(), `${id}.log`);
}

export function saveTask(task: HostTask): void {
  fs.mkdirSync(hostsCacheDir(), { recursive: true });
  fs.writeFileSync(taskFile(task.id), JSON.stringify(task, null, 2));
}

export function loadTask(id: string): HostTask | null {
  try {
    return JSON.parse(fs.readFileSync(taskFile(id), 'utf-8')) as HostTask;
  } catch {
    return null;
  }
}

export function updateTask(id: string, patch: Partial<HostTask>): HostTask | null {
  const task = loadTask(id);
  if (!task) return null;
  const next = { ...task, ...patch };
  saveTask(next);
  return next;
}

/**
 * The record patch for a run that has finished with `code`. The single authority
 * for the exit-code → status mapping, so the dispatch, reconcile, and log-follow
 * paths can never disagree. A genuine remote exit code is never -1 (that sentinel
 * means "follow window closed while the run continues"), so callers must resolve
 * -1 as still-running and never pass it here.
 */
export function terminalPatch(code: number): Partial<HostTask> {
  return {
    status: code === 0 ? 'completed' : 'failed',
    exitCode: code,
    finishedAt: new Date().toISOString(),
  };
}

export function listTasks(): HostTask[] {
  let files: string[];
  try {
    files = fs.readdirSync(hostsCacheDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const tasks: HostTask[] = [];
  for (const f of files) {
    const task = loadTask(f.replace(/\.json$/, ''));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Find the host task that launched a given agent session id, so a resume-by-id
 * can re-dispatch to the host the session actually lives on. Newest task wins
 * (listTasks is createdAt-desc) — a session id should be unique, but a re-run
 * with the same forced id resolves to the most recent dispatch.
 */
export function findTaskBySessionId(sessionId: string): HostTask | null {
  if (!sessionId) return null;
  for (const task of listTasks()) {
    if (task.sessionId === sessionId) return task;
  }
  return null;
}
