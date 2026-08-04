import { describe, test, expect } from 'bun:test';
import {
  agentReadyFailureAction,
  buildAutoRotateLaunchCommand,
  classifyTailForRotate,
  parseNoHealthyError,
  parseResetTimeMs,
} from './autoRotate';

// Captured-real shape of the CLI's fail-loud line (RUSH-2132): nonzero exit,
// stderr containing the literal `no healthy`, and the reset as
// `reset.toISOString()` — ALWAYS milliseconds + Z (or `unknown (no reset
// timestamps in any snapshot)` when no snapshot carries one).
const CONTRACT_ERROR =
  "agents: no healthy claude account under strategy 'balanced' — excluded: work@example.com (weekly), " +
  'home@example.com (weekly); earliest window resets 2026-08-10T14:00:00.000Z. Use --strategy pinned to force the default.';

describe('buildAutoRotateLaunchCommand', () => {
  test('local terminal: no --host, lets CLI affinity pick', () => {
    expect(buildAutoRotateLaunchCommand({ sessionId: 'uuid-1' })).toBe(
      'agents run auto --interactive --session-id uuid-1',
    );
  });

  test('remote terminal rotates on its own host, shell-quoted', () => {
    expect(buildAutoRotateLaunchCommand({ host: 'yosemite-s0', sessionId: 'uuid-2' })).toBe(
      "agents run auto --interactive --host 'yosemite-s0' --session-id uuid-2",
    );
  });

  test('host quoting survives a single quote in the device name', () => {
    const cmd = buildAutoRotateLaunchCommand({ host: "o'brien", sessionId: 'uuid-3' });
    expect(cmd).toBe("agents run auto --interactive --host 'o'\\''brien' --session-id uuid-3");
  });

  test('session id is always pinned (CLI honors it only for claude)', () => {
    expect(buildAutoRotateLaunchCommand({ sessionId: 'abc' })).toContain('--session-id abc');
  });
});

describe('parseNoHealthyError', () => {
  test('parses the contract error: harness + exact ISO reset', () => {
    const now = Date.parse('2026-08-03T19:00:00.000Z');
    const hit = parseNoHealthyError(CONTRACT_ERROR, now);
    expect(hit).not.toBeNull();
    expect(hit!.agentKey).toBe('claude');
    expect(hit!.resetsAtMs).toBe(Date.parse('2026-08-10T14:00:00.000Z'));
  });

  test('returns null for unrelated text', () => {
    expect(parseNoHealthyError('all systems operational', Date.now())).toBeNull();
  });

  test('detects the error even without a parseable reset', () => {
    const hit = parseNoHealthyError('agents: no healthy codex account under strategy \'balanced\'', Date.now());
    expect(hit).not.toBeNull();
    expect(hit!.agentKey).toBe('codex');
    expect(hit!.resetsAtMs).toBeUndefined();
  });

  test('CLI "unknown" reset yields no cooldown horizon', () => {
    const hit = parseNoHealthyError(
      "agents: no healthy claude account under strategy 'balanced' — excluded: a@x.com; " +
        'earliest window resets unknown (no reset timestamps in any snapshot). Use --strategy pinned to force the default.',
      Date.now(),
    );
    expect(hit).not.toBeNull();
    expect(hit!.resetsAtMs).toBeUndefined();
  });
});

describe('parseResetTimeMs — the CLI ISO form (reset.toISOString())', () => {
  const now = Date.parse('2026-08-03T19:00:00.000Z');

  test('milliseconds + Z parse as UTC, not local — the review-#1 regression', () => {
    // A capture that stops at the milliseconds dot drops the Z and Date.parse
    // reads LOCAL time: on PDT this would return 21:00Z, ending the
    // suppression 7h late; in UTC+ zones it would end EARLY and re-rotate
    // into exhausted accounts.
    expect(
      parseResetTimeMs('earliest window resets 2026-08-10T14:00:00.000Z. Use --strategy pinned', now),
    ).toBe(Date.parse('2026-08-10T14:00:00.000Z'));
  });

  test('midnight ISO with milliseconds passes through exactly', () => {
    expect(parseResetTimeMs('window resets 2026-08-10T00:00:00.000Z', now)).toBe(
      Date.parse('2026-08-10T00:00:00.000Z'),
    );
  });

  test('past ISO reset is rejected', () => {
    expect(parseResetTimeMs('window resets 2026-08-01T00:00:00.000Z', now)).toBeUndefined();
  });

  test('unknown reset is rejected', () => {
    expect(
      parseResetTimeMs('earliest window resets unknown (no reset timestamps in any snapshot)', now),
    ).toBeUndefined();
  });

  test('no reset clause', () => {
    expect(parseResetTimeMs('no healthy account', now)).toBeUndefined();
  });
});

// Time-of-day forms exist for the AGENT TRANSCRIPT-TAIL path — claude's own
// limit text ("You've hit your weekly limit. Resets 7am") — never the CLI.
describe('parseResetTimeMs — time-of-day forms (agent transcript tails)', () => {
  const now = Date.parse('2026-08-03T12:00:00-07:00'); // 2026-08-03T19:00Z, noon PDT

  test('time-of-day later today in the named zone', () => {
    // 7pm PDT today = 2026-08-04T02:00Z
    expect(parseResetTimeMs('resets 7pm (America/Los_Angeles)', now)).toBe(
      Date.parse('2026-08-04T02:00:00Z'),
    );
  });

  test('time-of-day already past rolls to tomorrow', () => {
    expect(parseResetTimeMs('resets 7am (America/Los_Angeles)', now)).toBe(
      Date.parse('2026-08-04T14:00:00Z'),
    );
  });

  test('minutes and pm handling', () => {
    expect(parseResetTimeMs('resets 8:30pm (America/Los_Angeles)', now)).toBe(
      Date.parse('2026-08-04T03:30:00Z'),
    );
  });
});

describe('classifyTailForRotate', () => {
  const now = Date.parse('2026-08-03T19:00:00.000Z');

  test('contract error tail → no_healthy_account with the exact ISO reset', () => {
    const v = classifyTailForRotate(CONTRACT_ERROR, now);
    expect(v.kind).toBe('no_healthy_account');
    if (v.kind === 'no_healthy_account') {
      expect(v.agentKey).toBe('claude');
      expect(v.resetsAtMs).toBe(Date.parse('2026-08-10T14:00:00.000Z'));
    }
  });

  test('agent weekly-limit tail → rate_limited', () => {
    const v = classifyTailForRotate(
      '{"type":"assistant","text":"You\'ve hit your weekly limit. Resets 7am"}',
      now,
    );
    expect(v.kind).toBe('rate_limited');
  });

  test('out-of-credits tail → rate_limited', () => {
    expect(classifyTailForRotate('error: out of extra usage', now).kind).toBe('rate_limited');
  });

  test('ordinary transcript prose → none', () => {
    const v = classifyTailForRotate(
      '{"type":"user","text":"can we talk about rate limits in the design doc?"}',
      now,
    );
    expect(v.kind).toBe('none');
  });

  test('no healthy wins over a rate-limit pattern in the same tail', () => {
    const v = classifyTailForRotate(`You've hit your weekly limit\n${CONTRACT_ERROR}`, now);
    expect(v.kind).toBe('no_healthy_account');
  });
});

describe('agentReadyFailureAction — old-terminal disposition when the launch dies', () => {
  test('blind launch (sendText): keep the old terminal, type nothing into the dead shell', () => {
    expect(agentReadyFailureAction(true)).toEqual({ sendResumeInput: false, closeOld: false });
  });

  test('observed launch (shell integration): legacy slow-TUI fallback — type anyway, honor close', () => {
    expect(agentReadyFailureAction(false)).toEqual({ sendResumeInput: true, closeOld: true });
  });
});
