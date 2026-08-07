/**
 * RUSH-2353: daemon-ticks.ts is the dispatch layer between the shipped system
 * routines (`agents __daemon-tick <name>`) and the tick bodies that used to be
 * hardcoded setInterval closures in daemon.ts. The bodies' own logic is
 * covered by their existing tests (usage-refresh.test.ts, auto-dispatch.test.ts,
 * ...); what's new and worth pinning here is the dispatch itself — the registry
 * names must match what the shipped routine YAML's `command:` field invokes by
 * name, an unknown name must fail loud (never a silent no-op), and each real
 * tick function must actually be reachable through its dynamic import (a typo'd
 * import/export name here is exactly the class of bug this test catches, since
 * it wouldn't show up until the routine fired unattended and failed silently).
 */

import { describe, it, expect } from 'vitest';
import { DAEMON_TICKS, runDaemonTick } from './daemon-ticks.js';

describe('DAEMON_TICKS registry', () => {
  it('has exactly the 8 names the shipped system routine YAML invokes', () => {
    expect(Object.keys(DAEMON_TICKS).sort()).toEqual([
      'auto-dispatch',
      'device-probe',
      'fleet-cache-warm',
      'launch-health',
      'session-cache-warm',
      'tmux-reconcile',
      'usage-refresh',
      'watchdog',
    ]);
  });
});

describe('runDaemonTick', () => {
  it('throws for an unknown tick name, listing the known ones', async () => {
    await expect(runDaemonTick('bogus-tick-name')).rejects.toThrow(
      /Unknown daemon tick 'bogus-tick-name'\. Known: .*watchdog/,
    );
  });

  it('runs each real tick body end to end without throwing', async () => {
    // Real services only (no mocking): every tick here already no-ops safely
    // in a dev environment (watchdog gated on watchdog.enabled; auto-dispatch
    // gated on an opted-in project + LINEAR_API_KEY; the rest are read/publish
    // passes over local state). Proves the dynamic import + function wiring is
    // correct — the actual behavior of each body is covered by its own module
    // test.
    for (const name of Object.keys(DAEMON_TICKS)) {
      await expect(runDaemonTick(name), `tick '${name}' should not throw`).resolves.toBeUndefined();
    }
  });
});
