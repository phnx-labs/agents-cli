/**
 * Unit tests for the pure pr-watch decision logic (issue #338).
 *
 * No network: checks and comments are injected as data into `decidePrActions`.
 * These cover the three behaviors the autonomous PR loop hinges on:
 *   1. a NEW failed check spawns a ci-fix teammate; an already-handled one does not
 *   2. a NEW review comment routes a review-fix (bugfix) teammate
 *   3. dedupe by check-run id / comment id prevents double-spawns
 * plus the injected-data prompt builders that carry logs / comment bodies through.
 */
import { describe, it, expect } from 'vitest';
import {
  decidePrActions,
  checkDedupeKey,
  commentDedupeKey,
  isFailedCheck,
  buildCiFixPrompt,
  buildReviewFixPrompt,
  parsePrUrl,
  type PrSnapshot,
  type PrCheck,
  type PrReviewComment,
  type PrWatchAction,
} from './pr-watch.js';

const PR = 'https://github.com/phnx-labs/agents-cli/pull/338';

const passingCheck: PrCheck = { name: 'build', state: 'SUCCESS', id: 'run-1' };
const failedCheck: PrCheck = {
  name: 'test',
  state: 'FAILURE',
  id: 'run-2',
  link: 'https://github.com/phnx-labs/agents-cli/actions/runs/2',
  workflow: 'tests.yml',
};
const pendingCheck: PrCheck = { name: 'lint', state: 'PENDING', id: 'run-3' };

const reviewComment: PrReviewComment = {
  id: 9001,
  body: 'This branch of the switch never returns — add a default.',
  user: 'reviewer',
  path: 'src/lib/teams/pr-watch.ts',
  html_url: 'https://github.com/phnx-labs/agents-cli/pull/338#discussion_r9001',
};

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    prUrl: PR,
    sourceTeammate: 'alice',
    checks: [],
    comments: [],
    ...overrides,
  };
}

describe('isFailedCheck', () => {
  it('treats terminal failure states as failed and success/pending as not', () => {
    expect(isFailedCheck(failedCheck)).toBe(true);
    expect(isFailedCheck({ name: 'x', state: 'error' })).toBe(true); // case-insensitive
    expect(isFailedCheck({ name: 'x', state: 'CANCELLED' })).toBe(true);
    expect(isFailedCheck(passingCheck)).toBe(false);
    expect(isFailedCheck(pendingCheck)).toBe(false);
    expect(isFailedCheck({ name: 'x', state: 'SKIPPING' })).toBe(false);
  });
});

describe('decidePrActions — CI failures', () => {
  it('spawns a ci-fix teammate for a NEW failure', () => {
    const actions = decidePrActions(
      snapshot({ checks: [passingCheck, failedCheck, pendingCheck] }),
      new Set()
    );
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<PrWatchAction, { kind: 'ci-fix' }>;
    expect(a.kind).toBe('ci-fix');
    expect(a.check.name).toBe('test');
    expect(a.sourceTeammate).toBe('alice');
    expect(a.dedupeKey).toBe(checkDedupeKey(PR, failedCheck));
  });

  it('does NOT spawn for an already-handled failure (dedupe by check id)', () => {
    const handled = new Set([checkDedupeKey(PR, failedCheck)]);
    const actions = decidePrActions(snapshot({ checks: [failedCheck] }), handled);
    expect(actions).toHaveLength(0);
  });

  it('spawns only for the new failure when one failure is already handled', () => {
    const otherFailure: PrCheck = { name: 'typecheck', state: 'FAILURE', id: 'run-9' };
    const handled = new Set([checkDedupeKey(PR, failedCheck)]);
    const actions = decidePrActions(
      snapshot({ checks: [failedCheck, otherFailure] }),
      handled
    );
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<PrWatchAction, { kind: 'ci-fix' }>;
    expect(a.check.name).toBe('typecheck');
  });

  it('spawns nothing when CI is all green', () => {
    const actions = decidePrActions(
      snapshot({ checks: [passingCheck, pendingCheck] }),
      new Set()
    );
    expect(actions).toHaveLength(0);
  });
});

describe('decidePrActions — review comments', () => {
  it('routes a bugfix teammate for a NEW review comment', () => {
    const actions = decidePrActions(snapshot({ comments: [reviewComment] }), new Set());
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<PrWatchAction, { kind: 'review-fix' }>;
    expect(a.kind).toBe('review-fix');
    expect(a.comment.id).toBe(9001);
    expect(a.sourceTeammate).toBe('alice');
    expect(a.dedupeKey).toBe(commentDedupeKey(PR, reviewComment));
  });

  it('does NOT re-route an already-handled comment (dedupe by comment id)', () => {
    const handled = new Set([commentDedupeKey(PR, reviewComment)]);
    const actions = decidePrActions(snapshot({ comments: [reviewComment] }), handled);
    expect(actions).toHaveLength(0);
  });
});

describe('decidePrActions — mixed', () => {
  it('emits both a ci-fix and a review-fix in one pass, skipping handled ids', () => {
    const handled = new Set([checkDedupeKey(PR, failedCheck)]); // CI already handled
    const actions = decidePrActions(
      snapshot({ checks: [failedCheck], comments: [reviewComment] }),
      handled
    );
    // CI failure is deduped away; only the fresh comment survives.
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('review-fix');
  });
});

describe('prompt builders inject the fetched data', () => {
  it('buildCiFixPrompt carries the injected logs and PR into the prompt', () => {
    const action = decidePrActions(
      snapshot({ checks: [failedCheck] }),
      new Set()
    )[0] as Extract<PrWatchAction, { kind: 'ci-fix' }>;
    const prompt = buildCiFixPrompt(action, 'FAIL src/x.test.ts: expected 1 got 2');
    expect(prompt).toContain(PR);
    expect(prompt).toContain('test');
    expect(prompt).toContain('FAIL src/x.test.ts');
    expect(prompt).toContain('SAME PR branch');
  });

  it('buildReviewFixPrompt carries the comment body and path', () => {
    const action = decidePrActions(
      snapshot({ comments: [reviewComment] }),
      new Set()
    )[0] as Extract<PrWatchAction, { kind: 'review-fix' }>;
    const prompt = buildReviewFixPrompt(action);
    expect(prompt).toContain(reviewComment.body);
    expect(prompt).toContain('pr-watch.ts');
    expect(prompt).toContain('@reviewer');
  });
});

describe('parsePrUrl', () => {
  it('parses owner/repo/number', () => {
    expect(parsePrUrl(PR)).toEqual({ owner: 'phnx-labs', repo: 'agents-cli', number: 338 });
  });
  it('returns null on a non-PR url', () => {
    expect(parsePrUrl('https://example.com/foo')).toBeNull();
  });
});
