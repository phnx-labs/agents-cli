import { describe, test, expect } from 'bun:test';
import {
  HOST_PICKER_STALE_MS,
  freshnessSuffix,
  isHostPickerStale,
  mergeHostPickerSnapshot,
  parseHostPickerCache,
  serializeUsage,
  sortHostPickerDevices,
  type HostPickerCache,
} from './hostPickerCache';
import type { HostUsageScore } from './agentUsage';

const NOW = Date.parse('2026-08-03T10:00:00Z');

function score(host: string, s: number, sessions = 3): HostUsageScore {
  return { host, score: s, lastActivityMs: NOW, sessions };
}

describe('parseHostPickerCache', () => {
  const good: HostPickerCache = {
    devices: [{ name: 'zion', host: 'zion', online: true }],
    usage: { zion: score('zion', 5) },
    fetchedAt: NOW,
  };

  test('round-trips a well-formed cache', () => {
    expect(parseHostPickerCache(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  test('rejects garbage and shape drift', () => {
    expect(parseHostPickerCache(undefined)).toBeUndefined();
    expect(parseHostPickerCache(null)).toBeUndefined();
    expect(parseHostPickerCache('cache')).toBeUndefined();
    expect(parseHostPickerCache({ usage: {}, fetchedAt: NOW })).toBeUndefined();
    expect(parseHostPickerCache({ devices: [], usage: [], fetchedAt: NOW })).toBeUndefined();
    expect(parseHostPickerCache({ devices: [], usage: {}, fetchedAt: 'now' })).toBeUndefined();
  });
});

describe('isHostPickerStale', () => {
  test('missing cache is stale; fresh cache is not; old cache is', () => {
    expect(isHostPickerStale(null, NOW)).toBe(true);
    expect(isHostPickerStale(undefined, NOW)).toBe(true);
    const cache = { devices: [], usage: {}, fetchedAt: NOW - HOST_PICKER_STALE_MS + 1 };
    expect(isHostPickerStale(cache, NOW)).toBe(false);
    expect(isHostPickerStale({ ...cache, fetchedAt: NOW - HOST_PICKER_STALE_MS }, NOW)).toBe(true);
  });
});

describe('sortHostPickerDevices', () => {
  test('online outranks usage, usage outranks name', () => {
    const devices = [
      { name: 'bravo', online: false },
      { name: 'alpha', online: true },
      { name: 'zulu', online: true },
    ];
    const usage = { zulu: score('zulu', 10), alpha: score('alpha', 1) };
    expect(sortHostPickerDevices(devices, usage).map((d) => d.name)).toEqual(['zulu', 'alpha', 'bravo']);
  });

  test('no scores falls back to name order within each online group', () => {
    const devices = [
      { name: 'zulu', online: true },
      { name: 'alpha', online: true },
      { name: 'mike', online: false },
    ];
    expect(sortHostPickerDevices(devices, {}).map((d) => d.name)).toEqual(['alpha', 'zulu', 'mike']);
  });

  test('does not mutate the input', () => {
    const devices = [{ name: 'b', online: true }, { name: 'a', online: true }];
    sortHostPickerDevices(devices, {});
    expect(devices.map((d) => d.name)).toEqual(['b', 'a']);
  });
});

describe('freshnessSuffix', () => {
  test('labels the age of the snapshot', () => {
    expect(freshnessSuffix(NOW, NOW)).toBe('updated just now');
    expect(freshnessSuffix(NOW - 5 * 60_000, NOW)).toBe('updated 5m ago');
    expect(freshnessSuffix(NOW - 3 * 3_600_000, NOW)).toBe('updated 3h ago');
    expect(freshnessSuffix(NOW - 2 * 86_400_000, NOW)).toBe('updated 2d ago');
  });
});

describe('mergeHostPickerSnapshot', () => {
  const prev: HostPickerCache = {
    devices: [{ name: 'zion', host: 'zion', online: true }],
    usage: { zion: score('zion', 5) },
    fetchedAt: NOW - 3_600_000,
  };

  test('a fresh non-empty fetch replaces the snapshot', () => {
    const merged = mergeHostPickerSnapshot(prev, [{ name: 'mac-mini', host: 'mac-mini' }], { 'mac-mini': score('mac-mini', 9) }, NOW);
    expect(merged).toEqual({ devices: [{ name: 'mac-mini', host: 'mac-mini' }], usage: { 'mac-mini': score('mac-mini', 9) }, fetchedAt: NOW });
  });

  test('an empty fetch keeps the previous rows — it is a failed read, not an empty fleet', () => {
    const merged = mergeHostPickerSnapshot(prev, [], {}, NOW);
    expect(merged?.devices).toEqual(prev.devices);
    expect(merged?.usage).toEqual(prev.usage); // empty fresh usage must not wipe scores either
    // ...and it keeps the rows' TRUE age: a failed refresh must not stamp the
    // snapshot fresh, or the age label lies and the staleness gate stops retrying.
    expect(merged?.fetchedAt).toBe(prev.fetchedAt);
  });

  test('an empty fetch with fresh usage keeps rows but takes the new scores', () => {
    const merged = mergeHostPickerSnapshot(prev, [], { zion: score('zion', 8) }, NOW);
    expect(merged?.devices).toEqual(prev.devices);
    expect(merged?.usage).toEqual({ zion: score('zion', 8) });
  });

  test('an empty fetch with no previous snapshot yields nothing to persist', () => {
    expect(mergeHostPickerSnapshot(null, [], {}, NOW)).toBeNull();
  });
});

describe('serializeUsage', () => {
  test('serializes a score map to a plain record', () => {
    const map = new Map([['zion', score('zion', 7)]]);
    expect(serializeUsage(map)).toEqual({ zion: score('zion', 7) });
  });
});
