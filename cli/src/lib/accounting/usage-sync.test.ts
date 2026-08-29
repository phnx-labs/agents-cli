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

  it('does not cross the ssh boundary when every local row is recent', () => {
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
      pull: () => { pulled = true; return { ok: true, stdout: '' }; },
    });
    expect(result.skipped).toBe('local usage cache is fresh');
    expect(pulled).toBe(false);
  });

  it('pulls when a local row is stale even though its window count is unchanged', () => {
    // Regression for the dead freshness gate: the old check compared the cache
    // to itself on window COUNT, so a non-empty worker cache skipped the pull
    // forever and served a days-old snapshot. Now a row older than
    // USAGE_SYNC_MAX_AGE_MS must trigger a pull regardless of its shape.
    const now = Date.UTC(2026, 7, 29, 12, 0, 0);
    const staleAt = new Date(now - 4 * 24 * 60 * 60_000).toISOString(); // 4 days old
    const rows: Record<string, CachedUsageSnapshot> = {
      'claude:org=alpha': {
        capturedAt: staleAt,
        windows: [{ key: 'week' as any, label: 'Weekly', shortLabel: 'W', usedPercent: 45, resetsAt: null, windowMinutes: 7 * 24 * 60 }],
      },
    };
    let pulled = false;
    const result = pullUsageFromPrimary({
      selfRole: () => 'worker',
      now: () => now,
      exportRows: () => rows,
      listDevices: () => [{ name: 'zion', tailscale: { online: true } } as DeviceProfile],
      listRoles: () => ({ zion: 'personal' }),
      isPinned: () => true,
      pull: () => { pulled = true; return { ok: true, stdout: JSON.stringify({ v: 1, rows: {} }) }; },
      ingestRows: () => 0,
    });
    expect(result.skipped).toBeNull();
    expect(pulled).toBe(true);
    expect(result.pulledFrom).toBe('zion');
  });

  it('parses a Windows primary payload carrying a CLIXML progress banner', () => {
    // A headed Windows box (win-mini is a live fleet device) reached WITHOUT the
    // progress-silence prelude prepends a `#< CLIXML <Objs …>` banner to stdout,
    // exactly as every other remote-JSON boundary strips (remote-cmd.ts). Without
    // the stripClixml wrap in the pull path this parses as malformed JSON, the
    // worker's cache stays null, and the PHNX-3392 capacity floor silently becomes
    // the only thing standing between a blind pool and an exhausted pick.
    const dir = mkdtempSync(join(tmpdir(), 'agents-usage-pull-clixml-'));
    tempDirs.push(dir);
    const primaryCache = join(dir, 'primary.json');
    const workerCache = join(dir, 'worker.json');
    const capturedAt = new Date();
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
        resetsAt: null,
        windowMinutes: 7 * 24 * 60,
      }],
      plan: null,
      refreshHint: null,
    }, primaryCache);

    const clixmlBanner =
      '#< CLIXML\r\n' +
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>' +
      '<T>System.Object</T></TN><MS><I64 N="SourceId">1</I64>' +
      '<PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>';
    const primary = { name: 'win-mini', tailscale: { online: true } } as DeviceProfile;
    const result = pullUsageFromPrimary({
      selfRole: () => 'worker',
      listDevices: () => [primary],
      listRoles: () => ({ 'win-mini': 'personal' }),
      isPinned: () => true,
      exportRows: () => exportClaudeUsageCacheRows(workerCache),
      pull: () => ({
        ok: true,
        stdout: clixmlBanner + JSON.stringify({ v: 1, rows: exportClaudeUsageCacheRows(primaryCache) }),
      }),
      ingestRows: (rows) => ingestPeerClaudeUsageRows(rows, workerCache),
    });

    expect(result).toEqual({ pulledFrom: 'win-mini', merged: 1, skipped: null, error: null });
    expect(exportClaudeUsageCacheRows(workerCache)[usageKey]).toMatchObject({
      windows: [{ key: 'week', usedPercent: 100 }],
    });
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
