/**
 * Tests for git source parsing and transport validation.
 *
 * Focus: assertSafeGitTransport must reject the transports that lead to
 * clone-time RCE (ext::/fd:: remote helpers, option injection) or plaintext
 * MITM (http://, git://, file://), while still allowing https/ssh/SCP and
 * local paths. These checks are pure string logic, identical on every OS.
 */

import { describe, it, expect } from 'vitest';
import { assertSafeGitTransport, parseSource } from './git.js';

describe('assertSafeGitTransport', () => {
  const allowed = [
    'https://github.com/owner/repo.git',
    'https://gitlab.com/owner/repo',
    'ssh://git@github.com/owner/repo.git',
    'git@github.com:owner/repo.git', // SCP-style SSH
    'example.com:owner/repo.git', // SCP-style without user
    '/abs/local/path',
    './relative/path',
    'C:\\Users\\me\\repo', // Windows absolute path (no scheme)
  ];

  for (const src of allowed) {
    it(`allows ${src}`, () => {
      expect(() => assertSafeGitTransport(src)).not.toThrow();
    });
  }

  const rejected: Array<[string, RegExp]> = [
    ['ext::sh -c "id"', /remote-helper/],
    ['ext::sh -c touch\\ /tmp/pwned', /remote-helper/],
    ['fd::17/18', /remote-helper/],
    ['-oProxyCommand=evil', /interpreted as a git option/],
    ['--upload-pack=evil', /interpreted as a git option/],
    ['http://example.com/repo.git', /not an allowed transport/],
    ['git://example.com/repo.git', /not an allowed transport/],
    ['file:///etc/passwd', /not an allowed transport/],
  ];

  for (const [src, pattern] of rejected) {
    it(`rejects ${src}`, () => {
      expect(() => assertSafeGitTransport(src)).toThrow(pattern);
    });
  }

  it('ignores surrounding whitespace when classifying', () => {
    expect(() => assertSafeGitTransport('  ext::sh -c id  ')).toThrow(/remote-helper/);
  });
});

describe('parseSource transport safety', () => {
  it('rejects a generic http:// URL', () => {
    expect(() => parseSource('http://example.com/owner/repo')).toThrow(/not an allowed transport/);
  });

  it('accepts a generic https:// URL as type url', () => {
    const parsed = parseSource('https://example.com/owner/repo');
    expect(parsed.type).toBe('url');
    expect(parsed.url).toBe('https://example.com/owner/repo.git');
  });

  it('upgrades an http://github.com URL to https (does not reject)', () => {
    const parsed = parseSource('http://github.com/owner/repo');
    expect(parsed.type).toBe('github');
    expect(parsed.url).toBe('https://github.com/owner/repo.git');
  });

  it('keeps gh: shorthand on https', () => {
    const parsed = parseSource('gh:owner/repo');
    expect(parsed.type).toBe('github');
    expect(parsed.url).toBe('https://github.com/owner/repo.git');
  });
});
