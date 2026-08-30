import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  exportClaudeUsageCacheRows,
  ingestPeerClaudeUsageRows,
  readClaudeUsageCache,
  stickyMergeWindows,
  type CachedUsageSnapshot,
} from './usage.js';

type CW = CachedUsageSnapshot['windows'][number];
function win(key: string, usedPercent: number, resetsAt: string | null): CW {
  return { key: key as CW['key'], label: key, shortLabel: key[0].toUpperCase(), usedPercent, resetsAt, windowMinutes: 10080 };
}
function weekRow(capturedAt: string | null, usedPercent: number, resetsAt: string | null): CachedUsageSnapshot {
  return { capturedAt, windows: [win('week', usedPercent, resetsAt)] };
}

// Real files, no mocks: the export → ingest → read path IS the cross-machine
// usage-sync contract, minus the SSH hop (which is an injectable dep in the
// driver). A publisher's cache is exported, merged into a worker's cache
// newest-wins, and read back through the normal reader.

function row(capturedAt: string | null, usedPercent = 12): CachedUsageSnapshot {
  return {
    capturedAt,
    windows: [
      {
        key: 'five_hour' as CachedUsageSnapshot['windows'][number]['key'],
        label: 'Session (5h)',
        shortLabel: 'S',
        usedPercent,
        resetsAt: null,
        windowMinutes: 300,
      },
    ],
  };
}

function seed(cachePath: string, rows: Record<string, CachedUsageSnapshot>): void {
  fs.writeFileSync(cachePath, JSON.stringify(rows, null, 2), 'utf-8');
}

describe('usage-sync cache export/ingest (newest-wins)', () => {
  let dir = '';
  let src = '';
  let dst = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-sync-'));
    src = path.join(dir, 'src-usage.json');
    dst = path.join(dir, 'dst-usage.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const KEY_A = 'claude:org=alpha';
  const KEY_B = 'claude:org=beta';

  it('exports only rows that carry a window', () => {
    seed(src, {
      [KEY_A]: row('2026-08-28T12:00:00.000Z'),
      [KEY_B]: { capturedAt: '2026-08-28T12:00:00.000Z', windows: [] }, // empty — nothing to teach
    });
    const rows = exportClaudeUsageCacheRows(src);
    expect(Object.keys(rows)).toEqual([KEY_A]);
  });

  it('ingests into an empty worker cache and reads back through the normal reader', () => {
    const rows = { [KEY_A]: row('2026-08-28T12:00:00.000Z', 34) };
    const merged = ingestPeerClaudeUsageRows(rows, dst);
    expect(merged).toBe(1);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:05:00.000Z'));
    expect(snap?.windows[0].usedPercent).toBe(34);
    // A synced row reads as last-seen (cached), never as a live fetch.
    expect(snap?.source).toBe('last_seen');
  });

  it('does NOT overwrite a fresher local row with an older peer push', () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:10:00.000Z', 50) }); // local is newer
    const merged = ingestPeerClaudeUsageRows({ [KEY_A]: row('2026-08-28T12:00:00.000Z', 10) }, dst);
    expect(merged).toBe(0);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:11:00.000Z'));
    expect(snap?.windows[0].usedPercent).toBe(50); // fresher local survives
  });

  it('accepts a strictly-newer peer push over an older local row', () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:00:00.000Z', 10) });
    const merged = ingestPeerClaudeUsageRows({ [KEY_A]: row('2026-08-28T12:10:00.000Z', 55) }, dst);
    expect(merged).toBe(1);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:11:00.000Z'));
    expect(snap?.windows[0].usedPercent).toBe(55);
  });

  it('a peer row with no capturedAt never displaces a timestamped local row', () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:00:00.000Z', 22) });
    const merged = ingestPeerClaudeUsageRows({ [KEY_A]: row(null, 99) }, dst);
    expect(merged).toBe(0);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:01:00.000Z'));
    expect(snap?.windows[0].usedPercent).toBe(22);
  });

  it('adds a brand-new identity the worker had never seen', () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:00:00.000Z', 22) });
    const merged = ingestPeerClaudeUsageRows({ [KEY_B]: row('2026-08-28T12:00:00.000Z', 8) }, dst);
    expect(merged).toBe(1);
    expect(readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:01:00.000Z'))?.windows[0].usedPercent).toBe(22);
    expect(readClaudeUsageCache(KEY_B, dst, new Date('2026-08-28T12:01:00.000Z'))?.windows[0].usedPercent).toBe(8);
  });

  it('an empty payload is a no-op, not an error', () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:00:00.000Z', 22) });
    expect(ingestPeerClaudeUsageRows({}, dst)).toBe(0);
    expect(readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:01:00.000Z'))?.windows[0].usedPercent).toBe(22);
  });

  // PHNX-3505: a not-yet-reset 100% window must survive a newer, lower reading.
  const FUTURE = '2099-01-01T00:00:00.000Z';
  const PAST = '2020-01-01T00:00:00.000Z';

  it('a newer peer push does NOT lower a prior not-yet-reset 100% week window', () => {
    // The exact yosemite-s1 failure: worker had (correct) week=100% and a newer
    // wrong week=68% arrived. Newest-wins alone flipped it to 68% (eligible).
    seed(dst, { [KEY_A]: weekRow('2026-08-29T22:31:00.000Z', 100, FUTURE) });
    const merged = ingestPeerClaudeUsageRows({ [KEY_A]: weekRow('2026-08-30T05:49:00.000Z', 68, FUTURE) }, dst);
    expect(merged).toBe(1); // the row IS newer and is written…
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-30T05:50:00.000Z'));
    expect(snap?.windows.find((w) => w.key === 'week')?.usedPercent).toBe(100); // …but the maxed window is preserved
  });

  it('accepts a newer lower reading once the maxed window has reset', () => {
    seed(dst, { [KEY_A]: weekRow('2026-08-29T22:31:00.000Z', 100, PAST) }); // reset already passed
    ingestPeerClaudeUsageRows({ [KEY_A]: weekRow('2026-08-30T05:49:00.000Z', 20, FUTURE) }, dst);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-30T05:50:00.000Z'));
    expect(snap?.windows.find((w) => w.key === 'week')?.usedPercent).toBe(20); // reset → new reading wins
  });

  it('accepts a newer reading that CONFIRMS the account is still maxed', () => {
    seed(dst, { [KEY_A]: weekRow('2026-08-29T22:31:00.000Z', 100, FUTURE) });
    ingestPeerClaudeUsageRows({ [KEY_A]: weekRow('2026-08-30T05:49:00.000Z', 100, FUTURE) }, dst);
    expect(readClaudeUsageCache(KEY_A, dst, new Date('2026-08-30T05:50:00.000Z'))?.windows.find((w) => w.key === 'week')?.usedPercent).toBe(100);
  });
});

describe('stickyMergeWindows (PHNX-3505)', () => {
  const FUTURE = '2099-01-01T00:00:00.000Z';
  const PAST = '2020-01-01T00:00:00.000Z';
  const NOW = Date.UTC(2026, 7, 30, 5, 50);

  it('keeps a prior ≥100% blocking window with a future reset over a lower incoming one', () => {
    const out = stickyMergeWindows([win('week', 100, FUTURE)], [win('week', 68, FUTURE)], NOW);
    expect(out.find((w) => w.key === 'week')?.usedPercent).toBe(100);
  });

  it('does NOT hold a maxed window once its reset has passed', () => {
    const out = stickyMergeWindows([win('week', 100, PAST)], [win('week', 20, FUTURE)], NOW);
    expect(out.find((w) => w.key === 'week')?.usedPercent).toBe(20);
  });

  it('lets a higher (still-maxed) incoming reading through', () => {
    const out = stickyMergeWindows([win('week', 100, FUTURE)], [win('week', 100, FUTURE)], NOW);
    expect(out.find((w) => w.key === 'week')?.usedPercent).toBe(100);
  });

  it('never makes the model-specific sonnet_week sub-limit sticky (non-blocking)', () => {
    const out = stickyMergeWindows([win('sonnet_week', 100, FUTURE)], [win('sonnet_week', 40, FUTURE)], NOW);
    expect(out.find((w) => w.key === 'sonnet_week')?.usedPercent).toBe(40);
  });

  it('does not resurrect a maxed window the incoming reading dropped after reset, nor block a fresh pool', () => {
    // No prior windows → incoming passes through untouched.
    const out = stickyMergeWindows([], [win('week', 12, FUTURE)], NOW);
    expect(out.find((w) => w.key === 'week')?.usedPercent).toBe(12);
  });
});
