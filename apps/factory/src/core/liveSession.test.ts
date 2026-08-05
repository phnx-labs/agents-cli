import { describe, expect, it } from 'bun:test';
import { parseElapsedSeconds, recordPredatesProcess, recordPredatesTerminal, type SessionStateRecord } from './liveSession';

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

describe('parseElapsedSeconds (`ps` ELAPSED / etime, macOS + Linux)', () => {
  it('parses every field width the format emits', () => {
    expect(parseElapsedSeconds('00:42')).toBe(42);              // mm:ss
    expect(parseElapsedSeconds('05:00')).toBe(300);
    expect(parseElapsedSeconds('01:02:03')).toBe(3723);         // hh:mm:ss
    expect(parseElapsedSeconds('03-16:16:16')).toBe(317776);    // dd-hh:mm:ss
    expect(parseElapsedSeconds('  02:00  ')).toBe(120);         // ps right-pads
  });

  it('returns null for an unparseable value rather than a wrong number', () => {
    expect(parseElapsedSeconds('ELAPSED')).toBeNull();
    expect(parseElapsedSeconds('')).toBeNull();
    expect(parseElapsedSeconds('-')).toBeNull();
  });
});

// The exact defect the Kimi tab showed: session_6bdb6da2's file (ts ~30h ago)
// outlived its dead agent; the OS recycled that pid onto a process now under the
// live Kimi tab. recordPredatesTerminal could NOT reject it because the Kimi tab
// was itself ~30h old (a long-running session in the same repo). The start time
// of the process CURRENTLY holding the pid is what separates them.
describe('recordPredatesProcess — recycled pid the terminal-age guard misses', () => {
  const nowMs = Date.UTC(2026, 7, 4, 20, 8, 0);
  const staleFileTs = Math.floor((nowMs - 30 * 3600 * 1000) / 1000); // dead agent, 30h ago
  const tabCreatedAtMs = nowMs - 30 * 3600 * 1000;                    // tab is the same age

  it('recordPredatesTerminal alone keeps the stale record (the bug)', () => {
    expect(recordPredatesTerminal(rec(staleFileTs), tabCreatedAtMs)).toBe(false);
  });

  it('rejects it once the pid\'s live process is known to have started just now', () => {
    const processStartMs = nowMs - 30_000; // recycled pid: process is 30s old
    expect(recordPredatesProcess(rec(staleFileTs), processStartMs)).toBe(true);
  });

  it('keeps the record when the live process started at the recorded time', () => {
    const processStartMs = staleFileTs * 1000 + 400; // same process that wrote it
    expect(recordPredatesProcess(rec(staleFileTs), processStartMs)).toBe(false);
  });

  it('rejects a record with no usable timestamp rather than trusting it', () => {
    expect(recordPredatesProcess(rec(0), nowMs)).toBe(false);
    expect(recordPredatesProcess(rec(Number.NaN), nowMs)).toBe(false);
  });
});
