/**
 * Shared host-task log viewer — the show-or-follow core behind both
 * `agents hosts logs <id>` and the top-level `agents logs <id>`.
 *
 * A running task with follow re-enters the offset-tail (`followHostTask`);
 * otherwise the captured local mirror (`localLogPath`) is printed. Kept in one
 * place so the two commands can never drift.
 */

import * as fs from 'fs';
import chalk from 'chalk';
import { loadTask, localLogPath, updateTask, terminalPatch, type HostTask } from './tasks.js';
import { followHostTask } from './progress.js';
import { reconcileTask } from './reconcile.js';
import { sshExecRaw } from '../ssh-exec.js';

export interface HostLogResult {
  /** False when no host task with this id exists (caller may fall through to sessions). */
  found: boolean;
  /** Process exit code to adopt when the task was shown/followed. */
  exitCode?: number;
}

/** Show (or follow, when running) a dispatched host task's combined-stdout log. */
export async function showHostTaskLog(id: string, follow: boolean): Promise<HostLogResult> {
  const task = loadTask(id);
  if (!task) return { found: false };

  if (follow && task.status === 'running') {
    const code = await followHostTask(task.target, {
      remoteLog: task.remoteLog,
      remoteExit: task.remoteExit,
      taskId: id,
      echo: true,
    });
    // -1 = follow window closed; the run continues on the host (not a failure,
    // so exit 0). Any real code is the finished run — persist the terminal
    // status the killed dispatch follower would have written.
    if (code === -1) return { found: true, exitCode: 0 };
    updateTask(id, terminalPatch(code));
    return { found: true, exitCode: code };
  }

  // Non-follow view: heal a still-'running' record from the remote `.exit` so a
  // plain `logs <id>` also unsticks a task whose follower was killed. No-op (no
  // ssh) once the record is already terminal.
  reconcileTask(task);
  try {
    process.stdout.write(fs.readFileSync(localLogPath(id), 'utf-8'));
  } catch {
    // No local log — task was dispatched with --no-follow. Fetch from the remote
    // on demand and cache locally so subsequent calls are instant.
    const remote = fetchAndCacheRemoteLog(task);
    if (remote !== null) {
      process.stdout.write(remote);
    } else {
      process.stdout.write(chalk.gray('(no local log captured for this task)\n'));
    }
  }
  return { found: true, exitCode: 0 };
}

/**
 * Fetch a task's remote log over SSH, write it to the local mirror path (for
 * future instant reads), and return its content. Returns null when the host is
 * unreachable or the remote log is empty/absent.
 *
 * `remoteLog` is a $HOME-prefixed path with a safe (hex) basename — intentionally
 * unquoted so the remote shell expands $HOME, matching the contract in reconcile.ts
 * and progress.ts.
 */
function fetchAndCacheRemoteLog(task: HostTask): Buffer | null {
  const res = sshExecRaw(task.target, `cat ${task.remoteLog} 2>/dev/null`, { timeoutMs: 30000, multiplex: true });
  if (res.code !== 0 || res.stdout.length === 0) return null;
  // The hosts cache dir already exists (saveTask created it) — write is best-effort.
  try { fs.writeFileSync(localLogPath(task.id), res.stdout); } catch { /* best-effort cache */ }
  return res.stdout;
}
