/**
 * Tests for the pure seed decision backing `agents sessions --active --host/--device`.
 *
 * The bug this pins: `--host X` used to be additive — it folded X in alongside
 * the local machine instead of scoping to X. `shouldIncludeLocal` is the gate
 * that keeps local out of the view unless no host is named (full fleet) or the
 * local machine is itself named. Pure, so it tests without SSH or `ps`.
 */

import { describe, it, expect } from 'vitest';
import { shouldIncludeLocal, remoteHostsToDial, hasNoBrowserDisqualifyingFlags } from '../sessions.js';

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

describe('hasNoBrowserDisqualifyingFlags (bare interactive --host routing)', () => {
  // The bug this pins: a bare `agents sessions --host/--device <box>` used to
  // short-circuit into the legacy per-host raw stream (non-interactive, no
  // previews) instead of the fleet browser. The browser handles an explicit
  // host scope; the gate below is what lets `--host` reach it — but only for a
  // bare listing the picker can represent (no query / render / filter flag).
  it('allows a bare --host listing (no query, no flags) into the browser', () => {
    expect(hasNoBrowserDisqualifyingFlags({ host: ['yosemite-s0'] } as any, undefined)).toBe(true);
  });

  it('keeps the raw stream for a --host search (a query the picker path owns)', () => {
    expect(hasNoBrowserDisqualifyingFlags({ host: ['yosemite-s0'] } as any, 'auth bug')).toBe(false);
  });

  it('keeps the raw stream when a render/filter flag is set', () => {
    for (const flags of [{ flat: true }, { tree: true }, { markdown: true }, { until: '2d' }, { project: 'x' }, { sort: 'cost' }, { artifacts: true }]) {
      expect(hasNoBrowserDisqualifyingFlags({ host: ['yosemite-s0'], ...flags } as any, undefined)).toBe(false);
    }
  });
});
