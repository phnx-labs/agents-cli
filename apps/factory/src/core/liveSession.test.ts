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
