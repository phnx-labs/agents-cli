import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readClaudeUsageCache, type CachedUsageSnapshot } from './usage.js';
import {
  consumeUsageSnapshotsFromSharedStore,
  publishUsageSnapshotToSharedStore,
} from './usage-sync.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function row(capturedAt: string, usedPercent: number): CachedUsageSnapshot {
  return {
    capturedAt,
    windows: [{ key: 'five_hour', label: 'Session', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 }],
  };
}

function seed(file: string, rows: Record<string, CachedUsageSnapshot>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows), 'utf-8');
}

describe('usage sync through the real fleet-shared file path', () => {
  it('publishes once on a headed device and a worker reads it without SSH', async () => {
    const root = tempDir();
    const sourceCache = path.join(root, 'source-cache.json');
    const workerCache = path.join(root, 'worker-cache.json');
    seed(sourceCache, { 'claude:org=alpha': row('2026-08-30T20:00:00.000Z', 64) });

    const published = await publishUsageSnapshotToSharedStore({
      userAgentsDir: root,
      cachePath: sourceCache,
      role: 'personal',
      device: 'zion',
    });
    expect(published).toMatchObject({ published: true, changed: true, error: null });

    const consumed = consumeUsageSnapshotsFromSharedStore({
      userAgentsDir: root,
      cachePath: workerCache,
      role: 'worker',
      device: 'worker-a',
      roles: { zion: 'personal', 'worker-a': 'worker' },
    });
    expect(consumed).toEqual({ sources: ['zion'], merged: 1, skipped: null, errors: [] });
    expect(readClaudeUsageCache('claude:org=alpha', workerCache, new Date('2026-08-30T20:01:00.000Z'))?.windows[0].usedPercent).toBe(64);
  });

  it('chooses the newest identity row across multiple headed snapshots', async () => {
    const root = tempDir();
    const workerCache = path.join(root, 'worker-cache.json');
    for (const [device, role, snapshot] of [
      ['laptop', 'personal', row('2026-08-30T20:00:00.000Z', 25)],
      ['desktop', 'desktop', row('2026-08-30T20:05:00.000Z', 80)],
    ] as const) {
      const source = path.join(root, `${device}.json`);
      seed(source, { 'claude:org=alpha': snapshot });
      await publishUsageSnapshotToSharedStore({ userAgentsDir: root, cachePath: source, role, device });
    }

    const consumed = consumeUsageSnapshotsFromSharedStore({
      userAgentsDir: root,
      cachePath: workerCache,
      role: 'worker',
      device: 'worker-a',
      roles: { laptop: 'personal', desktop: 'desktop', 'worker-a': 'worker' },
    });
    expect(consumed.sources).toEqual(['desktop', 'laptop']);
    expect(consumed.merged).toBe(1);
    expect(readClaudeUsageCache('claude:org=alpha', workerCache, new Date('2026-08-30T20:06:00.000Z'))?.windows[0].usedPercent).toBe(80);
  });

  it('does not publish from a worker or consume on a headed device', async () => {
    const root = tempDir();
    const cache = path.join(root, 'cache.json');
    seed(cache, { 'claude:org=alpha': row('2026-08-30T20:00:00.000Z', 10) });
    expect((await publishUsageSnapshotToSharedStore({ userAgentsDir: root, cachePath: cache, role: 'worker', device: 'worker-a' })).skipped)
      .toContain('not a usage publisher');
    expect(consumeUsageSnapshotsFromSharedStore({ userAgentsDir: root, cachePath: cache, role: 'desktop', device: 'desktop' }).skipped)
      .toBe('this device is not a worker');
    expect(fs.existsSync(path.join(root, 'devices'))).toBe(false);
  });

  it('surfaces a malformed peer independently while consuming valid peers', async () => {
    const root = tempDir();
    const source = path.join(root, 'source.json');
    const worker = path.join(root, 'worker.json');
    seed(source, { 'claude:org=alpha': row('2026-08-30T20:00:00.000Z', 35) });
    await publishUsageSnapshotToSharedStore({ userAgentsDir: root, cachePath: source, role: 'personal', device: 'zion' });
    const malformedDir = path.join(root, 'devices', 'broken');
    fs.mkdirSync(malformedDir, { recursive: true });
    fs.writeFileSync(path.join(malformedDir, 'daemon-state.json'), '{broken', 'utf-8');

    const consumed = consumeUsageSnapshotsFromSharedStore({
      userAgentsDir: root,
      cachePath: worker,
      role: 'worker',
      device: 'worker-a',
      roles: { zion: 'personal', broken: 'personal' },
    });
    expect(consumed.merged).toBe(1);
    expect(consumed.errors).toEqual([{ device: 'broken', message: expect.stringContaining('JSON') }]);
  });
});
