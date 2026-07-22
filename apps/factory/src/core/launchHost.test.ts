import { test, expect } from 'bun:test';
import { pickLeastBusyDevice, resolveBalancePool, DeviceLoad } from './launchHost';

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
