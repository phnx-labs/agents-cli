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
