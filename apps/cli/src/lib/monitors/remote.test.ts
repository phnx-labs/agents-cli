/**
 * Tests for the fleet-wide half of the duplicate guard.
 *
 * The local check catches "I already have this watcher". It cannot catch the
 * case that actually bites a fleet: two agents, on two different machines,
 * creating a watcher for the same work item with the same arguments. Neither box
 * can see the other's monitors dir, so the claim has to be asked of the fleet.
 *
 * Parsing is the part that must be defensive — a peer on an older CLI can emit a
 * different shape or no JSON at all, and one bad peer must never blank the guard
 * for the rest of the fleet (which would silently allow a duplicate).
 */

import { describe, it, expect } from 'vitest';
import { parseRemoteMonitors } from './remote.js';
import { findDuplicateMonitor } from './fingerprint.js';
import type { MonitorConfig } from './config.js';

const watcher = (over: Record<string, unknown> = {}) => ({
  name: 'w',
  source: { type: 'poll', command: 'gh pr view 2517', interval: '2m' },
  condition: { mode: 'on-change' },
  action: { type: 'run', agent: 'claude', prompt: 'merge' },
  ...over,
});

describe('parseRemoteMonitors', () => {
  it('tags each monitor with the machine it lives on', () => {
    const out = parseRemoteMonitors(JSON.stringify([watcher({ name: 'land-2517' })]), 'zion');
    expect(out).toHaveLength(1);
    expect(out[0].machine).toBe('zion');
    expect(out[0].monitor.name).toBe('land-2517');
  });

  it('accepts the { monitors: [...] } envelope as well as a bare array', () => {
    const out = parseRemoteMonitors(JSON.stringify({ monitors: [watcher()] }), 'zion');
    expect(out).toHaveLength(1);
  });

  it('returns [] for non-JSON from a version-skewed peer instead of throwing', () => {
    expect(parseRemoteMonitors('error: unknown command', 'zion')).toEqual([]);
    expect(parseRemoteMonitors('', 'zion')).toEqual([]);
  });

  it('drops rows with no identity rather than half-comparing them', () => {
    // Without source+condition+action there is nothing to fingerprint, so such a
    // row can neither match nor mask a match.
    const out = parseRemoteMonitors(JSON.stringify([{ name: 'partial' }, watcher()]), 'zion');
    expect(out).toHaveLength(1);
    expect(out[0].monitor.name).toBe('w');
  });

  it('skips non-object entries without losing the good ones', () => {
    const out = parseRemoteMonitors(JSON.stringify([null, 'nope', 42, watcher()]), 'zion');
    expect(out).toHaveLength(1);
  });
});

describe('cross-machine duplicate detection', () => {
  type Ident = Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>;

  it('flags the same work item claimed on another box', () => {
    // zion already watches PR 2517; yosemite-s0 tries to add its own watcher.
    const remote = parseRemoteMonitors(JSON.stringify([watcher({ name: 'land-2517' })]), 'zion');
    const mine = watcher({ name: 'rush-2517-land' }) as unknown as Ident;
    const hit = remote.find((r) => findDuplicateMonitor(mine, [r.monitor as Ident]) !== null);
    expect(hit?.machine).toBe('zion');
  });

  it('lets a DIFFERENT work item through — the common case', () => {
    const remote = parseRemoteMonitors(JSON.stringify([watcher({ name: 'land-2517' })]), 'zion');
    const other = watcher({
      name: 'land-2600',
      source: { type: 'poll', command: 'gh pr view 2600', interval: '2m' },
    }) as unknown as Ident;
    expect(remote.find((r) => findDuplicateMonitor(other, [r.monitor as Ident]) !== null)).toBeUndefined();
  });

  it('matches across machines even when the two monitors are named differently', () => {
    const remote = parseRemoteMonitors(JSON.stringify([watcher({ name: 'totally-other-name' })]), 'mac-mini');
    const mine = watcher({ name: 'mine' }) as unknown as Ident;
    expect(remote.find((r) => findDuplicateMonitor(mine, [r.monitor as Ident]) !== null)?.machine).toBe('mac-mini');
  });
});
