import { execFile } from 'child_process';

// Parse the output of `ps -p <pid> -o lstart=` (e.g. "Sat Jun 28 11:02:13 2026")
// into epoch milliseconds. Returns undefined when the value can't be parsed.
export function parseLstart(stdout: string): number | undefined {
  const start = Date.parse(stdout.trim());
  return Number.isNaN(start) ? undefined : start;
}

// Capture a process's start time once via a single `ps` call. Used at terminal
// registration so kill/restart correlation can compare cached start times
// instead of spawning pgrep + ps per dormant terminal on every session-file
// event (#97).
export function captureProcessStartTime(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      resolve(parseLstart(stdout));
    });
  });
}

// Pick the item with the most recent (largest) start time. Items without a
// captured start time are ignored. Returns undefined when none have one.
export function pickNewestStartTime<T extends { startTimeMs?: number }>(
  items: T[],
): T | undefined {
  let newest: { item: T; start: number } | undefined;
  for (const item of items) {
    const start = item.startTimeMs;
    if (start === undefined) continue;
    if (!newest || start > newest.start) {
      newest = { item, start };
    }
  }
  return newest?.item;
}
