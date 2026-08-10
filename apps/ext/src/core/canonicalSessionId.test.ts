import { describe, test, expect } from 'bun:test';
import { canonicalSessionId, isRolloutSessionStem } from './canonicalSessionId';

describe('canonicalSessionId', () => {
  test('extracts UUID from a Codex rollout stem', () => {
    expect(
      canonicalSessionId('rollout-2026-08-05T02-03-01-019fd129-6e9f-7082-ad08-9c22de9f1234'),
    ).toBe('019fd129-6e9f-7082-ad08-9c22de9f1234');
  });

  test('strips .jsonl and still extracts the UUID', () => {
    expect(
      canonicalSessionId(
        'rollout-2026-08-05T01-39-54-019fd114-4689-7df1-963f-ce06e5a36aeb.jsonl',
      ),
    ).toBe('019fd114-4689-7df1-963f-ce06e5a36aeb');
  });

  test('passes through a bare UUID (Claude / Grok / Codex /status)', () => {
    const id = '019fd199-da69-7c21-9477-5577a6dd725d';
    expect(canonicalSessionId(id)).toBe(id);
  });

  test('passes through OpenCode-style ids', () => {
    expect(canonicalSessionId('ses_abc123xyz')).toBe('ses_abc123xyz');
  });

  test('empty / whitespace / null → undefined', () => {
    expect(canonicalSessionId('')).toBeUndefined();
    expect(canonicalSessionId('   ')).toBeUndefined();
    expect(canonicalSessionId(null)).toBeUndefined();
    expect(canonicalSessionId(undefined)).toBeUndefined();
  });

  test('isRolloutSessionStem detects only rollout stems', () => {
    expect(isRolloutSessionStem('rollout-2026-08-05T00-00-00-aaaa-bbbb')).toBe(true);
    expect(isRolloutSessionStem('019fd199-da69-7c21-9477-5577a6dd725d')).toBe(false);
    expect(isRolloutSessionStem(undefined)).toBe(false);
  });
});
