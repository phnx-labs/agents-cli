import { describe, test, expect } from 'bun:test';
import {
  HOST_PICKER_STALE_MS,
  freshnessSuffix,
  isHostPickerStale,
  parseHostPickerCache,
  serializeUsage,
  sortHostPickerDevices,
  withRefreshedDevices,
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

describe('serializeUsage', () => {
  test('serializes a score map to a plain record', () => {
    const map = new Map([['zion', score('zion', 7)]]);
    expect(serializeUsage(map)).toEqual({ zion: score('zion', 7) });
  });
});

describe('withRefreshedDevices', () => {
  const prev: HostPickerCache = {
    devices: [{ name: 'old', host: 'old', online: false }],
    usage: { zion: score('zion', 7) },
    fetchedAt: NOW - 10 * 60_000,
  };

  test('swaps in the fresh device rows and stamps the refresh time', () => {
    const next = withRefreshedDevices(prev, [{ name: 'zion', host: 'zion', online: true }], NOW);
    expect(next.devices.map((d) => d.name)).toEqual(['zion']);
    expect(next.fetchedAt).toBe(NOW);
  });

  test('preserves the prior usage scores (the cheap device refresh must not clear them)', () => {
    const next = withRefreshedDevices(prev, [{ name: 'zion', host: 'zion', online: true }], NOW);
    expect(next.usage).toEqual({ zion: score('zion', 7) });
  });

  test('starts usage empty when there is no prior cache', () => {
    const next = withRefreshedDevices(null, [{ name: 'zion', host: 'zion', online: true }], NOW);
    expect(next.usage).toEqual({});
    expect(next.devices.map((d) => d.name)).toEqual(['zion']);
  });
});
