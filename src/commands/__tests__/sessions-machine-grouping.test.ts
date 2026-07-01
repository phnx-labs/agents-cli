/**
 * Tests for the machine-grouping layer behind `agents sessions --active`.
 *
 * The renderer couples grouping with chalk+console; groupSessionsByMachine and
 * dedupeByMachineSession are the pure pieces where the real bugs live — keying
 * off the terminal-app host instead of the machine, dropping the local box out
 * of first place, or collapsing two different machines' identically-numbered
 * sessions into one.
 */

import { describe, it, expect } from 'vitest';
import { groupSessionsByMachine, dedupeByMachineSession } from '../sessions.js';
import type { ActiveSession } from '../../lib/session/active.js';

function mk(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    ...overrides,
  };
}

describe('groupSessionsByMachine', () => {
  it('pins the local machine first even when it has fewer sessions', () => {
    const layout = groupSessionsByMachine(
      [
        mk({ machine: 'zion', sessionId: 'z1' }),
        mk({ machine: 'zion', sessionId: 'z2' }),
        mk({ machine: 'yosemite-s0', sessionId: 'l1' }),
      ],
      'yosemite-s0',
    );
    expect(layout.machines.map((m) => m.machine)).toEqual(['yosemite-s0', 'zion']);
    expect(layout.machines[0].isLocal).toBe(true);
    expect(layout.machines[1].isLocal).toBe(false);
  });

  it('sorts non-local machines by session count desc, then name', () => {
    const layout = groupSessionsByMachine(
      [
        mk({ machine: 'alpha', sessionId: 'a1' }),
        mk({ machine: 'beta', sessionId: 'b1' }),
        mk({ machine: 'beta', sessionId: 'b2' }),
        mk({ machine: 'gamma', sessionId: 'g1' }),
      ],
      'local-box',
    );
    // beta (2) before alpha/gamma (1 each); alpha before gamma by name.
    expect(layout.machines.map((m) => m.machine)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('prefers the explicit machine tag over the provenance host', () => {
    const layout = groupSessionsByMachine(
      [mk({ machine: 'tagged', provenance: { host: 'provhost' } as any, sessionId: 's1' })],
      'local-box',
    );
    expect(layout.machines[0].machine).toBe('tagged');
  });

  it('falls back to the normalized provenance host when there is no tag', () => {
    const layout = groupSessionsByMachine(
      [mk({ provenance: { host: 'ZION.tail1a85a1.ts.net' } as any, sessionId: 's1' })],
      'local-box',
    );
    expect(layout.machines[0].machine).toBe('zion');
  });

  it('falls back to the local machine for an untagged, provenance-less session', () => {
    const layout = groupSessionsByMachine([mk({ sessionId: 's1' })], 'local-box');
    expect(layout.machines).toHaveLength(1);
    expect(layout.machines[0].machine).toBe('local-box');
    expect(layout.machines[0].isLocal).toBe(true);
  });

  it('still splits a machine into its workspace layout', () => {
    const layout = groupSessionsByMachine(
      [
        mk({ machine: 'zion', cwd: '/repo/a', sessionId: 's1' }),
        mk({ machine: 'zion', cwd: '/repo/b', sessionId: 's2' }),
      ],
      'local-box',
    );
    expect(layout.machines[0].total).toBe(2);
    expect(layout.machines[0].layout.workspaces).toHaveLength(2);
  });
});

describe('dedupeByMachineSession', () => {
  it('collapses the same session seen twice on one machine', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'zion', sessionId: 'dup' }),
      mk({ machine: 'zion', sessionId: 'dup' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps identically-numbered sessions on different machines', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'zion', sessionId: 'same' }),
      mk({ machine: 'yosemite-s1', sessionId: 'same' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps every session that has no sessionId (uncorrelatable)', () => {
    const out = dedupeByMachineSession([
      mk({ machine: 'zion', sessionId: undefined }),
      mk({ machine: 'zion', sessionId: undefined }),
    ]);
    expect(out).toHaveLength(2);
  });
});
