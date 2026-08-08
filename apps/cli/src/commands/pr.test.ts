/**
 * Tests for `agents pr land` logic — the pure helper functions only.
 * No network: check lists are injected directly into `classifyCiState`.
 * Network-bound wrappers are excluded; approval policy is tested through the
 * same production helper used by `hasNonAuthorApproval`.
 */
import { describe, it, expect } from 'vitest';
import { classifyCiState, isNonAuthorApproved, type PrReview } from './pr.js';
import type { PrCheck } from '../lib/teams/pr-watch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pass = (name: string): PrCheck => ({ name, state: 'SUCCESS' });
const skip = (name: string): PrCheck => ({ name, state: 'SKIPPING' });
const pending = (name: string): PrCheck => ({ name, state: 'PENDING' });
const fail = (name: string): PrCheck => ({
  name,
  state: 'FAILURE',
  link: 'https://github.com/phnx-labs/agents-cli/actions/runs/99',
});

// ---------------------------------------------------------------------------
// classifyCiState
// ---------------------------------------------------------------------------

describe('classifyCiState', () => {
  it('returns green when no checks are configured', () => {
    const result = classifyCiState([]);
    expect(result.kind).toBe('green');
  });

  it('returns green when all checks are SUCCESS', () => {
    const result = classifyCiState([pass('build'), pass('test'), pass('lint')]);
    expect(result.kind).toBe('green');
  });

  it('returns green when checks are a mix of SUCCESS and SKIPPING', () => {
    const result = classifyCiState([pass('build'), skip('deploy'), pass('test')]);
    expect(result.kind).toBe('green');
  });

  it('returns pending when at least one check is PENDING', () => {
    const result = classifyCiState([pass('build'), pending('test')]);
    expect(result.kind).toBe('pending');
  });

  it('returns failed when at least one check is FAILURE', () => {
    const result = classifyCiState([pass('build'), fail('test'), pending('lint')]);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.check.name).toBe('test');
  });

  it('returns failed (not pending) when a failure co-exists with a pending check', () => {
    // Failed takes priority: we fail loud, not wait
    const result = classifyCiState([fail('test'), pending('lint')]);
    expect(result.kind).toBe('failed');
  });

  it('treats NEUTRAL as a passing state', () => {
    const result = classifyCiState([{ name: 'x', state: 'NEUTRAL' }]);
    expect(result.kind).toBe('green');
  });

  it('treats CANCELLED as a failure', () => {
    const result = classifyCiState([{ name: 'x', state: 'CANCELLED' }]);
    expect(result.kind).toBe('failed');
  });

  it('treats TIMED_OUT as a failure', () => {
    const result = classifyCiState([{ name: 'x', state: 'TIMED_OUT' }]);
    expect(result.kind).toBe('failed');
  });

  it('is case-insensitive for check states', () => {
    const lower = classifyCiState([{ name: 'x', state: 'failure' }]);
    expect(lower.kind).toBe('failed');
    const mixed = classifyCiState([{ name: 'x', state: 'Success' }]);
    expect(mixed.kind).toBe('green');
  });
});

// ---------------------------------------------------------------------------
// hasNonAuthorApproval policy
// ---------------------------------------------------------------------------

describe('non-author approval check', () => {
  it('returns true when a non-author has APPROVED', () => {
    const reviews: PrReview[] = [
      { state: 'APPROVED', user: 'reviewer1' },
    ];
    expect(isNonAuthorApproved(reviews, 'author')).toBe(true);
  });

  it('returns false when only the author has APPROVED (self-approval)', () => {
    const reviews: PrReview[] = [
      { state: 'APPROVED', user: 'author' },
    ];
    expect(isNonAuthorApproved(reviews, 'author')).toBe(false);
  });

  it('returns false when no one has APPROVED', () => {
    const reviews: PrReview[] = [
      { state: 'CHANGES_REQUESTED', user: 'reviewer1' },
    ];
    expect(isNonAuthorApproved(reviews, 'author')).toBe(false);
  });

  it('returns false when reviews list is empty', () => {
    expect(isNonAuthorApproved([], 'author')).toBe(false);
  });

  it('returns true when multiple reviewers, one of whom approved', () => {
    const reviews: PrReview[] = [
      { state: 'CHANGES_REQUESTED', user: 'reviewer1' },
      { state: 'APPROVED', user: 'reviewer2' },
    ];
    expect(isNonAuthorApproved(reviews, 'author')).toBe(true);
  });

  it('treats automated reviewer (prix-cloud) as a valid non-author approver', () => {
    const reviews: PrReview[] = [
      { state: 'APPROVED', user: 'prix-cloud' },
    ];
    expect(isNonAuthorApproved(reviews, 'author-bot')).toBe(true);
  });

  it('uses a reviewer latest decisive state and rejects a revoked approval', () => {
    const reviews: PrReview[] = [
      { state: 'APPROVED', user: 'reviewer1' },
      { state: 'CHANGES_REQUESTED', user: 'reviewer1' },
    ];
    expect(isNonAuthorApproved(reviews, 'author')).toBe(false);
  });

  it('does not let a later comment erase an approval', () => {
    const reviews: PrReview[] = [
      { state: 'APPROVED', user: 'reviewer1' },
      { state: 'COMMENTED', user: 'reviewer1' },
    ];
    expect(isNonAuthorApproved(reviews, 'author')).toBe(true);
  });
});
