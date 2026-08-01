import { test, expect } from 'bun:test';
import {
  pickLeastBusyDevice,
  pickBestHost,
  deviceHasUsableVersion,
  hostScore,
  resolveBalancePool,
  DeviceLoad,
  VersionHealth,
} from './launchHost';

test('pickLeastBusyDevice: returns null when nothing is online', () => {
  expect(pickLeastBusyDevice([])).toBeNull();
  expect(
    pickLeastBusyDevice([
      { name: 's0', online: false, running: 0 },
      { name: 's1', online: false, running: 0 },
    ]),
  ).toBeNull();
});

test('pickLeastBusyDevice: single online device wins', () => {
  expect(
    pickLeastBusyDevice([
      { name: 's0', online: false, running: 0 },
      { name: 's1', online: true, running: 5 },
    ]),
  ).toBe('s1');
});

test('pickLeastBusyDevice: fewest running agents wins', () => {
  expect(
    pickLeastBusyDevice([
      { name: 'mac-mini', online: true, running: 5 },
      { name: 's0', online: true, running: 2 },
      { name: 's1', online: true, running: 0 },
    ]),
  ).toBe('s1');
});

test('pickLeastBusyDevice: ties break by input order (first wins)', () => {
  expect(
    pickLeastBusyDevice([
      { name: 's0', online: true, running: 1 },
      { name: 's1', online: true, running: 1 },
    ]),
  ).toBe('s0');
});

test('pickLeastBusyDevice: a busy offline box never beats an online one', () => {
  // offline s1 has 0 running but is skipped; online s0 (3 running) is the pick.
  expect(
    pickLeastBusyDevice([
      { name: 's0', online: true, running: 3 },
      { name: 's1', online: false, running: 0 },
    ]),
  ).toBe('s0');
});

const FLEET: DeviceLoad[] = [
  { name: 'zion', online: true, running: 4 },
  { name: 'yosemite-s0', online: true, running: 0 },
  { name: 'yosemite-s1', online: true, running: 2 },
  { name: 'mac-mini', online: false, running: 0 },
];

test('resolveBalancePool: excludes the local machine by default', () => {
  const pool = resolveBalancePool(FLEET, { localName: 'zion' });
  expect(pool.map((d) => d.name)).toEqual(['yosemite-s0', 'yosemite-s1', 'mac-mini']);
});

test('resolveBalancePool: restricts to an explicit pool (and drops unknowns)', () => {
  const pool = resolveBalancePool(FLEET, {
    localName: 'zion',
    pool: ['yosemite-s0', 'ghost-box'],
  });
  expect(pool.map((d) => d.name)).toEqual(['yosemite-s0']);
});

test('resolveBalancePool + pickLeastBusyDevice: end-to-end least-busy of the pool', () => {
  const pool = resolveBalancePool(FLEET, { localName: 'zion' });
  // mac-mini is offline, so the least-busy ONLINE of the pool is s0 (0 running).
  expect(pickLeastBusyDevice(pool)).toBe('yosemite-s0');
});

test('resolveBalancePool: local-name match is case/space-insensitive', () => {
  const pool = resolveBalancePool(FLEET, { localName: '  ZION ' });
  expect(pool.some((d) => d.name === 'zion')).toBe(false);
});

// --- RUSH-2025: agent-aware usable-version filtering + composite ranking ------

test('deviceHasUsableVersion: needs a signed-in, non-throttled version', () => {
  // No versions -> unusable (agent not installed / probe failed).
  expect(deviceHasUsableVersion([])).toBe(false);
  // Signed out -> unusable (the bug: user lands on a login screen).
  expect(deviceHasUsableVersion([{ signedIn: false, usageStatus: 'available' }])).toBe(false);
  // Signed in but throttled -> unusable.
  expect(deviceHasUsableVersion([{ signedIn: true, usageStatus: 'rate_limited' }])).toBe(false);
  expect(deviceHasUsableVersion([{ signedIn: true, usageStatus: 'out_of_credits' }])).toBe(false);
  // Signed in + available -> usable.
  expect(deviceHasUsableVersion([{ signedIn: true, usageStatus: 'available' }])).toBe(true);
  // Signed in + unknown usage (null/undefined) -> usable (not throttled).
  expect(deviceHasUsableVersion([{ signedIn: true, usageStatus: null }])).toBe(true);
  expect(deviceHasUsableVersion([{ signedIn: true }])).toBe(true);
});

test('deviceHasUsableVersion: one usable version among throttled/signed-out ones is enough', () => {
  const versions: VersionHealth[] = [
    { signedIn: false, usageStatus: 'available' },
    { signedIn: true, usageStatus: 'rate_limited' },
    { signedIn: true, usageStatus: 'available' },
  ];
  expect(deviceHasUsableVersion(versions)).toBe(true);
});

test('pickBestHost: drops devices with no usable version (usableVersion === false)', () => {
  // s0 has 0 running but no usable version; s1 has 3 running but a usable one.
  // The RUSH-2025 fix must NOT land on s0 (it would hit a login wall).
  expect(
    pickBestHost([
      { name: 's0', online: true, running: 0, usableVersion: false },
      { name: 's1', online: true, running: 3, usableVersion: true },
    ]),
  ).toBe('s1');
});

test('pickBestHost: returns null when every online device is unusable', () => {
  expect(
    pickBestHost([
      { name: 's0', online: true, running: 0, usableVersion: false },
      { name: 's1', online: true, running: 1, usableVersion: false },
    ]),
  ).toBeNull();
});

test('pickBestHost: unprobed health (usableVersion undefined) degrades to least-busy', () => {
  // Agent-unaware caller: no usableVersion / hardware fields -> pure running-count.
  expect(
    pickBestHost([
      { name: 'mac-mini', online: true, running: 5 },
      { name: 's0', online: true, running: 2 },
      { name: 's1', online: true, running: 0 },
    ]),
  ).toBe('s1');
});

test('pickBestHost: running-agent count dominates hardware tie-breakers', () => {
  // s0 has 1 running but a crushed box (load 16, 100% mem); s1 has 0 running and
  // is healthy. 0 running still wins even though s0 has fewer... no: s1 has fewer
  // running AND better hardware, so s1 wins.
  expect(
    pickBestHost([
      { name: 's0', online: true, running: 1, usableVersion: true, loadAvg1: 16, memPercent: 100 },
      { name: 's1', online: true, running: 0, usableVersion: true, loadAvg1: 0, memPercent: 10 },
    ]),
  ).toBe('s1');
});

test('pickBestHost: hardware load/memory breaks a running-count tie', () => {
  // Same running count -> the machine under heavy load/memory pressure (the
  // reported 20-30h crash box) is deprioritized.
  expect(
    pickBestHost([
      { name: 'crashy', online: true, running: 2, usableVersion: true, loadAvg1: 12, memPercent: 95 },
      { name: 'healthy', online: true, running: 2, usableVersion: true, loadAvg1: 0.5, memPercent: 20 },
    ]),
  ).toBe('healthy');
});

test('pickBestHost: a heavily-loaded box does not beat a busier-but-idle one past the 10pt/agent gap', () => {
  // running dominates: 1 extra running agent (=10 pts) outweighs any hardware
  // delta (load capped at 16, mem at 5 -> max 21, but per-agent gap is 10 and
  // hardware deltas here are small). s1 (0 running) wins over s0 (1 running).
  expect(
    pickBestHost([
      { name: 's0', online: true, running: 1, usableVersion: true, loadAvg1: 0, memPercent: 0 },
      { name: 's1', online: true, running: 0, usableVersion: true, loadAvg1: 4, memPercent: 60 },
    ]),
  ).toBe('s1');
});

test('pickBestHost: skips offline devices even when usable', () => {
  expect(
    pickBestHost([
      { name: 'off', online: false, running: 0, usableVersion: true },
      { name: 'on', online: true, running: 4, usableVersion: true },
    ]),
  ).toBe('on');
});

test('hostScore: running agents weighted 10x, load capped at 16, mem scaled by 20', () => {
  // 2 running -> 20; load 3 -> 3; mem 40% -> 2. Total 25.
  expect(hostScore({ name: 'x', online: true, running: 2, loadAvg1: 3, memPercent: 40 })).toBeCloseTo(25, 5);
  // Load above 16 is clamped to 16.
  expect(hostScore({ name: 'x', online: true, running: 0, loadAvg1: 99, memPercent: 0 })).toBe(16);
  // Unprobed hardware contributes 0.
  expect(hostScore({ name: 'x', online: true, running: 3 })).toBe(30);
});
