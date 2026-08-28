import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';

import {
  planUsagePush,
  pullUsageFromPrimary,
  syncFleetUsageSnapshots,
  type UsagePushTarget,
  type UsageSyncDeps,
} from './usage-sync.js';
import type { DeviceProfile } from '../devices/registry.js';
import {
  exportClaudeUsageCacheRows,
  ingestPeerClaudeUsageRows,
  readClaudeUsageCache,
  writeClaudeUsageCache,
  type CachedUsageSnapshot,
} from './usage.js';

// The planner is pure (roles/reachability injected) so every skip/push branch is
// covered with no SSH; the driver test injects a fake push to assert routing.

const TARGETS: UsagePushTarget[] = [
  { name: 'yosemite-s0', role: 'worker', online: true, pinned: true },
  { name: 'yosemite-s1', role: undefined, online: true, pinned: true }, // unmarked = consumer
  { name: 'mac-mini', role: 'desktop', online: true, pinned: true }, // headed = skip
  { name: 'zion', role: 'personal', online: true, pinned: true }, // headed = skip
  { name: 'offline-box', role: 'worker', online: false, pinned: true },
  { name: 'unpinned-box', role: 'worker', online: true, pinned: false },
];

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pushesOf(items: ReturnType<typeof planUsagePush>): string[] {
  return items.filter((i) => i.action === 'push').map((i) => i.device);
}
function skipReason(items: ReturnType<typeof planUsagePush>, name: string): string | undefined {
  const item = items.find((i) => i.device === name);
  return item && item.action === 'skip' ? item.reason : undefined;
}

describe('planUsagePush', () => {
  it('a non-publisher (worker/unmarked self) pushes to nobody', () => {
    const plan = planUsagePush(false, true, TARGETS);
    expect(pushesOf(plan)).toEqual([]);
    expect(skipReason(plan, 'yosemite-s0')).toMatch(/not a usage publisher/);
  });

  it('a publisher with no local rows pushes to nobody', () => {
    const plan = planUsagePush(true, false, TARGETS);
    expect(pushesOf(plan)).toEqual([]);
    expect(skipReason(plan, 'yosemite-s0')).toMatch(/no local usage snapshot/);
  });

  it('a publisher pushes to reachable+pinned non-headed peers only', () => {
    const plan = planUsagePush(true, true, TARGETS);
    expect(pushesOf(plan)).toEqual(['yosemite-s0', 'yosemite-s1']);
    expect(skipReason(plan, 'mac-mini')).toMatch(/headed peer/);
    expect(skipReason(plan, 'zion')).toMatch(/headed peer/);
    expect(skipReason(plan, 'offline-box')).toBe('offline');
    expect(skipReason(plan, 'unpinned-box')).toMatch(/host key not pinned/);
  });
});

describe('syncFleetUsageSnapshots (driver, injected deps)', () => {
  const devices: DeviceProfile[] = [
    { name: 'zion', tailscale: { online: true } } as DeviceProfile,
    { name: 'yosemite-s0', tailscale: { online: true } } as DeviceProfile,
    { name: 'yosemite-s1', tailscale: { online: true } } as DeviceProfile,
  ];
  const rows: Record<string, CachedUsageSnapshot> = {
    'claude:org=alpha': { capturedAt: '2026-08-28T12:00:00.000Z', windows: [{ key: 'five_hour' as any, label: 'S', shortLabel: 'S', usedPercent: 5, resetsAt: null, windowMinutes: 300 }] },
  };

  function baseDeps(overrides: Partial<UsageSyncDeps> = {}): UsageSyncDeps {
    return {
      selfRole: () => 'personal',
      listDevices: () => devices,
      listRoles: () => ({ zion: 'personal', 'yosemite-s0': 'worker', 'yosemite-s1': 'worker' }),
      localName: () => 'zion',
      isPinned: () => true,
      exportRows: () => rows,
      ...overrides,
    };
  }

  it('a personal self pushes the snapshot to the two workers and skips itself', () => {
    const seen: Array<{ device: string; payload: string }> = [];
    const result = syncFleetUsageSnapshots(baseDeps({
      // roles come from the fleet config in production; here both non-self boxes
      // are unmarked (consumers), so both receive.
      push: (device, payload) => { seen.push({ device: device.name, payload }); return { ok: true }; },
    }));
    expect(result.pushed.sort()).toEqual(['yosemite-s0', 'yosemite-s1']);
    expect(seen.map((s) => s.device).sort()).toEqual(['yosemite-s0', 'yosemite-s1']);
    // Payload is the versioned envelope carrying the exported rows.
    expect(JSON.parse(seen[0].payload)).toMatchObject({ v: 1, rows });
    // zion (self) is never a target.
    expect(result.pushed).not.toContain('zion');
  });

  it('a worker self is not a publisher — pushes nothing', () => {
    const result = syncFleetUsageSnapshots(baseDeps({ selfRole: () => 'worker' }));
    expect(result.pushed).toEqual([]);
    expect(result.skipped.every((s) => /not a usage publisher/.test(s.reason))).toBe(true);
  });

  it('records a per-peer push failure without aborting the rest', () => {
    const result = syncFleetUsageSnapshots(baseDeps({
      push: (device) => device.name === 'yosemite-s0' ? { ok: false, message: 'timed out' } : { ok: true },
    }));
    expect(result.pushed).toEqual(['yosemite-s1']);
    expect(result.errors).toEqual([{ device: 'yosemite-s0', message: 'timed out' }]);
  });

  it('empty local cache short-circuits — nobody is pushed to', () => {
    const result = syncFleetUsageSnapshots(baseDeps({ exportRows: () => ({}) }));
    expect(result.pushed).toEqual([]);
    expect(result.skipped.every((s) => /no local usage snapshot/.test(s.reason))).toBe(true);
  });
});

describe('pullUsageFromPrimary', () => {
  it('pulls a 7d-100% primary row through the real cache export and ingest path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-usage-pull-'));
    tempDirs.push(dir);
    const primaryCache = join(dir, 'primary.json');
    const workerCache = join(dir, 'worker.json');
    const capturedAt = new Date();
    const resetsAt = new Date(capturedAt.getTime() + 7 * 24 * 60 * 60_000);
    const usageKey = 'claude:org=alpha';
    writeClaudeUsageCache(usageKey, {
      source: 'api',
      sourceLabel: 'Anthropic',
      capturedAt,
      windows: [{
        key: 'week' as any,
        label: 'Weekly',
        shortLabel: 'W',
        usedPercent: 100,
        resetsAt,
        windowMinutes: 7 * 24 * 60,
      }],
      plan: null,
      refreshHint: null,
    }, primaryCache);

    const primary = { name: 'zion', tailscale: { online: true } } as DeviceProfile;
    const result = pullUsageFromPrimary({
      selfRole: () => 'worker',
      listDevices: () => [primary],
      listRoles: () => ({ zion: 'personal' }),
      isPinned: () => true,
      exportRows: () => exportClaudeUsageCacheRows(workerCache),
      readRow: (key) => readClaudeUsageCache(key, workerCache),
      pull: () => ({
        ok: true,
        stdout: JSON.stringify({ v: 1, rows: exportClaudeUsageCacheRows(primaryCache) }),
      }),
      ingestRows: (rows) => ingestPeerClaudeUsageRows(rows, workerCache),
    });

    expect(result).toEqual({ pulledFrom: 'zion', merged: 1, skipped: null, error: null });
    expect(exportClaudeUsageCacheRows(workerCache)[usageKey]).toMatchObject({
      capturedAt: capturedAt.toISOString(),
      windows: [{ key: 'week', usedPercent: 100, windowMinutes: 7 * 24 * 60 }],
    });
  });

  it('does not cross the ssh boundary when the worker cache is fresh', () => {
    const rows: Record<string, CachedUsageSnapshot> = {
      'claude:org=alpha': {
        capturedAt: new Date().toISOString(),
        windows: [{ key: 'week' as any, label: 'Weekly', shortLabel: 'W', usedPercent: 10, resetsAt: null, windowMinutes: 7 * 24 * 60 }],
      },
    };
    let pulled = false;
    const result = pullUsageFromPrimary({
      selfRole: () => 'worker',
      exportRows: () => rows,
      readRow: () => ({ windows: [{} as any] }),
      pull: () => { pulled = true; return { ok: true, stdout: '' }; },
    });
    expect(result.skipped).toBe('local usage cache is fresh');
    expect(pulled).toBe(false);
  });

  it('fails loud when the primary returns a non-protocol response', () => {
    const primary = { name: 'zion', tailscale: { online: true } } as DeviceProfile;
    const result = pullUsageFromPrimary({
      selfRole: () => 'worker',
      listDevices: () => [primary],
      listRoles: () => ({ zion: 'personal' }),
      isPinned: () => true,
      exportRows: () => ({}),
      pull: () => ({ ok: true, stdout: 'login banner' }),
    });
    expect(result.error).toBe('primary returned malformed JSON');
  });
});
