/**
 * The pending-device diff is the logic the auto-sync, the curation picker, and
 * (later) the menu-bar probe all depend on. The real bugs it must not have:
 *   1. A node already in the registry is NOT "new" (no re-suggesting known kit).
 *   2. A dismissed (ignored) node is NEVER "new" — this is the whole point of
 *      the ignore-list: an unchecked phone must not resurface every sync.
 *   3. A genuinely-new, non-ignored node IS surfaced.
 */
import { describe, expect, it } from 'vitest';
import { computePendingDevices } from './sync.js';
import type { TailscaleNode } from './tailscale.js';

function node(name: string): TailscaleNode {
  return { name, platform: 'linux', online: true, direct: true };
}

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
