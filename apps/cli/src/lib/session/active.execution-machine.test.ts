/**
 * Tests for {@link foldExecutionMachine} — the attribution that decides WHICH
 * BOX a live session runs on (RUSH-2479).
 *
 * The bug this pins: `agents run --device <peer>` leaves a live shim process on
 * the DISPATCHING box carrying the remote run's session id. Nothing on that
 * local process knows the agent is elsewhere, so the row was tagged with the
 * dispatcher — `--device <dispatcher>` claimed a session that was not running
 * there, and its preview dead-ended at "full transcript not indexed here"
 * because the transcript lives on the peer. The dispatch already recorded the
 * truth in the session index (`hosts/session-index.ts` writes
 * `machine: normalizeHost(task.host)`); this folds it back onto the live row.
 *
 * Pure — the index lookup is injected, so no SQLite and no live process table.
 */

import { describe, it, expect } from 'vitest';
import { foldExecutionMachine, type ActiveSession } from './active.js';

const self = 'zion';

function row(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

/** An index that reports `machine` for the ids it knows, nothing for the rest. */
const index = (m: Record<string, string>) => (id: string) => m[id];

describe('foldExecutionMachine', () => {
  it('re-attributes a dispatched run to the machine it executes on', () => {
    const rows = [row({ sessionId: 'off', machine: self, label: '[host/yosemite-s0]' })];
    foldExecutionMachine(rows, index({ off: 'yosemite-s0' }), self);
    expect(rows[0].machine).toBe('yosemite-s0');
    expect(rows[0].offloadedFrom).toBe(self);
  });

  it('re-attributes a row that carries no machine yet', () => {
    const rows = [row({ sessionId: 'off', machine: undefined })];
    foldExecutionMachine(rows, index({ off: 'yosemite-s0' }), self);
    expect(rows[0].machine).toBe('yosemite-s0');
  });

  it('leaves a genuinely local session alone', () => {
    const rows = [row({ sessionId: 'here', machine: self })];
    foldExecutionMachine(rows, index({ here: self }), self);
    expect(rows[0].machine).toBe(self);
    expect(rows[0].offloadedFrom).toBeUndefined();
  });

  it('leaves a row alone when the index has never seen it', () => {
    const rows = [row({ sessionId: 'unknown', machine: self })];
    foldExecutionMachine(rows, index({}), self);
    expect(rows[0].machine).toBe(self);
    expect(rows[0].offloadedFrom).toBeUndefined();
  });

  it("never overrides a peer's own self-report from the fan-out", () => {
    // The row already came back from yosemite-s1 saying it runs there. This
    // box's index copy is hearsay by comparison and must not win.
    const rows = [row({ sessionId: 'peer', machine: 'yosemite-s1' })];
    foldExecutionMachine(rows, index({ peer: 'yosemite-s0' }), self);
    expect(rows[0].machine).toBe('yosemite-s1');
    expect(rows[0].offloadedFrom).toBeUndefined();
  });

  it('skips a row with no session id (nothing to join on)', () => {
    const rows = [row({ sessionId: undefined, machine: self })];
    foldExecutionMachine(rows, index({}), self);
    expect(rows[0].machine).toBe(self);
  });

  it('attributes each row independently in a mixed set', () => {
    const rows = [
      row({ sessionId: 'a', machine: self }),
      row({ sessionId: 'b', machine: self }),
      row({ sessionId: 'c', machine: self }),
    ];
    foldExecutionMachine(rows, index({ a: 'yosemite-s0', b: self }), self);
    expect(rows.map((r) => r.machine)).toEqual(['yosemite-s0', self, self]);
    expect(rows.map((r) => r.offloadedFrom)).toEqual([self, undefined, undefined]);
  });
});
