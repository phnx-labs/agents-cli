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
import { loadTask, localLogPath, updateTask, terminalPatch } from './tasks.js';
import { followHostTask } from './progress.js';
import { reconcileTask } from './reconcile.js';

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
    console.log(chalk.gray('(no local log captured for this task)'));
  }
  return { found: true, exitCode: 0 };
}
