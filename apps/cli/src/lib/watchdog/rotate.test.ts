/**
 * Tests for the watchdog rotate path (one-watchdog) — in-place rotation of a
 * rate-limited session onto a healthy account/harness in the SAME tab.
 *
 * Pure pieces (limit detection, reset parsing, exit-sequence table, launch
 * command, replay text) are asserted directly. The state machine is driven
 * through runWatchdogTick with real synthetic ActiveSession inputs and the
 * runner's injectable seams (rotateGate / tuiLiveFor / newSessionIdFor /
 * injectFn), per runner.test.ts's established pattern — no live terminal, no
 * real account probe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ActiveSession } from '../session/active.js';
import type { SessionProvenance } from '../session/provenance.js';
import type { InjectTarget } from '../terminal/inject.js';
import {
  runWatchdogTick,
  type SmartDecider,
  type WatchdogTickOptions,
} from './runner.js';
import {
  buildRotateLaunchCommand,
  buildRotateReplayText,
  classifyTailForRotate,
  exitSequenceFor,
  parseRotateResetMs,
  readRotateState,
  writeRotateState,
  DEFAULT_ROTATE_EXIT_SEQUENCE,
  DEFAULT_ROTATE_SKIP_COOLDOWN_MS,
  ROTATE_EXIT_SEQUENCES,
  type RotateState,
} from './rotate.js';

const NOW = 1_700_000_000_000; // 2023-11-14
const STALE_AGO = NOW - 6 * 60_000; // 6m ago: past the 5m stall, before the 1h dormant window.

/** Claude's weekly-limit line — the canonical hard-limit tail. */
const LIMIT_TAIL = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"You\'ve hit your weekly limit · resets 7am"}]}}',
];
/** A hard limit with an ISO reset the parser can pin exactly. */
const LIMIT_TAIL_ISO = [
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"You\'ve hit your weekly limit · resets 2026-08-10T14:00:00.000Z"}]}}',
];
const ISO_RESET_MS = Date.parse('2026-08-10T14:00:00.000Z');

/** A tmux-addressable session (highest-precedence rail) whose activity is stale. */
function tmuxSession(over: Partial<ActiveSession> = {}): ActiveSession {
  const provenance: SessionProvenance = {
    host: 'zion',
    transport: 'local',
    mux: { kind: 'tmux', pane: '%3', socket: '/tmp/s' },
    reply: { rail: 'tmux', target: '%3', socket: '/tmp/s' },
  };
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'iterm',
    sessionId: 'sess-tmux',
    status: 'idle',
    startedAtMs: STALE_AGO,
    provenance,
    ...over,
  };
}

/** A Ghostty session with NO tmux — the resolver reports it un-addressable. */
function ghosttySession(): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'ghostty',
    sessionId: 'sess-ghostty',
    status: 'idle',
    startedAtMs: STALE_AGO,
    provenance: { host: 'zion', transport: 'local', reply: null },
  };
}

let stateDir: string;
let logPath: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-rotate-'));
  logPath = path.join(stateDir, 'watchdog.log');
});
afterEach(() => {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface InjectCall { target: InjectTarget; text: string; opts: { dryRun?: boolean; enter?: boolean } }

/** A tick with the rotate seams wired: injects captured, decider tracked. */
function rig(over: Partial<WatchdogTickOptions> = {}) {
  const calls: InjectCall[] = [];
  let deciderCalled = false;
  const injectFn = async (target: InjectTarget, text: string, opts: { dryRun?: boolean; enter?: boolean }) => {
    calls.push({ target, text, opts });
    return { ok: true as const, backend: target.backend, writes: 1 };
  };
  const smartDecider: SmartDecider = async () => {
    deciderCalled = true;
    return { nudge: false, reason: 'synthetic decider' };
  };
  const run = (extra: Partial<WatchdogTickOptions> = {}) =>
    runWatchdogTick({
      logPath,
      openBlockFor: () => null,
      stateDir,
      nowMs: NOW,
      nudge: true,
      injectDryRun: true,
      rotateKeyDelayMs: 0,
      rotateGate: async () => ({ healthy: true, detail: 'picked claude' }),
      newSessionIdFor: () => 'new-sess-1',
      smartDecider,
      injectFn,
      ...over,
      ...extra,
    });
  return { run, calls, wasDeciderCalled: () => deciderCalled };
}

function readLogEvents(): Array<{ kind: string; message: string; terminalId?: string }> {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function readFlags(): Record<string, { reason: string; host?: string; atMs: number }> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'flags.json'), 'utf8')); } catch { return {}; }
}
function readNudgeLedger(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'nudges.json'), 'utf8')); } catch { return {}; }
}
function readSkipLedger(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'rotate-skips.json'), 'utf8')); } catch { return {}; }
}

// --- pure: detection ----------------------------------------------------------

describe('classifyTailForRotate', () => {
  it('detects claude\'s weekly-limit form and parses the time-of-day reset', () => {
    const v = classifyTailForRotate(LIMIT_TAIL, NOW);
    expect(v.kind).toBe('rate_limited');
    expect(v.resetsAtMs).toBeDefined();
    expect(v.resetsAtMs!).toBeGreaterThan(NOW);
  });

  it('detects a session/usage limit and parses an ISO reset exactly', () => {
    const v = classifyTailForRotate(LIMIT_TAIL_ISO, NOW);
    expect(v.kind).toBe('rate_limited');
    expect(v.resetsAtMs).toBe(ISO_RESET_MS);
  });

  it('matches the session-limit and out-of-credits variants', () => {
    expect(classifyTailForRotate(['hit your session limit'], NOW).kind).toBe('rate_limited');
    expect(classifyTailForRotate(['usage limit has been reached'], NOW).kind).toBe('rate_limited');
    expect(classifyTailForRotate(['rate limit exceeded'], NOW).kind).toBe('rate_limited');
    expect(classifyTailForRotate(['out of extra usage'], NOW).kind).toBe('rate_limited');
  });

  it('returns none for a normal tail (an agent merely DISCUSSING limits is not rotated)', () => {
    expect(classifyTailForRotate(['{"type":"assistant","message":{"content":"the config has limits on size"}}'], NOW).kind).toBe('none');
    expect(classifyTailForRotate([], NOW).kind).toBe('none');
  });
});

describe('parseRotateResetMs', () => {
  it('parses the ISO form with milliseconds + Z (never as local time)', () => {
    expect(parseRotateResetMs('resets 2026-08-10T14:00:00.000Z.', NOW)).toBe(ISO_RESET_MS);
  });
  it('refuses a reset already in the past (caller falls back to the default cooldown)', () => {
    expect(parseRotateResetMs('resets 2020-01-01T00:00:00.000Z', NOW)).toBeUndefined();
  });
  it('parses a zoned time-of-day form', () => {
    const ms = parseRotateResetMs("You've hit your weekly limit · resets 7am (America/Los_Angeles)", NOW);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(NOW);
  });
  it('returns undefined when no reset clause exists', () => {
    expect(parseRotateResetMs('usage limit reached', NOW)).toBeUndefined();
  });
});

// --- pure: exit sequence table (ported from factory prewarm.ts PREWARM_CONFIGS) ---

describe('exitSequenceFor (per-harness table)', () => {
  it('claude: Esc, Ctrl+C, Ctrl+C', () => {
    expect(exitSequenceFor('claude')).toEqual(['\x1b', '\x03', '\x03']);
  });
  it('codex / gemini / cursor / opencode: Ctrl+C twice', () => {
    for (const agent of ['codex', 'gemini', 'cursor', 'opencode']) {
      expect(exitSequenceFor(agent)).toEqual(['\x03', '\x03']);
    }
  });
  it('an unknown harness gets the default Ctrl+C pair', () => {
    expect(exitSequenceFor('kimi')).toEqual(DEFAULT_ROTATE_EXIT_SEQUENCE);
    expect(ROTATE_EXIT_SEQUENCES.kimi).toBeUndefined();
  });
});

// --- pure: launch command + replay text ---------------------------------------

describe('buildRotateLaunchCommand', () => {
  it('local terminal: run auto + session id, no --host', () => {
    expect(buildRotateLaunchCommand({ sessionId: 'abc' }))
      .toBe('agents run auto --interactive --session-id abc');
  });
  it('remote terminal: single-quotes the device name', () => {
    expect(buildRotateLaunchCommand({ host: 'mac mini', sessionId: 'abc' }))
      .toBe("agents run auto --interactive --host 'mac mini' --session-id abc");
    expect(buildRotateLaunchCommand({ host: "o'brien", sessionId: 'abc' }))
      .toBe("agents run auto --interactive --host 'o'\\''brien' --session-id abc");
  });
});

describe('buildRotateReplayText', () => {
  it('points the new session at the old transcript', () => {
    const text = buildRotateReplayText('old-123');
    expect(text).toContain('Resume previous work by loading session old-123');
    expect(text).toContain('agents sessions old-123');
    expect(text).toContain('continue working');
  });
});

// --- runner: limit tail routes to ROTATE, not nudge -----------------------------

describe('runWatchdogTick — limit tail rotates instead of nudging', () => {
  it('injects the exit sequence + run auto relaunch into the resolved rail; never nudges, never consults the brain', async () => {
    const { run, calls, wasDeciderCalled } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    const result = await run();

    const o = result.outcomes[0];
    expect(o.decision).toBe('rotate');
    expect(o.rotatePhase).toBe('awaiting-tui');
    expect(o.rail).toBe('tmux');
    expect(o.addressable).toBe(true);
    expect(result.counts.rotating).toBe(1);
    // The brain and the nudge ledger are untouched.
    expect(wasDeciderCalled()).toBe(false);
    expect(readNudgeLedger()['sess-tmux']).toBeUndefined();
    // claude exit sequence as RAW BYTES (enter: false), then the relaunch.
    expect(calls.map((c) => c.text)).toEqual([
      '\x1b', '\x03', '\x03',
      'agents run auto --interactive --session-id new-sess-1',
    ]);
    expect(calls[0].opts.enter).toBe(false);
    expect(calls[3].opts.enter).toBeUndefined();
    expect(calls.every((c) => (c.target as { backend: string }).backend === 'tmux')).toBe(true);
    // State machine persisted at rotate/<sessionId>.json.
    const state = readRotateState(stateDir, 'sess-tmux');
    expect(state?.phase).toBe('awaiting-tui');
    expect(state?.newSessionId).toBe('new-sess-1');
    expect(state?.deadlineMs).toBe(NOW + 60_000);
    // A rotate start event hit the shared log.
    expect(readLogEvents().some((e) => e.kind === 'rotate' && e.message.includes('rotating sess-tmux'))).toBe(true);
  });

  it('a dry tick (no --nudge) reports would-rotate and touches nothing', async () => {
    let gateCalled = false;
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      nudge: false,
      rotateGate: async () => { gateCalled = true; return { healthy: true, detail: '' }; },
    });
    const result = await run();
    expect(result.outcomes[0].decision).toBe('rotate');
    expect(result.outcomes[0].reason).toMatch(/dry/i);
    expect(calls).toHaveLength(0);
    expect(gateCalled).toBe(false);
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
  });

  it('handsoff policy: flags the rate-limited session, never rotates', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      policyFor: () => 'handsoff',
    });
    const result = await run();
    expect(result.outcomes[0].decision).toBe('skip');
    expect(result.outcomes[0].reason).toMatch(/handsoff/i);
    expect(calls).toHaveLength(0);
    expect(readFlags()['sess-tmux'].reason).toMatch(/hands-off/i);
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
  });
});

// --- runner: zero-healthy gate --------------------------------------------------

describe('runWatchdogTick — zero healthy accounts', () => {
  const zeroHealthy = { healthy: false as const, detail: "agents: no healthy harness for 'run auto'" };

  it('logs ONE rotate skip event per cooldown window and leaves the terminal untouched', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      rotateGate: async () => ({ ...zeroHealthy, resetsAtMs: NOW + 3_600_000 }),
    });
    const first = await run();
    expect(first.outcomes[0].decision).toBe('skip');
    expect(first.outcomes[0].reason).toMatch(/no healthy/i);
    expect(calls).toHaveLength(0); // terminal untouched
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
    // Cooldown came from the gate's earliestResetAcross.
    expect(readSkipLedger()['sess-tmux']).toBe(NOW + 3_600_000);
    const skipsAfterFirst = readLogEvents().filter((e) => e.kind === 'rotate' && e.message.includes('rotate skipped'));
    expect(skipsAfterFirst).toHaveLength(1);

    // A second tick inside the window: suppressed — no new event, still untouched.
    const second = await run();
    expect(second.outcomes[0].decision).toBe('skip');
    const skipsAfterSecond = readLogEvents().filter((e) => e.kind === 'rotate' && e.message.includes('rotate skipped'));
    expect(skipsAfterSecond).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('falls back to the parsed tail reset when the gate has none, then the 30m default', async () => {
    const { run } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL_ISO,
      rotateGate: async () => zeroHealthy, // no resetsAtMs
    });
    await run();
    expect(readSkipLedger()['sess-tmux']).toBe(ISO_RESET_MS);

    // No reset anywhere → 30m default.
    const { run: run2 } = rig({
      sessions: [tmuxSession({ sessionId: 'sess-b' })],
      tailFor: () => ['usage limit reached'],
      rotateGate: async () => zeroHealthy,
    });
    await run2();
    expect(readSkipLedger()['sess-b']).toBe(NOW + DEFAULT_ROTATE_SKIP_COOLDOWN_MS);
  });
});

// --- runner: the state machine across ticks --------------------------------------

describe('runWatchdogTick — rotate state machine', () => {
  it('happy path: begin → (old session drops out) → sweep replays → done', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    await run(); // tick 1: exiting → launching → awaiting-tui
    expect(calls).toHaveLength(4);

    // Tick 2: the old session is GONE from the active list (the exit sequence
    // killed it); the sweep advances the persisted machine. The new TUI is live.
    const result2 = await run({ sessions: [], tuiLiveFor: () => true });
    expect(result2.outcomes).toHaveLength(0); // sweep-advanced sessions carry no outcome row
    expect(calls).toHaveLength(5);
    const replay = calls[4];
    expect(replay.text).toContain('Resume previous work by loading session sess-tmux');
    expect(replay.text).toContain('agents sessions sess-tmux');
    expect((replay.target as { backend: string }).backend).toBe('tmux');
    const state = readRotateState(stateDir, 'sess-tmux');
    expect(state?.phase).toBe('done');
    expect(readLogEvents().some((e) => e.kind === 'rotate' && e.message.includes('rotated sess-tmux → new-sess-1'))).toBe(true);
  });

  it('readiness timeout: failed + flagged, nothing typed into the dead shell', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    await run(); // begin — 4 calls (exit trio + launch)
    const callsAfterBegin = calls.length;

    // Tick 2 past the 60s readiness deadline, TUI never came live.
    await run({ sessions: [], nowMs: NOW + 61_000, tuiLiveFor: () => false });
    expect(calls).toHaveLength(callsAfterBegin); // NO blind replay
    const state = readRotateState(stateDir, 'sess-tmux');
    expect(state?.phase).toBe('failed');
    expect(state?.error).toMatch(/not live within the readiness budget/i);
    expect(readFlags()['sess-tmux'].reason).toMatch(/rotate failed/i);
    expect(readLogEvents().some((e) => e.kind === 'rotate' && e.message.includes('rotate failed: sess-tmux'))).toBe(true);
  });

  it('an in-flight rotate OWNS its session in-loop: a still-listed stalled session advances, never nudges', async () => {
    const { run, calls, wasDeciderCalled } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    await run(); // begin
    // Tick 2: old session somehow still listed (and stalled) — the machine
    // advances in-loop rather than falling through to the nudge path.
    const result2 = await run({ sessions: [tmuxSession()], tuiLiveFor: () => true });
    const o = result2.outcomes[0];
    expect(o.decision).toBe('rotate');
    expect(o.rotatePhase).toBe('done');
    expect(wasDeciderCalled()).toBe(false);
    expect(calls).toHaveLength(5); // the replay
  });

  it('a dry tick never delivers the replay (machine holds, no inject)', async () => {
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
    });
    await run(); // begin (nudge: true via rig default)
    const callsAfterBegin = calls.length;
    await run({ sessions: [], nudge: false, tuiLiveFor: () => true });
    expect(calls).toHaveLength(callsAfterBegin);
    // Held at replaying — ready, but the dry tick may not inject.
    expect(readRotateState(stateDir, 'sess-tmux')?.phase).toBe('replaying');
  });

  it('un-addressable terminal (ghostty, no tmux): honest flag, no rotate, never a guessed target', async () => {
    const { run, calls } = rig({
      sessions: [ghosttySession()],
      tailFor: () => LIMIT_TAIL,
    });
    const result = await run();
    const o = result.outcomes[0];
    expect(o.decision).toBe('skip');
    expect(o.addressable).toBe(false);
    expect(o.reason).toMatch(/un-addressable/i);
    expect(calls).toHaveLength(0);
    expect(readFlags()['sess-ghostty']).toBeDefined();
    expect(readFlags()['sess-ghostty'].reason).toMatch(/rotate:/i);
    expect(readRotateState(stateDir, 'sess-ghostty')).toBeNull();
  });
});

// --- runner: config off ----------------------------------------------------------

describe('runWatchdogTick — watchdog.rotate: off', () => {
  it('a limit tail falls through to the normal nudge path; the gate is never consulted', async () => {
    let gateCalled = false;
    const { run, calls } = rig({
      sessions: [tmuxSession()],
      tailFor: () => LIMIT_TAIL,
      rotate: false,
      rotateGate: async () => { gateCalled = true; return { healthy: true, detail: '' }; },
    });
    const result = await run();
    expect(gateCalled).toBe(false);
    expect(calls).toHaveLength(0);
    expect(readRotateState(stateDir, 'sess-tmux')).toBeNull();
    // The brain decided skip (synthetic decider) — crucially NOT a rotate outcome.
    expect(result.outcomes[0].decision).toBe('skip');
    expect(result.outcomes[0].reason).toBe('synthetic decider');
  });
});

// --- state file round-trip --------------------------------------------------------

describe('rotate state persistence', () => {
  it('writeRotateState → readRotateState round-trips (target survives JSON)', () => {
    const state: RotateState = {
      sessionId: 'sess-x',
      newSessionId: 'new-x',
      agent: 'claude',
      phase: 'awaiting-tui',
      target: { backend: 'tmux', pane: '%3', socket: '/tmp/s' },
      startedAtMs: NOW,
      updatedAtMs: NOW,
      deadlineMs: NOW + 60_000,
    };
    expect(readRotateState(stateDir, 'sess-x')).toBeNull();
    writeRotateState(stateDir, state);
    const read = readRotateState(stateDir, 'sess-x');
    expect(read).toEqual(state);
  });
});
