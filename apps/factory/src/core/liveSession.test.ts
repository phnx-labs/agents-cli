import { describe, expect, it } from 'bun:test';
import { recordPredatesTerminal, type SessionStateRecord } from './liveSession';

// The real defect this guards: a Factory tab opened on 2026-08-02 displayed the
// session id and version of a synthetic watchdog run from 20 days earlier,
// because the hook's `<pid>.json` outlived its agent and the OS handed that pid
// to the local process backing the new tab. Dating the record against the tab is
// what separates "this tab's agent" from "the pid's previous owner".
const rec = (tsSeconds: number, sessionId = 's'): SessionStateRecord => ({
  session_id: sessionId,
  pid: 4242,
  ts: tsSeconds,
});

describe('recordPredatesTerminal', () => {
  const terminalCreatedAtMs = Date.UTC(2026, 7, 2, 23, 20, 33);

  it('rejects the recycled-pid record from a long-dead agent', () => {
    const twentyDaysEarlier = Math.floor((terminalCreatedAtMs - 20 * 24 * 3600 * 1000) / 1000);
    expect(recordPredatesTerminal(rec(twentyDaysEarlier), terminalCreatedAtMs)).toBe(true);
  });

  it('keeps a record written after the tab was created', () => {
    const twoSecondsLater = Math.floor(terminalCreatedAtMs / 1000) + 2;
    expect(recordPredatesTerminal(rec(twoSecondsLater), terminalCreatedAtMs)).toBe(false);
  });

  it('keeps a record from the same second as the tab despite seconds-granularity ts', () => {
    // The hook writes `int(time.time())`, so a session started 400ms after the
    // tab floors to the same second — or one below it. That must not be dropped.
    const sameSecondFloor = Math.floor(terminalCreatedAtMs / 1000) - 1;
    expect(recordPredatesTerminal(rec(sameSecondFloor), terminalCreatedAtMs)).toBe(false);
  });

  it('rejects a record with no usable timestamp rather than trusting it', () => {
    expect(recordPredatesTerminal(rec(0), terminalCreatedAtMs)).toBe(false);
    expect(recordPredatesTerminal(rec(Number.NaN), terminalCreatedAtMs)).toBe(false);
  });
});

// The regression the first cut of this guard shipped: `register()` stamps
// createdAt = Date.now(), and both restore paths (reload, tmux reattach) build a
// NEW terminal widget for an agent that has been running for hours. Anchoring on
// the widget's birth time instead of the tab's meant a reattached agent's own
// live SessionStart record looked like it predated its tab, so it was discarded
// on every scan — permanently stranding the tab on a stale session id, the same
// class of bug this guard exists to prevent.
describe('recordPredatesTerminal across a reattach', () => {
  const originalTabCreatedAt = Date.UTC(2026, 7, 2, 20, 0, 0);
  const agentStartedAt = Math.floor((originalTabCreatedAt + 60_000) / 1000); // 1 min into the tab
  const reattachedAt = originalTabCreatedAt + 3 * 3600 * 1000; // client reconnects 3h later

  it('keeps the live agent record when the tab carries its ORIGINAL creation time', () => {
    expect(recordPredatesTerminal(rec(agentStartedAt), originalTabCreatedAt)).toBe(false);
  });

  it('would discard that same live record if the tab were re-stamped at reattach time', () => {
    // Guards the fix itself: if register() ever goes back to stamping "now" on a
    // restore, this is what the user would see — a live agent whose identity can
    // never be refreshed again.
    expect(recordPredatesTerminal(rec(agentStartedAt), reattachedAt)).toBe(true);
  });
});
