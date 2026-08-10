import { afterEach, expect, test } from 'bun:test';
import {
  getRegisteredDevicesCache,
  setRegisteredDevicesCache,
  __deviceHealthTestCounters,
} from './deviceHealth.vscode';

afterEach(() => {
  setRegisteredDevicesCache(null);
  __deviceHealthTestCounters.reset();
});

test('registered-device cache returns last-good rows without a CLI call', () => {
  setRegisteredDevicesCache([
    { name: 'yosemite-s0', host: 'yosemite-s0.tailnet', online: true, registeredAt: 1 },
  ]);
  const before = __deviceHealthTestCounters.registeredDeviceCliCalls;
  const first = getRegisteredDevicesCache();
  const second = getRegisteredDevicesCache();
  expect(__deviceHealthTestCounters.registeredDeviceCliCalls).toBe(before);
  expect(first).toEqual(second);
  expect(first?.[0]?.name).toBe('yosemite-s0');
});

test('registered-device cache does not expose mutable internal rows', () => {
  setRegisteredDevicesCache([
    { name: 'yosemite-s0', host: 'yosemite-s0.tailnet', online: true, registeredAt: 1 },
  ]);
  const read = getRegisteredDevicesCache();
  read![0].online = false;
  expect(getRegisteredDevicesCache()?.[0]?.online).toBe(true);
});
