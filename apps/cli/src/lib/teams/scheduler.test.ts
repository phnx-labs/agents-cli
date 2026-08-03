/**
 * Placement cascade — the create→pin→pool→local rules a user reasons about.
 * Pure functions, no I/O: exercises resolvePlacement + pickLeastLoaded directly.
 *
 * machineId() reads the real hostname; these tests use device names that are
 * definitely NOT the local machine (`box-a`/`box-b`/`box-c`) so the local-device
 * short-circuit never fires, keeping assertions host-independent.
 */
import { describe, it, expect } from 'vitest';
import { resolvePlacement, pickLeastLoaded, cappedDevices, type RosterEntry } from './scheduler.js';
import { machineId } from '../machine-id.js';

const running = (hostName: string | null): RosterEntry => ({ hostName, status: 'running' });
const done = (hostName: string | null): RosterEntry => ({ hostName, status: 'completed' });

describe('resolvePlacement cascade', () => {
  it('1. explicit pin wins even with no pool', () => {
    expect(resolvePlacement({}, 'box-a', [])).toEqual({ device: 'box-a' });
  });

  it('1. explicit pin wins over a pool', () => {
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, 'box-b', [])).toEqual({ device: 'box-b' });
  });

  it('4. no pin + no pool → local (null)', () => {
    expect(resolvePlacement({}, null, [])).toEqual({ device: null });
    expect(resolvePlacement({ devices: [] }, null, [])).toEqual({ device: null });
  });

  it('2. pool of one → the whole team runs there', () => {
    expect(resolvePlacement({ devices: ['box-a'] }, null, [])).toEqual({ device: 'box-a' });
  });

  it('3. pool of many → least-loaded pick', () => {
    // box-a already has a running teammate, box-b is idle → pick box-b.
    const roster = [running('box-a')];
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, null, roster)).toEqual({ device: 'box-b' });
  });
});

describe('pickLeastLoaded', () => {
  it('picks the device with the fewest RUNNING teammates', () => {
    const roster = [running('box-a'), running('box-a'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b', 'box-c'], roster)).toBe('box-c');
  });

  it('ignores non-running teammates when counting load', () => {
    // box-a has 2 COMPLETED (not load) and box-b has 1 RUNNING → box-a is least-loaded.
    const roster = [done('box-a'), done('box-a'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-a');
  });

  it('breaks ties by pool order (first declared wins)', () => {
    expect(pickLeastLoaded(['box-a', 'box-b'], [])).toBe('box-a');
    expect(pickLeastLoaded(['box-b', 'box-a'], [])).toBe('box-b');
  });

  it('ignores roster entries for devices outside the pool', () => {
    // A teammate on some retired host must not skew the pool's load counts.
    const roster = [running('retired-host'), running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-b');
  });

  it('throws on an empty pool (caller must guard)', () => {
    expect(() => pickLeastLoaded([], [])).toThrow(/empty device pool/);
  });
});

describe('agents.max-concurrent caps (auto-pick only)', () => {
  it('excludes a device at its cap from the least-loaded pick', () => {
    // box-a is at its cap (2/2 running) → box-b wins despite ties-by-order.
    const roster = [running('box-a'), running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2 })).toBe('box-b');
  });

  it('keeps a device under its cap eligible', () => {
    const roster = [running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2 })).toBe('box-b');
    // box-a 1/2 is NOT capped, but box-b at 0 is still less loaded — prove the
    // cap didn't exclude box-a by making box-b busier:
    const busier = [running('box-a'), running('box-b'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], busier, { 'box-a': 2 })).toBe('box-a');
  });

  it('throws naming each cap and the fix when every device is capped', () => {
    const roster = [running('box-a'), running('box-a'), running('box-b')];
    expect(() => pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 }))
      .toThrow(/agents\.max-concurrent cap: box-a \(2\/2\), box-b \(1\/1\)/);
    expect(() => pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 }))
      .toThrow(/agents devices configure <name> --max-agents N/);
  });

  it('cappedDevices reports the exclusion reason with live counts', () => {
    const roster = [running('box-a'), running('box-a'), done('box-b')];
    // box-b's COMPLETED teammate is not load — a 1-cap box-b is not capped.
    expect(cappedDevices(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 })).toEqual([
      { device: 'box-a', running: 2, cap: 2 },
    ]);
  });

  it('resolvePlacement passes caps through the least-loaded step', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a', 'box-b'] }, null, roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-b' });
  });

  it('never second-guesses an explicit pin, even onto a capped device', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a', 'box-b'] }, 'box-a', roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-a' });
  });

  it('never second-guesses a pool of one, even when capped', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a'] }, null, roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-a' });
  });
});

describe('local teammates count against the local pool member', () => {
  it('a cap on the local device engages once local teammates reach it', () => {
    const self = machineId();
    const roster = [running(null), running(null)];
    expect(pickLeastLoaded([self, 'box-b'], roster, { [self]: 2 })).toBe('box-b');
  });

  it('mixed local + remote pool counts both sides', () => {
    const self = machineId();
    // self: 1 local running, box-b: 2 remote running → self is least-loaded.
    const roster = [running(null), running('box-b'), running('box-b')];
    expect(pickLeastLoaded([self, 'box-b'], roster)).toBe(self);
    expect(cappedDevices([self, 'box-b'], roster, { [self]: 1 })).toEqual([
      { device: self, running: 1, cap: 1 },
    ]);
  });

  it('an empty-string hostName is local too', () => {
    const self = machineId();
    const roster: RosterEntry[] = [{ hostName: '', status: 'running' }];
    expect(pickLeastLoaded([self, 'box-b'], roster, { [self]: 1 })).toBe('box-b');
  });

  it('ignores a local teammate when this machine is not in the pool', () => {
    // Today’s behavior preserved: roster entries outside the pool never skew it.
    const roster = [running(null), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-a');
  });
});
