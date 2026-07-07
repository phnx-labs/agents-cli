import { describe, expect, it } from 'vitest';
import { parsePattern, expandPatterns, defaultPatterns, isLegacyName } from '../resource-patterns.js';

describe('parsePattern', () => {
  it('parses a wildcard inclusion', () => {
    expect(parsePattern('user:*')).toEqual({ negate: false, source: 'user', name: '*' });
  });

  it('parses a named inclusion', () => {
    expect(parsePattern('system:brain-scan')).toEqual({ negate: false, source: 'system', name: 'brain-scan' });
  });

  it('parses a negation', () => {
    expect(parsePattern('!user:temp')).toEqual({ negate: true, source: 'user', name: 'temp' });
  });

  it('parses an alias source', () => {
    expect(parsePattern('rush:*')).toEqual({ negate: false, source: 'rush', name: '*' });
  });

  it('throws on missing colon', () => {
    expect(() => parsePattern('justname')).toThrow('Invalid resource pattern');
  });
});

describe('isLegacyName', () => {
  it('detects plain names as legacy', () => {
    expect(isLegacyName('brain-scan')).toBe(true);
    expect(isLegacyName('my-skill')).toBe(true);
  });

  it('treats pattern strings as non-legacy', () => {
    expect(isLegacyName('user:*')).toBe(false);
    expect(isLegacyName('!user:temp')).toBe(false);
    expect(isLegacyName('system:brain-scan')).toBe(false);
  });
});

describe('expandPatterns', () => {
  const available = new Map<string, string>([
    ['brain-scan', 'system'],
    ['browser-generate', 'system'],
    ['creative', 'user'],
    ['ragent', 'user'],
    ['my-skill', 'project'],
    ['rush-cmd', 'rush'],
  ]);

  it('expands user:* to all user resources', () => {
    expect(expandPatterns(['user:*'], available).sort()).toEqual(['creative', 'ragent']);
  });

  it('expands system:* to all system resources', () => {
    expect(expandPatterns(['system:*'], available).sort()).toEqual(['brain-scan', 'browser-generate']);
  });

  it('expands project:* to all project resources', () => {
    expect(expandPatterns(['project:*'], available)).toEqual(['my-skill']);
  });

  it('expands alias:* for extra repos', () => {
    expect(expandPatterns(['rush:*'], available)).toEqual(['rush-cmd']);
  });

  it('unions multiple wildcards', () => {
    const result = expandPatterns(['system:* user:*'], available);
    // "system:* user:*" is a single invalid token — test proper multi-element array
    const proper = expandPatterns(['system:*', 'user:*'], available);
    expect(proper.sort()).toEqual(['brain-scan', 'browser-generate', 'creative', 'ragent']);
  });

  it('subtracts negations', () => {
    const result = expandPatterns(['user:*', '!user:ragent'], available);
    expect(result).toEqual(['creative']);
  });

  it('handles named inclusions', () => {
    const result = expandPatterns(['system:brain-scan', 'user:creative'], available);
    expect(result.sort()).toEqual(['brain-scan', 'creative']);
  });

  it('ignores named inclusions that are not in available', () => {
    const result = expandPatterns(['user:nonexistent'], available);
    expect(result).toEqual([]);
  });

  it('skips malformed patterns without throwing', () => {
    expect(() => expandPatterns(['nocodon'], available)).not.toThrow();
    expect(expandPatterns(['nocodon'], available)).toEqual([]);
  });

  describe('comma-grouped names', () => {
    it('expands comma-separated names under the same source', () => {
      const result = expandPatterns(['system:brain-scan,browser-generate'], available);
      expect(result.sort()).toEqual(['brain-scan', 'browser-generate']);
    });

    it('handles spaces around commas', () => {
      const result = expandPatterns(['user:creative, ragent'], available);
      expect(result.sort()).toEqual(['creative', 'ragent']);
    });

    it('excludes comma-grouped names with negation', () => {
      const result = expandPatterns(['user:*', '!user:creative,ragent'], available);
      expect(result).toEqual([]);
    });

    it('mixes comma-grouped with wildcard in the same pattern list', () => {
      const result = expandPatterns(['system:brain-scan,browser-generate', 'user:*'], available);
      expect(result.sort()).toEqual(['brain-scan', 'browser-generate', 'creative', 'ragent']);
    });

    it('ignores comma-grouped names not in available', () => {
      const result = expandPatterns(['system:brain-scan,nonexistent'], available);
      expect(result).toEqual(['brain-scan']);
    });
  });
});

describe('defaultPatterns', () => {
  it('returns system + user + project by default', () => {
    expect(defaultPatterns()).toEqual(['system:*', 'user:*', 'project:*']);
  });

  it('inserts extra aliases between user and project', () => {
    expect(defaultPatterns(['rush', 'acme'])).toEqual(['system:*', 'user:*', 'rush:*', 'acme:*', 'project:*']);
  });

  it('omits project when includeProject is false', () => {
    expect(defaultPatterns([], false)).toEqual(['system:*', 'user:*']);
    expect(defaultPatterns(['rush'], false)).toEqual(['system:*', 'user:*', 'rush:*']);
  });
});
