import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FirecrackerPool } from './firecracker';
import { ciLayout } from './paths';

describe('FirecrackerPool', () => {
  test('restores a warm snapshot once and refuses reuse after start or destroy', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-fc-'));
    try {
      const layout = ciLayout(root);
      const work = join(root, 'work');
      const cache = join(root, 'cache');
      mkdirSync(work, { recursive: true });
      mkdirSync(cache, { recursive: true });
      const pool = new FirecrackerPool(layout);
      const vm = pool.restore('job-1', [
        { source: work, target: '/work', writable: true },
        { source: cache, target: '/cache', writable: false },
      ]);
      expect(vm.snapshot).toContain('snapshots/warm');
      pool.start('job-1');
      expect(() => pool.start('job-1')).toThrow(/one-use and already started/);
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
    const root = mkdtempSync(join(tmpdir(), 'ci-fc-'));
    try {
      const layout = ciLayout(root);
      const work = join(root, 'work');
      mkdirSync(work, { recursive: true });
      const pool = new FirecrackerPool(layout);
      expect(() => pool.restore('bad-cache', [
        { source: work, target: '/work', writable: true },
        { source: work, target: '/cache', writable: true },
      ])).toThrow(/cache mounts must be read-only|exactly one writable/);
      expect(() => pool.restore('docker', [
        { source: '/var/run/docker.sock', target: '/var/run/docker.sock', writable: true },
      ])).toThrow(/docker.sock|exactly one writable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
