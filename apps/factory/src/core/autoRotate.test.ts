import { describe, test, expect } from 'bun:test';
import {
  buildAutoRotateLaunchCommand,
  classifyTailForRotate,
  parseNoHealthyError,
  parseResetTimeMs,
} from './autoRotate';

// The contract the CLI ships (RUSH-2132): nonzero exit, stderr containing the
// literal `no healthy` and `resets <time>`.
const CONTRACT_ERROR =
  "agents: no healthy claude account under strategy 'balanced' — excluded: work@example.com (weekly), " +
  'home@example.com (weekly); earliest window resets 7am (America/Los_Angeles). Use --strategy pinned to force the default.';

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
  test('parses the contract error: harness + reset time', () => {
    const now = Date.parse('2026-08-03T12:00:00-07:00'); // noon PDT
    const hit = parseNoHealthyError(CONTRACT_ERROR, now);
    expect(hit).not.toBeNull();
    expect(hit!.agentKey).toBe('claude');
    expect(hit!.resetsAtMs).toBeDefined();
    // 7am PDT is already past at noon → next occurrence is tomorrow 7am PDT.
    expect(hit!.resetsAtMs!).toBeGreaterThan(now);
    const asDate = new Date(hit!.resetsAtMs!);
    expect(asDate.toISOString()).toBe('2026-08-04T14:00:00.000Z');
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
});

describe('parseResetTimeMs', () => {
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

  test('ISO reset passes through when in the future', () => {
    expect(parseResetTimeMs('window resets 2026-08-10T00:00:00Z', now)).toBe(
      Date.parse('2026-08-10T00:00:00Z'),
    );
  });

  test('past ISO reset is rejected', () => {
    expect(parseResetTimeMs('window resets 2026-08-01T00:00:00Z', now)).toBeUndefined();
  });

  test('no reset clause', () => {
    expect(parseResetTimeMs('no healthy account', now)).toBeUndefined();
  });
});

describe('classifyTailForRotate', () => {
  const now = Date.parse('2026-08-03T12:00:00-07:00');

  test('contract error tail → no_healthy_account with reset', () => {
    const v = classifyTailForRotate(CONTRACT_ERROR, now);
    expect(v.kind).toBe('no_healthy_account');
    if (v.kind === 'no_healthy_account') {
      expect(v.agentKey).toBe('claude');
      expect(v.resetsAtMs).toBeGreaterThan(now);
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
