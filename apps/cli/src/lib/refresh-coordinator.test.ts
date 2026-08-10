import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { setRefreshLockRootForTest, withRefreshLease } from './refresh-coordinator.js';

const dirs: string[] = [];

afterEach(() => {
  setRefreshLockRootForTest(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('withRefreshLease', () => {
  it('permits one collector across separate CLI processes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-refresh-process-'));
    dirs.push(dir);
    const resultPath = path.join(dir, 'result');
    const countPath = path.join(dir, 'count');
    const worker = path.join(import.meta.dirname, 'testdata', 'refresh-coordinator-worker.ts');

    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [worker, dir, resultPath, countPath, 'claude:account-a'], { stdio: 'pipe' });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
    })));

    expect(fs.readFileSync(countPath, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('publishes once when concurrent callers refresh the same account', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-refresh-lease-'));
    dirs.push(dir);
    setRefreshLockRootForTest(dir);

    let published: { capturedAt: number } | null = null;
    let calls = 0;
    const requestedAt = Date.now();
    const invoke = () => withRefreshLease({
      scope: 'usage',
      key: 'claude:account=work',
      readCompleted: () => published,
      isCompleted: (value) => value.capturedAt >= requestedAt,
      refresh: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        published = { capturedAt: Date.now() };
        return published;
      },
    });

    const results = await Promise.all([invoke(), invoke(), invoke(), invoke()]);
    expect(calls).toBe(1);
    expect(results).toEqual([published, published, published, published]);
  });

  it('does not share leases between account identities', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-refresh-lease-'));
    dirs.push(dir);
    setRefreshLockRootForTest(dir);

    let calls = 0;
    const invoke = (key: string) => withRefreshLease({
      scope: 'usage',
      key,
      readCompleted: () => null,
      isCompleted: () => false,
      refresh: async () => ({ key, call: ++calls }),
    });

    await Promise.all([invoke('claude:work'), invoke('claude:personal')]);
    expect(calls).toBe(2);
  });
});
