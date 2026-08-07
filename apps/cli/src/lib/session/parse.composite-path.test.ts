import { describe, it, expect } from 'vitest';
import { splitSessionFilePath, sessionFilePathContainer } from './parse.js';

describe('splitSessionFilePath / sessionFilePathContainer (RUSH-2357)', () => {
  it('splits a composite path at the first # into container + fragment', () => {
    const p = '/home/u/.local/share/opencode/opencode.db#ses_02410a2c3ffeRumGfUNRgtB1Xk';
    expect(splitSessionFilePath(p)).toEqual({
      container: '/home/u/.local/share/opencode/opencode.db',
      fragment: 'ses_02410a2c3ffeRumGfUNRgtB1Xk',
    });
    expect(sessionFilePathContainer(p)).toBe('/home/u/.local/share/opencode/opencode.db');
  });

  it('leaves a plain per-session path untouched (no fragment)', () => {
    const p = '/home/u/.claude/projects/x/abc.jsonl';
    expect(splitSessionFilePath(p)).toEqual({ container: p, fragment: undefined });
    expect(sessionFilePathContainer(p)).toBe(p);
  });

  it('treats a trailing # (empty fragment) as no fragment', () => {
    expect(splitSessionFilePath('/a/b.db#')).toEqual({ container: '/a/b.db', fragment: undefined });
  });

  it('splits only at the FIRST # so a fragment may itself contain #', () => {
    expect(splitSessionFilePath('/a/b.db#id#extra')).toEqual({ container: '/a/b.db', fragment: 'id#extra' });
  });
});
