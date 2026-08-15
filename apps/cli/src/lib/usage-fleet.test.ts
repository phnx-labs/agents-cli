import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  exportUsageFleet,
  importUsageFleet,
  setUsageFleetExportPathForTest,
} from './usage-fleet.js';
import {
  readHeadroomEntry,
  setHeadroomCachePathForTest,
  writeHeadroomEntries,
  type HeadroomEntry,
} from './usage-refresh.js';
import {
  readClaudeUsageCache,
  setClaudeUsageCachePathForTest,
  writeClaudeUsageCache,
  type UsageSnapshot,
} from './accounting/usage.js';

const NOW = 1_800_000_000_000;
const KEY = 'claude:org=fleet';

describe('usage fleet export/import', () => {
  let dir: string;
  let oldUsage: string | null;
  let oldHeadroom: string | null;
  let oldExport: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-fleet-'));
    oldUsage = setClaudeUsageCachePathForTest(path.join(dir, 'publisher-usage.json'));
    oldHeadroom = setHeadroomCachePathForTest(path.join(dir, 'publisher-headroom.json'));
    oldExport = setUsageFleetExportPathForTest(path.join(dir, 'usage-fleet.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(oldUsage);
    setHeadroomCachePathForTest(oldHeadroom);
    setUsageFleetExportPathForTest(oldExport);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports only derived usage and headroom, then imports both caches', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(NOW),
      plan: 'max',
      windows: [{
        key: 'session', label: '5h', shortLabel: 'S', usedPercent: 42,
        resetsAt: new Date(NOW + 60_000), windowMinutes: 300,
      }],
    };
    const headroom: HeadroomEntry = {
      status: 'available', minutesToLimit: 90, sessionUsedPercent: 42,
      capturedAt: NOW, nextRefreshAt: NOW + 300_000,
      callTimestamps: [NOW], computedAt: NOW,
    };
    writeClaudeUsageCache(KEY, snapshot);
    writeHeadroomEntries({ [KEY]: headroom });

    const payload = exportUsageFleet(NOW);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/access[_-]?token|refresh[_-]?token|authorization/i);
    expect(payload.usage[KEY]?.windows[0]?.usedPercent).toBe(42);

    setClaudeUsageCachePathForTest(path.join(dir, 'subscriber-usage.json'));
    setHeadroomCachePathForTest(path.join(dir, 'subscriber-headroom.json'));
    importUsageFleet(payload);

    expect(readClaudeUsageCache(KEY, undefined, new Date(NOW))?.windows[0]?.usedPercent).toBe(42);
    expect(readHeadroomEntry(KEY)?.minutesToLimit).toBe(90);
  });

  it('rejects an unsupported envelope instead of silently accepting it', () => {
    expect(() => importUsageFleet({ version: 2, usage: {}, headroom: {}, publishedAt: NOW }))
      .toThrow(/unsupported shape/);
  });
});
