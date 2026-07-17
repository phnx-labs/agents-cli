import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import {
  readState,
  writeState,
  hasChanged,
  dedupeSignature,
  recordFireTime,
  writeFireRecord,
  listFires,
  getMonitorHistoryDir,
} from './state.js';
import type { MonitorEvent } from './config.js';

const NAME = `test-state-${process.pid}-${Date.now()}`;

afterEach(() => {
  try {
    fs.rmSync(getMonitorHistoryDir(NAME), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('state-diff round-trip', () => {
  it('round-trips a value through writeState/readState', () => {
    expect(readState(NAME)).toBeNull();
    writeState(NAME, 'value-1');
    const state = readState(NAME);
    expect(state).not.toBeNull();
    expect(state!.monitorName).toBe(NAME);
    expect(state!.lastValue).toBe('value-1');
    expect(state!.lastHash.length).toBeGreaterThan(0);
  });

  it('preserves fire bookkeeping across a plain re-observation', () => {
    writeState(NAME, 'v1', undefined, { lastFiredAt: '2026-01-01T00:00:00.000Z', fireTimes: [1, 2] });
    writeState(NAME, 'v2');
    const state = readState(NAME);
    expect(state!.lastValue).toBe('v2');
    expect(state!.lastFiredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state!.fireTimes).toEqual([1, 2]);
  });
});

describe('hasChanged', () => {
  it('is true when there is no prior state (first observation)', () => {
    expect(hasChanged(NAME, 'anything')).toBe(true);
  });

  it('is false when the observation matches the stored value', () => {
    writeState(NAME, 'same');
    expect(hasChanged(NAME, 'same')).toBe(false);
  });

  it('is true when the observation differs', () => {
    writeState(NAME, 'old');
    expect(hasChanged(NAME, 'new')).toBe(true);
  });

  it('dedupes on the matched token when a dedupeKey is given', () => {
    // Two different full outputs whose dedupeKey match is identical → no change.
    writeState(NAME, 'status: issued at 10:00', 'status: (\\w+)');
    expect(hasChanged(NAME, 'status: issued at 11:59', 'status: (\\w+)')).toBe(false);
    // A different matched token → change.
    expect(hasChanged(NAME, 'status: pending at 12:00', 'status: (\\w+)')).toBe(true);
  });
});

describe('dedupeSignature', () => {
  it('returns the full observation when no key', () => {
    expect(dedupeSignature('abc')).toBe('abc');
  });
  it('returns the first capture group of the key', () => {
    expect(dedupeSignature('build 42 failed', 'build (\\d+)')).toBe('42');
  });
  it('returns the whole match when there is no capture group', () => {
    expect(dedupeSignature('build 42 failed', 'failed')).toBe('failed');
  });
  it('falls back to the full observation on no match', () => {
    expect(dedupeSignature('all good', 'failed')).toBe('all good');
  });
});

describe('recordFireTime', () => {
  it('appends and prunes to the window', () => {
    const now = 1_000_000;
    writeState(NAME, 'v', undefined, { fireTimes: [now - 120_000, now - 10_000] });
    const times = recordFireTime(NAME, now, 60_000); // 60s window
    // The 120s-old entry is pruned; the 10s-old one and now remain.
    expect(times).toEqual([now - 10_000, now]);
  });
});

describe('fire history', () => {
  it('writes and lists fire records', () => {
    const event: MonitorEvent = {
      monitorName: NAME,
      firedAt: '2026-02-01T00:00:00.000Z',
      summary: 'CI failed on #1',
      payload: { exitCode: 1 },
    };
    const id = writeFireRecord(event, { runId: 'run-1', action: 'run', ok: true });
    expect(id).toBe('2026-02-01T00-00-00-000Z');

    const fires = listFires(NAME);
    expect(fires.length).toBe(1);
    expect(fires[0].summary).toBe('CI failed on #1');
    expect(fires[0].runId).toBe('run-1');
    expect(fires[0].ok).toBe(true);
  });
});
