/**
 * Tests for the pure seed decision backing `agents sessions --active --host/--device`.
 *
 * The bug this pins: `--host X` used to be additive — it folded X in alongside
 * the local machine instead of scoping to X. `shouldIncludeLocal` is the gate
 * that keeps local out of the view unless no host is named (full fleet) or the
 * local machine is itself named. Pure, so it tests without SSH or `ps`.
 */

import { describe, it, expect } from 'vitest';
import { shouldIncludeLocal, remoteHostsToDial } from '../sessions.js';

describe('shouldIncludeLocal', () => {
  const self = 'zion';

  it('includes local when no --host is given (full fleet view)', () => {
    expect(shouldIncludeLocal(undefined, self)).toBe(true);
    expect(shouldIncludeLocal([], self)).toBe(true);
  });

  it('drops local when --host names only other machines (the fix: filter, not add)', () => {
    expect(shouldIncludeLocal(['yosemite-s0'], self)).toBe(false);
    expect(shouldIncludeLocal(['yosemite-s0', 'yosemite-s1'], self)).toBe(false);
  });

  it('includes local when it is itself named among the hosts', () => {
    expect(shouldIncludeLocal(['zion'], self)).toBe(true);
    expect(shouldIncludeLocal(['yosemite-s0', 'zion'], self)).toBe(true);
  });

  it('matches self by normalized id — case, domain suffix, and user@host', () => {
    expect(shouldIncludeLocal(['ZION'], self)).toBe(true);
    expect(shouldIncludeLocal(['zion.tail1a85a1.ts.net'], self)).toBe(true);
    expect(shouldIncludeLocal(['muqsit@zion'], self)).toBe(true);
  });

  it('does not treat a different machine as self', () => {
    expect(shouldIncludeLocal(['muqsit@yosemite-s0'], self)).toBe(false);
  });
});

describe('remoteHostsToDial', () => {
  const self = 'zion';

  it('returns undefined with no --host (auto-discovery sweep)', () => {
    expect(remoteHostsToDial(undefined, self)).toBeUndefined();
    expect(remoteHostsToDial([], self)).toBeUndefined();
  });

  it('dials exactly the named non-self hosts', () => {
    expect(remoteHostsToDial(['yosemite-s0', 'yosemite-s1'], self)).toEqual(['yosemite-s0', 'yosemite-s1']);
  });

  it('drops self from the dial list (local seed covers it — no self-SSH, no spurious "unreachable")', () => {
    expect(remoteHostsToDial(['zion', 'yosemite-s0'], self)).toEqual(['yosemite-s0']);
  });

  it('returns [] when the only named host is self (caller then skips the fan-out)', () => {
    expect(remoteHostsToDial(['zion'], self)).toEqual([]);
    expect(remoteHostsToDial(['zion.tail1a85a1.ts.net'], self)).toEqual([]);
  });
});
