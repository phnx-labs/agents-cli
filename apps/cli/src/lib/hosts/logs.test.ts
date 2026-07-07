import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';
import { sshReachable } from '../ssh-exec.js';

// Redirect the cache dir to a temp tree (real fs, no service mocking) so we can
// stage real task sidecars + log files the way a dispatch would.
// Initialized eagerly (not just in beforeEach) so the module-load LOCALHOST_SSH
// probe below sees a valid dir for ssh's control socket.
let CACHE_ROOT: string = mkdtempSync(join(tmpdir(), 'agents-cli-hostlogs-boot-'));
vi.spyOn(state, 'getCacheDir').mockImplementation(() => CACHE_ROOT);

import { showHostTaskLog } from './logs.js';
import { saveTask, localLogPath, type HostTask } from './tasks.js';

// Gate real-SSH tests on localhost being reachable so they pass on dev machines
// and self-hosted runners, but skip cleanly in hosted CI without SSH access.
const LOCALHOST_SSH = sshReachable('localhost', 5000);

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
  // ssh's control-socket dir lives under getCacheDir(); ssh-exec only ensures it
  // once (module-level flag), so with a fresh cache dir per test we must create
  // it ourselves or multiplexed ssh can't open its socket and reports 255.
  mkdirSync(join(CACHE_ROOT, 'ssh'), { recursive: true, mode: 0o700 });
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

// Detached-dispatch log retrieval over real ssh (localhost). The literal bug
// closed by this PR: a --no-follow dispatch captured no local log, so
// `agents hosts logs <id>` always printed "(no local log captured for this task)".
// These tests drive a real `ssh localhost cat <file>` through showHostTaskLog to
// confirm the remote-fetch path works end-to-end.
describe.skipIf(!LOCALHOST_SSH)('detached-run log fetch over real ssh (localhost)', () => {
  it('fetches and prints the remote log when no local log exists (detached dispatch)', async () => {
    // Simulate a detached dispatch: task sidecar exists, local log does NOT, but
    // the remote log (a real local file we point at via ssh localhost) has content.
    const remoteLogFile = join(CACHE_ROOT, 'remote-abc00001.log');
    writeFileSync(remoteLogFile, 'detached run output\n');

    const task = makeTask({ id: 'abc00001', target: 'localhost', remoteLog: remoteLogFile });
    saveTask(task);
    // No writeFileSync(localLogPath(task.id), …) — intentionally absent.

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(out).toBe('detached run output\n');
  });

  it('caches the fetched log locally so subsequent calls read it from disk (no SSH)', async () => {
    const remoteLogFile = join(CACHE_ROOT, 'remote-abc00002.log');
    writeFileSync(remoteLogFile, 'cached output\n');

    const task = makeTask({ id: 'abc00002', target: 'localhost', remoteLog: remoteLogFile });
    saveTask(task);

    await showHostTaskLog(task.id, false);

    // After the first fetch the local mirror must exist.
    expect(existsSync(localLogPath(task.id))).toBe(true);
  });

  it('still shows the no-log note when the remote log is also absent', async () => {
    // console.log routes through process.stdout.write, which writeSpy intercepts.
    const task = makeTask({
      id: 'abc00003',
      target: 'localhost',
      remoteLog: join(CACHE_ROOT, 'nonexistent.log'),
    });
    saveTask(task);

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(out).toContain('no local log');
  });
});
