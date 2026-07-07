import { describe, it, expect } from 'vitest';
import { validateJob, isPastEndAt, type JobConfig } from '../routines.js';

function base(overrides: Partial<JobConfig> = {}): Partial<JobConfig> {
  return {
    name: 'test',
    schedule: '0 9 * * *',
    agent: 'claude',
    prompt: 'noop',
    mode: 'plan',
    ...overrides,
  };
}

describe('validateJob — endAt field', () => {
  it('accepts a valid ISO 8601 timestamp', () => {
    expect(validateJob(base({ endAt: '2026-12-31T23:59:00Z' }))).toEqual([]);
  });

  it('accepts an ISO date with offset', () => {
    expect(validateJob(base({ endAt: '2026-12-31T15:00:00-08:00' }))).toEqual([]);
  });

  it('rejects an unparseable endAt string', () => {
    const errors = validateJob(base({ endAt: 'not-a-date' }));
    expect(errors.some((e) => e.includes('endAt'))).toBe(true);
  });

  it('rejects an empty endAt string', () => {
    const errors = validateJob(base({ endAt: '' }));
    expect(errors.some((e) => e.includes('endAt'))).toBe(true);
  });

  it('omitting endAt is allowed', () => {
    expect(validateJob(base())).toEqual([]);
  });
});

describe('isPastEndAt', () => {
  it('returns false when endAt is unset', () => {
    expect(isPastEndAt({})).toBe(false);
  });

  it('returns true for a past timestamp', () => {
    expect(isPastEndAt({ endAt: '2000-01-01T00:00:00Z' })).toBe(true);
  });

  it('returns false for a future timestamp', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isPastEndAt({ endAt: future })).toBe(false);
  });

  it('returns false when endAt is unparseable', () => {
    expect(isPastEndAt({ endAt: 'garbage' })).toBe(false);
  });
});
