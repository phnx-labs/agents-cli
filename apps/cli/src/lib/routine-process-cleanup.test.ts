import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { reapTerminalRoutineProcesses } from './routine-process-cleanup.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeRun(root: string, name: string, status: string, pid: number, completedAt?: string): void {
  const dir = path.join(root, 'job', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    runId: name,
    jobName: 'job',
    status,
    pid,
    startedAt: new Date().toISOString(),
    completedAt: status === 'running' ? null : completedAt ?? new Date(Date.now() - 10_000).toISOString(),
    exitCode: status === 'failed' ? 1 : null,
  }));
}

describe('terminal routine process cleanup', () => {
  it('terminates a live failed process group and leaves running records alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-cleanup-'));
    dirs.push(root);
    writeRun(root, 'failed', 'failed', 101);
    writeRun(root, 'timeout', 'timeout', 102);
    writeRun(root, 'completed', 'completed', 103);
    const terminated: number[] = [];

    expect(reapTerminalRoutineProcesses({
      runsDir: root,
      alive: () => true,
      owns: () => true,
      terminate: (pid) => terminated.push(pid),
    })).toEqual([101, 102]);
    expect(terminated).toEqual([101, 102]);
  });

  it('gives a newly terminal process five seconds to exit itself', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-cleanup-'));
    dirs.push(root);
    writeRun(root, 'failed', 'failed', 104, new Date().toISOString());
    expect(reapTerminalRoutineProcesses({
      runsDir: root,
      alive: () => true,
      owns: () => true,
      terminate: () => { throw new Error('must not terminate during grace'); },
    })).toEqual([]);
  });

  it('does not signal a terminal record whose pid is no longer live', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-cleanup-'));
    dirs.push(root);
    writeRun(root, 'failed', 'failed', 103);
    const terminated: number[] = [];
    expect(reapTerminalRoutineProcesses({
      runsDir: root,
      alive: () => false,
      owns: () => true,
      terminate: (pid) => terminated.push(pid),
    })).toEqual([]);
    expect(terminated).toEqual([]);
  });
});
