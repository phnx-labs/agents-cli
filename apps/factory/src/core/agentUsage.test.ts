import { describe, test, expect } from 'bun:test';
import { rankAgentsByUsage, pickAgentByUsage, type UsageSession } from './agentUsage';

const NOW = Date.parse('2026-08-01T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Build a session with activity at `now - agoMs`.
function sess(agentType: string, agoMs: number): UsageSession {
  return { agentType, lastActivityMs: NOW - agoMs, startedAtMs: NOW - agoMs };
}

const ALL = ['claude', 'codex', 'gemini', 'cursor'];

describe('rankAgentsByUsage', () => {
  test('ranks the most-frequently-used installed agent first', () => {
    const sessions = [
      sess('codex', 2 * HOUR),
      sess('codex', 3 * HOUR),
      sess('codex', 5 * HOUR),
      sess('claude', 4 * HOUR),
    ];
    const ranked = rankAgentsByUsage(sessions, ALL, NOW);
    expect(ranked[0].agentType).toBe('codex');
    expect(ranked[0].sessions).toBe(3);
  });

  test('weights the last 24h heavily: one recent session beats several old ones', () => {
    // Claude: one session 2h ago (recent, weight 5).
    // Codex: three sessions 3-5 days ago (old, weight 1 each = 3).
    const sessions = [
      sess('claude', 2 * HOUR),
      sess('codex', 3 * DAY),
      sess('codex', 4 * DAY),
      sess('codex', 5 * DAY),
    ];
    const ranked = rankAgentsByUsage(sessions, ALL, NOW);
    expect(ranked[0].agentType).toBe('claude');
    expect(ranked[0].score).toBe(5);
    expect(ranked.find((r) => r.agentType === 'codex')?.score).toBe(3);
  });

  test('longer-term frequency still counts once recent activity is equal', () => {
    // Both used once recently (5 each); codex also has extra old history (+2).
    const sessions = [
      sess('claude', 1 * HOUR),
      sess('codex', 1 * HOUR),
      sess('codex', 3 * DAY),
      sess('codex', 6 * DAY),
    ];
    const ranked = rankAgentsByUsage(sessions, ALL, NOW);
    expect(ranked[0].agentType).toBe('codex');
    expect(ranked[0].score).toBe(7);
  });

  test('equal scores break toward the most recently active agent', () => {
    const sessions = [
      sess('claude', 5 * HOUR),
      sess('codex', 2 * HOUR),
    ];
    const ranked = rankAgentsByUsage(sessions, ALL, NOW);
    expect(ranked[0].agentType).toBe('codex');
    expect(ranked[0].score).toBe(ranked[1].score);
  });

  test('excludes agents that are not installed / signed-in', () => {
    // Gemini is the most-used, but not installed -> must not appear.
    const sessions = [
      sess('gemini', 1 * HOUR),
      sess('gemini', 2 * HOUR),
      sess('gemini', 3 * HOUR),
      sess('claude', 4 * HOUR),
    ];
    const ranked = rankAgentsByUsage(sessions, ['claude', 'codex'], NOW);
    expect(ranked.map((r) => r.agentType)).not.toContain('gemini');
    expect(ranked[0].agentType).toBe('claude');
  });

  test('falls back to startedAtMs when lastActivityMs is missing', () => {
    const started: UsageSession = { agentType: 'codex', lastActivityMs: 0, startedAtMs: NOW - 3 * HOUR };
    const ranked = rankAgentsByUsage([started], ALL, NOW);
    expect(ranked[0].agentType).toBe('codex');
    // 3h ago -> within 24h -> recent weight.
    expect(ranked[0].score).toBe(5);
  });

  test('a session with no timestamps is counted as old, not recent', () => {
    const noTime: UsageSession = { agentType: 'codex', lastActivityMs: 0, startedAtMs: 0 };
    const ranked = rankAgentsByUsage([noTime], ALL, NOW);
    expect(ranked[0].score).toBe(1);
  });
});

describe('pickAgentByUsage', () => {
  test('picks the top usage-ranked agent', () => {
    const sessions = [sess('codex', 2 * HOUR), sess('claude', 3 * DAY)];
    expect(pickAgentByUsage(sessions, ALL, 'claude', NOW)).toBe('codex');
  });

  test('falls back to the configured default when there is no history', () => {
    expect(pickAgentByUsage([], ALL, 'claude', NOW)).toBe('claude');
  });

  test('falls back to the default when all history is for uninstalled agents', () => {
    const sessions = [sess('gemini', 1 * HOUR), sess('cursor', 2 * HOUR)];
    expect(pickAgentByUsage(sessions, ['claude', 'codex'], 'claude', NOW)).toBe('claude');
  });

  test('returns null only when the default is itself not installed and no history exists', () => {
    expect(pickAgentByUsage([], ['codex'], 'claude', NOW)).toBeNull();
  });

  test('composes: the chosen key is one the caller can launch balanced on a host', () => {
    // The selector returns a plain agent key; the caller feeds it to
    // openSingleAgent(..., strategy='balanced', host). Assert the key is a
    // real installed agent, so the balanced+host composition is well-formed.
    const sessions = [sess('codex', 1 * HOUR), sess('codex', 2 * DAY)];
    const chosen = pickAgentByUsage(sessions, ALL, 'claude', NOW);
    expect(chosen).not.toBeNull();
    expect(ALL).toContain(chosen);
  });
});
