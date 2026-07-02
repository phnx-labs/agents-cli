/**
 * Tests for the watchdog runner (RUSH-1415) — the CONSUMER tick.
 *
 * Drives real synthetic ActiveSession inputs through runWatchdogTick with the I/O
 * seams supplied (sessions, clock, tail, policy) and dryRun injection, so no live
 * terminal is needed. The pure logic (classifyTerminal / isLikelyTrulyBlocked /
 * resolveInjectTargetForSession) runs for real — nothing is mocked. Each case
 * asserts the exact tick behavior: nudge fires only on promise-without-toolcall +
 * addressable, and it SKIPS on waiting-on-user, completion, addressable:false, and
 * within cooldown; handsoff never injects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ActiveSession } from '../session/active.js';
import type { SessionProvenance, MuxLocation } from '../session/provenance.js';
import { runWatchdogTick, DEFAULT_THRESHOLDS, type WatchdogPolicy } from './runner.js';

const NOW = 1_700_000_000_000;
const STALE_AGO = NOW - 6 * 60_000; // 6m ago: past the 5m stall, before the 1h dormant window.
const FORCE_REVIEW_AGO = NOW - 20 * 60_000; // 20m ago: PAST the 15m FORCE_REVIEW_STALL_MS, still under the 1h dormant window.

/** A tmux-addressable session (highest-precedence rail) whose activity is `stale`. */
function tmuxSession(over: Partial<ActiveSession> & { mux?: MuxLocation } = {}): ActiveSession {
  const provenance: SessionProvenance = {
    host: 'zion',
    transport: 'local',
    mux: over.mux ?? { kind: 'tmux', pane: '%3', socket: '/tmp/s' },
    reply: { rail: 'tmux', target: '%3', socket: '/tmp/s' },
  };
  return {
    context: 'terminal',
    kind: 'claude',
    host: over.host ?? 'iterm',
    sessionId: over.sessionId ?? 'sess-tmux',
    status: 'idle',
    startedAtMs: over.startedAtMs ?? STALE_AGO, // defaultLastActivity falls back to this (no transcript file)
    provenance,
    ...over,
  };
}

/** A Ghostty session with NO tmux — the resolver reports it un-addressable. */
function ghosttySession(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'ghostty',
    sessionId: over.sessionId ?? 'sess-ghostty',
    status: 'idle',
    startedAtMs: STALE_AGO,
    provenance: { host: 'zion', transport: 'local', reply: null },
    ...over,
  };
}

// A Claude assistant turn that ANNOUNCES an action with no tool call after it —
// the promise-without-toolcall signal isLikelyTrulyBlocked looks for.
const PROMISE_TAIL = [
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"add the flag"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me run the tests now."}]}}',
];
// A completed turn — COMPLETION_HINTS ("finished") make isLikelyTrulyBlocked refuse.
const DONE_TAIL = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The feature is finished and pushed."}]}}',
];

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-runner-'));
});
afterEach(() => {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readLedger(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'nudges.json'), 'utf8')); } catch { return {}; }
}
function readFlags(): Record<string, { reason: string; host?: string; atMs: number }> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'flags.json'), 'utf8')); } catch { return {}; }
}

describe('runWatchdogTick — nudge fires', () => {
  it('injects on promise-without-toolcall + addressable, and records the cooldown', async () => {
    const s = tmuxSession();
    const result = await runWatchdogTick({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });

    const o = result.outcomes[0];
    expect(o.stall).toBe('stalled');
    expect(o.decision).toBe('nudge');
    expect(o.addressable).toBe(true);
    expect(o.rail).toBe('tmux');
    expect(o.injected).toBe(true);
    expect(o.nudgeText).toBe('Continue.');
    expect(result.counts.nudged).toBe(1);
    // Cooldown ledger updated so the next tick within cooldownMs is rate-limited.
    expect(readLedger()['sess-tmux']).toBe(NOW);
  });

  it('honors a custom nudge text', async () => {
    const result = await runWatchdogTick({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      nudgeText: 'Keep going.', tailFor: () => PROMISE_TAIL,
    });
    expect(result.outcomes[0].injected).toBe(true);
    expect(result.outcomes[0].nudgeText).toBe('Keep going.');
  });
});

describe('runWatchdogTick — skips (no nudge)', () => {
  it('SKIPS a session waiting on the user (AskUserQuestion), even if stalled', async () => {
    const s = tmuxSession({ activity: 'waiting_input', awaitingReason: 'question' });
    const result = await runWatchdogTick({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, // promise present, but activity=waiting_input wins
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    expect(o.reason).toMatch(/waiting on user/i);
    expect(readLedger()['sess-tmux']).toBeUndefined();
  });

  it('SKIPS a completed session (no promise-without-toolcall)', async () => {
    const result = await runWatchdogTick({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => DONE_TAIL,
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('stalled');
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    expect(result.counts.nudged).toBe(0);
  });

  it('SKIPS a completed session even PAST the 15m force-review window (never nudges a finished session)', async () => {
    // Regression: isLikelyTrulyBlocked short-circuits to `true` at >=15m stall
    // (FORCE_REVIEW_STALL_MS) BEFORE its completion check, so the deterministic
    // path must screen completions out itself. This session is idle 20m with a
    // "finished" tail — it must still be skipped, not injected with "Continue.".
    const s = tmuxSession({ startedAtMs: FORCE_REVIEW_AGO });
    const result = await runWatchdogTick({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => DONE_TAIL,
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('stalled');
    expect(o.stalledForMs).toBeGreaterThanOrEqual(15 * 60_000); // past FORCE_REVIEW
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    expect(o.reason).toMatch(/completion/i);
    expect(result.counts.nudged).toBe(0);
    expect(readLedger()['sess-tmux']).toBeUndefined();
  });

  it('SKIPS and FLAGS an un-addressable stall (ghostty, no tmux) — never injects a guessed target', async () => {
    const result = await runWatchdogTick({
      sessions: [ghosttySession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.addressable).toBe(false);
    expect(o.injected).toBeUndefined();
    expect(o.reason).toMatch(/un-addressable/i);
    expect(result.counts.unaddressable).toBe(1);
    // Flagged for the menu-bar to surface.
    const flags = readFlags();
    expect(flags['sess-ghostty']).toBeDefined();
    expect(flags['sess-ghostty'].host).toBe('ghostty');
    // Nothing delivered → no cooldown entry.
    expect(readLedger()['sess-ghostty']).toBeUndefined();
  });

  it('SKIPS within cooldown (rate-limited by a recent nudge)', async () => {
    // Seed a nudge 1 minute ago — inside the 20m default cooldown.
    fs.writeFileSync(path.join(stateDir, 'nudges.json'), JSON.stringify({ 'sess-tmux': NOW - 60_000 }));
    const result = await runWatchdogTick({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('rate_limited');
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    // The seeded timestamp is untouched (no re-nudge).
    expect(readLedger()['sess-tmux']).toBe(NOW - 60_000);
  });

  it('handsoff policy: detects + flags a nudge-worthy stall but NEVER injects', async () => {
    const policyFor = (): WatchdogPolicy => 'handsoff';
    const result = await runWatchdogTick({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, policyFor,
    });
    const o = result.outcomes[0];
    expect(o.policy).toBe('handsoff');
    expect(o.decision).toBe('nudge');       // it WOULD nudge...
    expect(o.addressable).toBe(true);
    expect(o.injected).toBe(false);          // ...but never does
    expect(o.reason).toMatch(/handsoff/i);
    expect(readLedger()['sess-tmux']).toBeUndefined();
    // Flagged for the tray to surface "would-nudge but hands-off".
    const flags = readFlags();
    expect(flags['sess-tmux']).toBeDefined();
    expect(flags['sess-tmux'].reason).toMatch(/hands-off/i);
    expect(flags['sess-tmux'].host).toBe('iterm');
  });

  it('policy off: fully opted out, not even classified as stalled', async () => {
    const result = await runWatchdogTick({
      sessions: [tmuxSession()], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL, policyFor: () => 'off',
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('opted_out');
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
  });
});

describe('runWatchdogTick — dry run (default, no --nudge)', () => {
  it('reports WOULD-nudge without injecting or touching the cooldown', async () => {
    const result = await runWatchdogTick({
      sessions: [tmuxSession()], nowMs: NOW, nudge: false, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });
    const o = result.outcomes[0];
    expect(o.decision).toBe('nudge');
    expect(o.addressable).toBe(true);
    expect(o.injected).toBe(false);
    expect(o.reason).toMatch(/would nudge/i);
    expect(result.didNudge).toBe(false);
    expect(readLedger()['sess-tmux']).toBeUndefined();
  });
});

describe('runWatchdogTick — active / not-yet-stalled', () => {
  it('SKIPS an active session (recent activity)', async () => {
    const s = tmuxSession({ startedAtMs: NOW - 5_000 }); // 5s ago — well under the stall threshold
    const result = await runWatchdogTick({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });
    const o = result.outcomes[0];
    expect(o.stall).toBe('active');
    expect(o.decision).toBe('skip');
    expect(o.injected).toBeUndefined();
    // Sanity: the default stall threshold is 5m, so 5s is active.
    expect(DEFAULT_THRESHOLDS.stallMs).toBe(300_000);
  });

  it('SKIPS a session with no session id (cannot address or track)', async () => {
    const s = tmuxSession({ sessionId: undefined });
    const result = await runWatchdogTick({
      sessions: [s], nowMs: NOW, nudge: true, injectDryRun: true, stateDir,
      tailFor: () => PROMISE_TAIL,
    });
    expect(result.outcomes[0].decision).toBe('skip');
    expect(result.outcomes[0].reason).toMatch(/no session id/i);
  });
});
