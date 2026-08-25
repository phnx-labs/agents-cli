import { describe, it, expect } from 'vitest';
import { parsePolicy } from './setup-secrets.js';

/**
 * `agents setup secrets --policy` carried its own copy of the policy vocabulary
 * and never learned the 1.20.79 `daily` -> `hold` rename, so the onboarding
 * wizard rejected the CLI's own canonical name:
 *
 *   $ agents setup secrets --policy hold
 *   Invalid --policy 'hold'. Use daily, always, or never.
 *
 * It now shares `parsePolicyOpt` with `agents secrets policy`, so the two
 * commands cannot disagree about what a policy is called again.
 */
describe('setup secrets --policy', () => {
  it('accepts hold — the name every other secrets command uses', () => {
    expect(parsePolicy('hold')).toBe('hold');
  });

  it('still accepts the legacy daily/session spellings', () => {
    expect(parsePolicy('daily')).toBe('hold');
    expect(parsePolicy('session')).toBe('hold');
    expect(parsePolicy('DAILY')).toBe('hold');
  });

  it('keeps the other two tiers, including the legacy aliases', () => {
    expect(parsePolicy('always')).toBe('always');
    expect(parsePolicy('biometry')).toBe('always');
    expect(parsePolicy('never')).toBe('never');
    expect(parsePolicy('none')).toBe('never');
  });

  it('defaults to hold, not the parser-wide always default', () => {
    // parsePolicyOpt() alone defaults an absent value to `always`; the wizard's
    // own default has always been the hold tier, and must stay that way.
    expect(parsePolicy(undefined)).toBe('hold');
  });

  it('rejects an unknown policy', () => {
    expect(() => parsePolicy('sometimes')).toThrow(/Invalid policy/);
  });
});
