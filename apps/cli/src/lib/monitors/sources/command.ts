/**
 * Command / poll source evaluator.
 *
 * Runs a shell command; its stdout is the observation. `poll` re-runs the same
 * command on an interval — the evaluation is identical, so poll.ts delegates
 * here. No agent, no sandbox: a plain `/bin/sh -c` (or `cmd /c` on Windows).
 */

import { execFile } from 'child_process';
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Run the source command and return its combined stdout as the observation. */
export function evaluate(source: MonitorSource): Promise<Observation | null> {
  const command = source.command;
  if (!command) return Promise.resolve(null);

  const [bin, args] = process.platform === 'win32'
    ? ['cmd', ['/c', command]]
    : ['/bin/sh', ['-c', command]];

  return new Promise<Observation | null>((resolve) => {
    execFile(
      bin as string,
      args as string[],
      { encoding: 'utf-8', timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const exitCode = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
        // A non-zero exit is still a real observation (the diff might be exactly
        // "command started failing"); surface stderr when stdout is empty.
        const raw = (stdout && stdout.length > 0 ? stdout : stderr ?? '').replace(/\s+$/, '');
        resolve({ raw, meta: { exitCode } });
      },
    );
  });
}
