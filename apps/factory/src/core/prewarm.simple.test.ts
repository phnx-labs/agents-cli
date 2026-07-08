import { describe, expect, test } from 'bun:test';
import { needsPrewarming, spawnSimplePrewarmSession } from './prewarm.simple';

describe('prewarm.simple', () => {
  test('needsPrewarming excludes claude and opencode', () => {
    expect(needsPrewarming('claude')).toBe(false);
    expect(needsPrewarming('opencode')).toBe(false);
  });

  test('needsPrewarming includes codex, gemini, and cursor', () => {
    expect(needsPrewarming('codex')).toBe(true);
    expect(needsPrewarming('gemini')).toBe(true);
    expect(needsPrewarming('cursor')).toBe(true);
  });

  test('opencode prewarm call does not mint a fake uuid session id', async () => {
    const result = await spawnSimplePrewarmSession('opencode', process.cwd());
    expect(result.status).toBe('failed');
    expect(result.sessionId).toBeUndefined();
    expect(result.failedReason).toBe('parse_error');
  });
});
