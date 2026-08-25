/**
 * The scope model behind `agents secrets unlock`.
 *
 * The bug these pin: `unlock` and the read path both derived their scope from the
 * ambient AGENTS_AGENT_NAME, so a grant made in a plain terminal was stored under
 * the literal harness `'cli'` while a read from inside an agent asked for
 * `'claude'`. The two never met, so a valid 7-day unlock was invisible to every
 * agent for its entire life and each read paid a fresh Touch ID (or was refused
 * outright in a headless context).
 */
import { describe, it, expect } from 'vitest';
import { GLOBAL_HARNESS, bundleScopeChain } from './scope.js';

describe('bundleScopeChain — own harness first, then the global grant', () => {
  it('an agent reads its own scope before the global one', () => {
    expect(bundleScopeChain('claude')).toEqual(['claude', GLOBAL_HARNESS]);
  });

  it('a global reader asks only the global scope (no redundant probe)', () => {
    expect(bundleScopeChain(GLOBAL_HARNESS)).toEqual([GLOBAL_HARNESS]);
  });

  it('an absent harness resolves to the global scope', () => {
    expect(bundleScopeChain(undefined)).toEqual([GLOBAL_HARNESS]);
    expect(bundleScopeChain('')).toEqual([GLOBAL_HARNESS]);
  });

  it('the global scope is not a legal harness name, so it cannot collide', () => {
    // Harness ids are bare words (claude, codex, kimi); '*' can never be one.
    expect(GLOBAL_HARNESS).toBe('*');
    expect(/^[a-z][a-z0-9-]*$/.test(GLOBAL_HARNESS)).toBe(false);
  });
});
