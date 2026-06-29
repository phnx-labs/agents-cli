/**
 * Follow a dispatched host run by offset-tailing its remote log.
 *
 * The run writes combined output to a log file on the host and its exit code to
 * a sibling `.exit` file. We poll `tail -c +<offset>` (durable, offset-tracked —
 * a dropped connection resumes from the saved offset) and finish when `.exit`
 * appears. Rich transcript-parser rendering is a fast-follow.
 */

import * as fs from 'fs';
import { sshExec } from '../ssh-exec.js';
import { localLogPath } from './tasks.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FollowOptions {
  remoteLog: string;
  remoteExit: string;
  /** Mirror remote output into this task's local log too. */
  taskId: string;
  /** Print streamed output to stdout. */
  echo?: boolean;
  /** Overall wall-clock cap; returns -1 on timeout. */
  timeoutMs?: number;
  pollMs?: number;
}

/** Tail the remote log to stdout until the run finishes; return its exit code. */
export async function followHostTask(target: string, opts: FollowOptions): Promise<number> {
  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 3600_000);
  const local = localLogPath(opts.taskId);
  let offset = 0;

  const drain = (): void => {
    // remoteLog is a $HOME-prefixed path with a safe (hex) basename — intentionally
    // unquoted so the remote shell expands $HOME.
    const chunk = sshExec(target, `tail -c +${offset + 1} ${opts.remoteLog} 2>/dev/null`, { timeoutMs: 20000 });
    if (chunk.stdout) {
      if (opts.echo) process.stdout.write(chunk.stdout);
      try { fs.appendFileSync(local, chunk.stdout); } catch { /* best-effort */ }
      offset += Buffer.byteLength(chunk.stdout, 'utf8');
    }
  };

  for (;;) {
    drain();
    const exit = sshExec(target, `cat ${opts.remoteExit} 2>/dev/null`, { timeoutMs: 12000 });
    if (exit.code === 0 && exit.stdout.trim() !== '') {
      drain(); // final flush
      const code = parseInt(exit.stdout.trim(), 10);
      return Number.isFinite(code) ? code : 0;
    }
    if (Date.now() > deadline) {
      process.stderr.write('\n[hosts] follow timed out; the run continues on the host. Reattach with: agents hosts logs ' + opts.taskId + ' -f\n');
      return -1;
    }
    await sleep(pollMs);
  }
}
