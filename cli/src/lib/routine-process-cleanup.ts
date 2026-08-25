import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { isAlive, killTree } from './platform/index.js';
import { getRunsDir } from './state.js';
import type { RunMeta } from './scheduling/routines.js';

export interface RoutineProcessCleanupOptions {
  runsDir?: string;
  alive?: (pid: number) => boolean;
  owns?: (meta: RunMeta) => boolean;
  terminate?: (pid: number) => void;
}

function processMatchesRun(meta: RunMeta): boolean {
  if (!meta.pid || !meta.spawnedAt) return false;
  try {
    if (process.platform === 'win32') {
      const startedAt = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${meta.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")`,
      ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
      const processStart = Date.parse(startedAt);
      return Number.isFinite(processStart) && Math.abs(processStart - meta.spawnedAt) < 30_000;
    }
    const elapsed = execFileSync('ps', ['-p', String(meta.pid), '-o', 'etime='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!elapsed) return false;
    const fields = elapsed.replace(/-/g, ':').split(':').reverse();
    const seconds = Number(fields[0] ?? 0)
      + Number(fields[1] ?? 0) * 60
      + Number(fields[2] ?? 0) * 3600
      + Number(fields[3] ?? 0) * 86400;
    return Math.abs((Date.now() - seconds * 1000) - meta.spawnedAt) < 30_000;
  } catch {
    return false;
  }
}

/** Reap process groups whose durable run record is already terminal. */
export function reapTerminalRoutineProcesses(opts: RoutineProcessCleanupOptions = {}): number[] {
  const runsDir = opts.runsDir ?? getRunsDir();
  const alive = opts.alive ?? isAlive;
  const owns = opts.owns ?? processMatchesRun;
  const terminate = opts.terminate ?? ((pid: number) => killTree(process.platform === 'win32' ? pid : -pid));
  if (!fs.existsSync(runsDir)) return [];

  const reaped: number[] = [];
  for (const job of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!job.isDirectory()) continue;
    const jobDir = path.join(runsDir, job.name);
    for (const run of fs.readdirSync(jobDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(jobDir, run.name, 'meta.json'), 'utf-8'),
        ) as RunMeta;
        if (!['failed', 'timeout'].includes(meta.status) || !meta.pid || meta.hostTaskId || meta.cloudTaskId) continue;
        const completedAt = Date.parse(meta.completedAt ?? '');
        if (!Number.isFinite(completedAt) || Date.now() - completedAt < 5_000) continue;
        if (!alive(meta.pid)) continue;
        if (!owns(meta)) continue;
        terminate(meta.pid);
        reaped.push(meta.pid);
      } catch {
        // Corrupt or concurrently-replaced records are left untouched.
      }
    }
  }
  return reaped;
}
