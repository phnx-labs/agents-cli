/**
 * The pending-device diff is the logic the auto-sync, the curation picker, and
 * (later) the menu-bar probe all depend on. The real bugs it must not have:
 *   1. A node already in the registry is NOT "new" (no re-suggesting known kit).
 *   2. A dismissed (ignored) node is NEVER "new" — this is the whole point of
 *      the ignore-list: an unchecked phone must not resurface every sync.
 *   3. A genuinely-new, non-ignored node IS surfaced.
 */
import { describe, expect, it } from 'vitest';
import { computePendingDevices, planDeviceReconciliation, sanitizeLoginUser, selectNodesToUpsert, withDefaultUser } from './sync.js';
import type { TailscaleNode } from './tailscale.js';
import type { DeviceInput } from './registry.js';

function node(name: string): TailscaleNode {
  return { name, platform: 'linux', online: true, direct: true };
}

describe('withDefaultUser', () => {
  const base: DeviceInput = { platform: 'linux', address: { via: 'tailscale', dnsName: 'mac-mini.tail.ts.net' } };

  it('fills the local operator user when the device has none registered', () => {
    expect(withDefaultUser(base, undefined, 'muqsit').user).toBe('muqsit');
  });

  it('never clobbers a pinned user: leaves input.user unset so upsert preserves the registered one', () => {
    // With a prev user, withDefaultUser must NOT stamp localUser — it returns the
    // input untouched so upsertDevice's `input.user ?? prev.user` keeps 'root'.
    expect(withDefaultUser(base, 'root', 'muqsit').user).toBeUndefined();
  });

  it('leaves the user unset when there is no safe local username', () => {
    expect(withDefaultUser(base, undefined, undefined).user).toBeUndefined();
  });

  it('does not overwrite a user already present on the input', () => {
    expect(withDefaultUser({ ...base, user: 'deploy' }, undefined, 'muqsit').user).toBe('deploy');
  });
});

describe('sanitizeLoginUser', () => {
  it('strips a Windows COMPUTER\\user / DOMAIN\\user prefix to the bare ssh account', () => {
    // Regression: `win-mini\muqsit` failed the charset guard on the `\`, so
    // Windows boxes pinned no user at all.
    expect(sanitizeLoginUser('win-mini\\muqsit')).toBe('muqsit');
    expect(sanitizeLoginUser('CORP\\muqsit')).toBe('muqsit');
  });

  it('passes a plain POSIX username through unchanged', () => {
    expect(sanitizeLoginUser('muqsit')).toBe('muqsit');
  });

  it('rejects an unsafe username (undefined rather than a bad pin)', () => {
    expect(sanitizeLoginUser('bad user;rm')).toBeUndefined();
    expect(sanitizeLoginUser(undefined)).toBeUndefined();
  });
});

describe('computePendingDevices', () => {
  it('surfaces only nodes that are neither registered nor ignored', () => {
    const nodes = ['zion', 'yosemite-s0', 'ipad165', 'win-mini'].map(node);
    const pending = computePendingDevices(nodes, ['yosemite-s0'], ['ipad165']);
    expect(pending).toEqual(['zion', 'win-mini']);
  });

  it('treats a node that is both registered and ignored as not-pending', () => {
    const nodes = [node('mac-mini')];
    expect(computePendingDevices(nodes, ['mac-mini'], ['mac-mini'])).toEqual([]);
  });

  it('returns everything when nothing is registered or ignored', () => {
    const nodes = ['a', 'b', 'c'].map(node);
    expect(computePendingDevices(nodes, [], [])).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing for an empty tailnet', () => {
    expect(computePendingDevices([], ['zion'], ['ipad165'])).toEqual([]);
  });
});

describe('selectNodesToUpsert (bootstrap vs refresh)', () => {
  const nodes = ['zion', 'yosemite-s0', 'ipad165', 'win-mini'].map(node);
  const registered = new Set(['yosemite-s0', 'win-mini']);
  const ignored = new Set(['ipad165']);

  it('bootstrap upserts every non-ignored node, newcomers included', () => {
    const got = selectNodesToUpsert(nodes, registered, ignored, 'bootstrap').map((n) => n.name);
    expect(got).toEqual(['zion', 'yosemite-s0', 'win-mini']); // ipad165 ignored, zion (new) INCLUDED
  });

  it('refresh upserts only already-registered non-ignored nodes — newcomers are skipped', () => {
    const got = selectNodesToUpsert(nodes, registered, ignored, 'refresh').map((n) => n.name);
    expect(got).toEqual(['yosemite-s0', 'win-mini']); // zion (new) SKIPPED so it can stay pending
  });

  it('never upserts an ignored node in either mode', () => {
    for (const mode of ['bootstrap', 'refresh'] as const) {
      const got = selectNodesToUpsert(nodes, registered, ignored, mode).map((n) => n.name);
      expect(got).not.toContain('ipad165');
    }
  });
});

describe('planDeviceReconciliation', () => {
  const all = ['zion', 'yosemite-s0', 'ipad165', 'win-mini', 'mac-mini'];

  it('registers checked, removes+ignores unchecked-that-were-registered', () => {
    // registered: zion, yosemite-s0, win-mini. ignored: ipad165. mac-mini is new.
    // user keeps zion + yosemite-s0, unchecks win-mini (registered) and leaves
    // ipad165/mac-mini unchecked.
    const plan = planDeviceReconciliation(
      all,
      ['zion', 'yosemite-s0'],
      ['zion', 'yosemite-s0', 'win-mini'],
      ['ipad165'],
    );
    expect(plan.toRegister).toEqual(['zion', 'yosemite-s0']);
    expect(plan.toRemove).toEqual(['win-mini']); // was registered, now unchecked
    expect(plan.toIgnore).toEqual(['ipad165', 'win-mini', 'mac-mini']); // every unchecked
    expect(plan.toUnignore).toEqual([]);
  });

  it('un-ignores a previously-dismissed node when the user re-checks it', () => {
    const plan = planDeviceReconciliation(['ipad165'], ['ipad165'], [], ['ipad165']);
    expect(plan.toRegister).toEqual(['ipad165']);
    expect(plan.toUnignore).toEqual(['ipad165']);
    expect(plan.toRemove).toEqual([]);
    expect(plan.toIgnore).toEqual([]);
  });

  it('does not try to remove an unchecked node that was never registered', () => {
    // mac-mini is newly discovered (not registered, not ignored) and left
    // unchecked: it should be ignored but NOT removed (nothing to remove).
    const plan = planDeviceReconciliation(['mac-mini'], [], [], []);
    expect(plan.toRemove).toEqual([]);
    expect(plan.toIgnore).toEqual(['mac-mini']);
  });
});
