import { describe, expect, test } from 'bun:test';
import { parsePrStatus } from './prBoard';

const URL = 'https://github.com/phnx-labs/agents-cli/pull/900';

function ghJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 900,
    title: 'feat: the thing',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { state: 'SUCCESS' },
    ],
    ...over,
  });
}

describe('parsePrStatus', () => {
  test('open + approved + green + mergeable -> readyToMerge', () => {
    const s = parsePrStatus(URL, ghJson())!;
    expect(s.state).toBe('open');
    expect(s.review).toBe('approved');
    expect(s.ci).toBe('passed');
    expect(s.mergeable).toBe('mergeable');
    expect(s.readyToMerge).toBe(true);
  });

  test('a pending check run means CI running, never ready', () => {
    const s = parsePrStatus(URL, ghJson({ statusCheckRollup: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }] }))!;
    expect(s.ci).toBe('running');
    expect(s.readyToMerge).toBe(false);
  });

  test('a failed conclusion means CI failed, never ready', () => {
    const s = parsePrStatus(URL, ghJson({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }))!;
    expect(s.ci).toBe('failed');
    expect(s.readyToMerge).toBe(false);
  });

  test('changes requested / review required / conflicting / draft / merged all block the button', () => {
    expect(parsePrStatus(URL, ghJson({ reviewDecision: 'CHANGES_REQUESTED' }))!.readyToMerge).toBe(false);
    expect(parsePrStatus(URL, ghJson({ reviewDecision: 'REVIEW_REQUIRED' }))!.readyToMerge).toBe(false);
    expect(parsePrStatus(URL, ghJson({ mergeable: 'CONFLICTING' }))!.readyToMerge).toBe(false);
    expect(parsePrStatus(URL, ghJson({ isDraft: true }))!.readyToMerge).toBe(false);
    expect(parsePrStatus(URL, ghJson({ state: 'MERGED' }))!.readyToMerge).toBe(false);
  });

  test('no checks at all -> ci null, still mergeable when approved', () => {
    const s = parsePrStatus(URL, ghJson({ statusCheckRollup: [] }))!;
    expect(s.ci).toBe(null);
    expect(s.readyToMerge).toBe(true);
  });

  test('garbage or empty output -> null, never a fabricated row', () => {
    expect(parsePrStatus(URL, '')).toBe(null);
    expect(parsePrStatus(URL, 'not json')).toBe(null);
    expect(parsePrStatus(URL, '{"title":"no number"}')).toBe(null);
  });
});
