import { describe, it, expect } from 'bun:test';
import { buildDraftInput, extractDraftText, draftDispatchPrompt } from './draftPrompt';

describe('buildDraftInput', () => {
  it('includes the identifier, title, and description of each ticket', () => {
    const out = buildDraftInput([
      { identifier: 'RUSH-1262', title: 'PKCE token exchange uses unpinned http client', description: 'Pin the client version.' },
    ]);
    expect(out).toContain('[RUSH-1262]');
    expect(out).toContain('PKCE token exchange uses unpinned http client');
    expect(out).toContain('Pin the client version.');
    // The instruction must forbid tool use so plan mode answers immediately.
    expect(out).toMatch(/Do NOT use any tools/i);
  });

  it('folds in the user hint when present', () => {
    const out = buildDraftInput([{ title: 'Fix the thing' }], 'keep it backward compatible');
    expect(out).toContain('keep it backward compatible');
  });

  it('skips empty tickets and omits the description line when absent', () => {
    const out = buildDraftInput([
      { title: '  ' },
      { identifier: 'RUSH-9', title: 'Real ticket' },
    ]);
    expect(out).toContain('[RUSH-9] Real ticket');
    expect(out).not.toContain('undefined');
  });

  it('clips a very long description', () => {
    const long = 'x'.repeat(5000);
    const out = buildDraftInput([{ title: 'T', description: long }]);
    expect(out).toContain('…');
    expect(out.length).toBeLessThanOrEqual(6000);
  });
});

describe('extractDraftText', () => {
  it('returns null for empty input', () => {
    expect(extractDraftText('')).toBeNull();
    expect(extractDraftText('   \n  ')).toBeNull();
  });

  it('unwraps a fenced code block', () => {
    expect(extractDraftText('```\nDo the work.\n```')).toBe('Do the work.');
    expect(extractDraftText('```text\nDo the work.\n```')).toBe('Do the work.');
  });

  it('strips a leading label and surrounding quotes', () => {
    expect(extractDraftText('Prompt: Fix the bug and add a test.')).toBe('Fix the bug and add a test.');
    expect(extractDraftText('"Fix the bug."')).toBe('Fix the bug.');
  });

  it('preserves multi-line paragraphs', () => {
    const s = 'Do the first thing.\nThen verify with the test suite.';
    expect(extractDraftText(s)).toBe(s);
  });
});

describe('draftDispatchPrompt', () => {
  it('returns null when there is nothing to draft from', async () => {
    expect(await draftDispatchPrompt([], '')).toBeNull();
    expect(await draftDispatchPrompt([{ title: '  ' }], '  ')).toBeNull();
  });

  it('drafts a real work order from a ticket (headless agent)', async () => {
    const result = await draftDispatchPrompt(
      [{ identifier: 'RUSH-1262', title: 'PKCE token exchange uses an unpinned http client', description: 'The rush CLI OAuth PKCE flow depends on an http client without a pinned version, a supply-chain risk. Pin it and add a regression test.' }],
      undefined,
      60000,
    );
    expect(result).toBeTruthy();
    expect(result!.length).toBeGreaterThan(20);
    expect(result!).not.toMatch(/^```/);
  }, 65000);

  it('returns null when the timeout is too short to complete', async () => {
    const result = await draftDispatchPrompt([{ title: 'Build a large feature' }], undefined, 1);
    expect(result).toBeNull();
  });
});
