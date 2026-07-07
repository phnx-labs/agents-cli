import { describe, test, expect } from 'bun:test';
import { resolveForemanTarget, candidateName, ForemanTargetCandidate } from './foreman.target';

const claude1: ForemanTargetCandidate = { id: 'cl-1', agentType: 'claude', label: 'auth refactor', sessionId: 'aaaa1111' };
const claude2: ForemanTargetCandidate = { id: 'cl-2', agentType: 'claude', label: 'dashboard', sessionId: 'bbbb2222' };
const codex1: ForemanTargetCandidate = { id: 'cx-1', agentType: 'codex', autoLabel: 'migration', sessionId: 'cccc3333' };

describe('resolveForemanTarget', () => {
  test('unique kind match resolves', () => {
    const r = resolveForemanTarget([claude1, codex1], 'codex');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.terminal.id).toBe('cx-1');
  });

  test('two of a kind is ambiguous, not a silent first-match', () => {
    const r = resolveForemanTarget([claude1, claude2, codex1], 'claude');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates).toEqual(['auth refactor', 'dashboard']);
    }
  });

  test('a specific label beats a bare kind even when several of that kind run', () => {
    // "auth" matches only claude1's label, so it must win over the 2-claude kind tie.
    const r = resolveForemanTarget([claude1, claude2, codex1], 'auth');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.terminal.id).toBe('cl-1');
  });

  test('autoLabel substring matches when no manual label is set', () => {
    const r = resolveForemanTarget([claude1, claude2, codex1], 'migrat');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.terminal.id).toBe('cx-1');
  });

  test('session id prefix matches one terminal', () => {
    const r = resolveForemanTarget([claude1, claude2, codex1], 'bbbb');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.terminal.id).toBe('cl-2');
  });

  test('no match returns the full candidate list to read back', () => {
    const r = resolveForemanTarget([claude1, codex1], 'gemini');
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.candidates).toEqual(['auth refactor', 'migration']);
  });

  test('empty who is not a match', () => {
    expect(resolveForemanTarget([claude1], '   ').kind).toBe('none');
  });

  test('candidateName prefers label, then autoLabel, then kind, then prefix, then id', () => {
    expect(candidateName(claude1)).toBe('auth refactor');
    expect(candidateName(codex1)).toBe('migration');
    expect(candidateName({ id: 'x', agentType: 'gemini' })).toBe('gemini');
    expect(candidateName({ id: 'x', prefix: 'sh' })).toBe('sh');
    expect(candidateName({ id: 'only-id' })).toBe('only-id');
  });
});
