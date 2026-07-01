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
import { loadTask, localLogPath } from './tasks.js';
import { followHostTask } from './progress.js';

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
    return { found: true, exitCode: code === -1 ? 1 : code };
  }

  try {
    process.stdout.write(fs.readFileSync(localLogPath(id), 'utf-8'));
  } catch {
    console.log(chalk.gray('(no local log captured for this task)'));
  }
  return { found: true, exitCode: 0 };
}
