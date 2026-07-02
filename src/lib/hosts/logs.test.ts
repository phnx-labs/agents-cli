import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';

// Redirect the cache dir to a temp tree (real fs, no service mocking) so we can
// stage real task sidecars + log files the way a dispatch would.
let CACHE_ROOT: string;
vi.spyOn(state, 'getCacheDir').mockImplementation(() => CACHE_ROOT);

import { showHostTaskLog } from './logs.js';
import { saveTask, localLogPath, type HostTask } from './tasks.js';

function makeTask(overrides: Partial<HostTask> = {}): HostTask {
  return {
    id: 'abc12345',
    host: 'box',
    target: 'user@box',
    agent: 'claude',
    prompt: 'do a thing',
    remoteLog: '$HOME/.agents/.cache/hosts/abc12345.log',
    remoteExit: '$HOME/.agents/.cache/hosts/abc12345.exit',
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

let out: string;
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  CACHE_ROOT = mkdtempSync(join(tmpdir(), 'agents-cli-hostlogs-'));
  mkdirSync(join(CACHE_ROOT, 'hosts'), { recursive: true });
  out = '';
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  rmSync(CACHE_ROOT, { recursive: true, force: true });
});

describe('showHostTaskLog', () => {
  it('returns found:false for an unknown id (so callers can fall through to sessions)', async () => {
    const res = await showHostTaskLog('nope-not-a-task', false);
    expect(res.found).toBe(false);
    expect(res.exitCode).toBeUndefined();
    expect(out).toBe('');
  });

  it('prints the captured local log for a finished task and reports exit 0', async () => {
    const task = makeTask();
    saveTask(task);
    writeFileSync(localLogPath(task.id), 'PONG\n');

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(out).toBe('PONG\n');
  });

  it('found:true with a friendly note when the task exists but no log was captured', async () => {
    const task = makeTask({ id: 'nolog001' });
    saveTask(task);
    // No log file written.

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it('does NOT follow (no SSH) a finished task even when follow is requested', async () => {
    // status !== 'running' → the follow branch is skipped, so no sshExec fires.
    const task = makeTask({ id: 'done0001', status: 'completed' });
    saveTask(task);
    writeFileSync(localLogPath(task.id), 'final output\n');

    const res = await showHostTaskLog(task.id, true);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(out).toBe('final output\n');
  });
});
