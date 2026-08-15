import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FirecrackerPool, resolveFirecrackerBin } from './firecracker';
import { ciLayout } from './paths';
import { useTestFirecracker } from './test-repo';

describe('FirecrackerPool', () => {
  test('refuses to run on the host when firecracker is missing', () => {
    const prev = process.env.FIRECRACKER_BIN;
    delete process.env.FIRECRACKER_BIN;
    const path = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      expect(() => resolveFirecrackerBin()).toThrow(/firecracker binary not found/);
    } finally {
      process.env.PATH = path;
      if (prev) process.env.FIRECRACKER_BIN = prev;
    }
  });

  test('restores a warm snapshot once and execs the binary; refuses reuse', () => {
    useTestFirecracker();
    const root = mkdtempSync(join(tmpdir(), 'ci-fc-'));
    try {
      const layout = ciLayout(root);
      const work = join(root, 'work');
      const cache = join(root, 'cache');
      mkdirSync(work, { recursive: true });
      mkdirSync(cache, { recursive: true });
      const pool = new FirecrackerPool(layout);
      pool.restore('job-1', [
        { source: work, target: '/work', writable: true },
        { source: cache, target: '/cache', writable: false },
      ]);
      const started = pool.start('job-1', {
        command: ['/bin/echo', 'from-vm'],
        cwd: work,
        env: { PATH: '/bin', HOME: work, LANG: 'C', CI: '1' },
      });
      expect(started.started).toBe(true);
      expect(started.exitCode).toBe(0);
      expect(pool.logs('job-1').stdout).toContain('from-vm');
      expect(() => pool.start('job-1', {
        command: ['true'],
        cwd: work,
        env: { PATH: '/bin' },
      })).toThrow(/one-use and already started/);
      expect(() => pool.restore('job-1', [
        { source: work, target: '/work', writable: true },
      ])).toThrow(/cannot be restored twice/);
      pool.destroy('job-1');
      expect(pool.exists('job-1')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses a writable cache mount or a host docker socket', () => {
    useTestFirecracker();
    const root = mkdtempSync(join(tmpdir(), 'ci-fc-'));
    try {
      const layout = ciLayout(root);
      const work = join(root, 'work');
      mkdirSync(work, { recursive: true });
      const pool = new FirecrackerPool(layout);
      expect(() => pool.restore('bad-cache', [
        { source: work, target: '/work', writable: true },
        { source: work, target: '/cache', writable: true },
      ])).toThrow(/cache mounts must be read-only/);
      expect(() => pool.restore('docker', [
        { source: '/var/run/docker.sock', target: '/var/run/docker.sock', writable: true },
      ])).toThrow(/docker.sock/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
