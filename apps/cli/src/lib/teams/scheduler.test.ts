/**
 * Placement cascade — the create→pin→pool→local rules a user reasons about.
 * Pure functions, no I/O: exercises resolvePlacement + pickLeastLoaded directly.
 *
 * machineId() reads the real hostname; these tests use device names that are
 * definitely NOT the local machine (`box-a`/`box-b`/`box-c`) so the local-device
 * short-circuit never fires, keeping assertions host-independent.
 */
import { describe, it, expect } from 'vitest';
import { resolvePlacement, pickLeastLoaded, type RosterEntry } from './scheduler.js';

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
