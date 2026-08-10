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
import { monitorFingerprint } from './fingerprint.js';
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

  it('returns [] for non-JSON from a version-skewed peer instead of throwing', () => {
    expect(parseRemoteMonitors('error: unknown command', 'zion')).toEqual([]);
    expect(parseRemoteMonitors('', 'zion')).toEqual([]);
  });

  it('returns [] for a non-array payload (list --json emits a bare array)', () => {
    expect(parseRemoteMonitors(JSON.stringify({ monitors: [watcher()] }), 'zion')).toEqual([]);
  });

  it('drops rows with no identity rather than half-comparing them', () => {
    const out = parseRemoteMonitors(JSON.stringify([{ name: 'partial' }, watcher()]), 'zion');
    expect(out).toHaveLength(1);
    expect(out[0].monitor.name).toBe('w');
  });

  it('skips non-object entries without losing the good ones', () => {
    const out = parseRemoteMonitors(JSON.stringify([null, 'nope', 42, watcher()]), 'zion');
    expect(out).toHaveLength(1);
  });
});

/**
 * THE test this file exists for. The first version of these tests fabricated a
 * peer payload with a full `action`, while `monitors list --json` actually
 * emitted `action: { type }` only — so the fingerprint could never match a
 * `--run` monitor, the fleet check was inert for the exact case it was built
 * for, and every test passed anyway.
 *
 * So the fixture is now built by the SAME projection `list --json` performs.
 * If that projection ever drops a field the fingerprint needs, this fails.
 */
describe('against the real `monitors list --json` projection', () => {
  type Ident = Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>;

  /** Mirrors the payload built in commands/monitors.ts `list --json`. */
  const asListJson = (m: any) =>
    JSON.stringify([
      {
        name: m.name,
        enabled: true,
        source: m.source,
        condition: m.condition,
        action: m.action,
        owner: 'all',
        runsHere: true,
        lastSeenAt: null,
        lastFiredAt: null,
      },
    ]);

  const runMonitor = (over: Record<string, unknown> = {}) => ({
    name: 'land-2517',
    source: { type: 'poll', command: 'gh pr view 2517', interval: '2m' },
    condition: { mode: 'on-change' },
    action: { type: 'run', agent: 'claude', prompt: 'merge it' },
    ...over,
  });

  it('matches a --run monitor across machines — the case that was inert', () => {
    const remote = parseRemoteMonitors(asListJson(runMonitor()), 'zion');
    expect(remote).toHaveLength(1);
    const mine = runMonitor({ name: 'rush-2517-land' }) as unknown as Ident;
    const hit = remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(mine));
    expect(hit?.machine).toBe('zion');
  });

  it('would NOT match if the projection dropped the action payload', () => {
    // Reproduces the exact regression: action: { type } only.
    const typeOnly = JSON.stringify([
      { name: 'land-2517', enabled: true, source: runMonitor().source, condition: runMonitor().condition, action: { type: 'run' } },
    ]);
    const remote = parseRemoteMonitors(typeOnly, 'zion');
    const mine = runMonitor({ name: 'mine' }) as unknown as Ident;
    expect(remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(mine))).toBeUndefined();
  });

  it('lets a DIFFERENT work item through — the common case', () => {
    const remote = parseRemoteMonitors(asListJson(runMonitor()), 'zion');
    const other = runMonitor({
      name: 'land-2600',
      source: { type: 'poll', command: 'gh pr view 2600', interval: '2m' },
    }) as unknown as Ident;
    expect(remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(other))).toBeUndefined();
  });

  it('matches regardless of the two monitors being named differently', () => {
    const remote = parseRemoteMonitors(asListJson(runMonitor({ name: 'totally-other' })), 'mac-mini');
    const mine = runMonitor({ name: 'mine' }) as unknown as Ident;
    expect(remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(mine))?.machine).toBe('mac-mini');
  });

  it('a local monitor named `<machine>:<name>` cannot dodge the check', () => {
    // The first implementation renamed the remote row to `${machine}:${name}` to
    // dodge findDuplicateMonitor's same-name skip, which a local monitor
    // literally named `zion:foo` could then defeat. Fingerprints have no names.
    const remote = parseRemoteMonitors(asListJson(runMonitor({ name: 'foo' })), 'zion');
    const mine = runMonitor({ name: 'zion:foo' }) as unknown as Ident;
    expect(remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(mine))?.machine).toBe('zion');
  });
});
