import { describe, it, expect } from 'vitest';
import { assertValidSshTarget, SSH_TARGET_RE, shellQuote } from './ssh-exec.js';

describe('assertValidSshTarget', () => {
  it('accepts bare host aliases and user@host', () => {
    expect(() => assertValidSshTarget('yosemite-s0')).not.toThrow();
    expect(() => assertValidSshTarget('muqsit@yosemite-s1')).not.toThrow();
    expect(() => assertValidSshTarget('box.local')).not.toThrow();
    expect(() => assertValidSshTarget('100.84.1.2')).not.toThrow();
  });

  it('rejects shell metacharacters and command injection', () => {
    expect(() => assertValidSshTarget('a;rm -rf /')).toThrow();
    expect(() => assertValidSshTarget('a$(whoami)')).toThrow();
    expect(() => assertValidSshTarget('a host')).toThrow();
    expect(() => assertValidSshTarget('a|b')).toThrow();
    expect(() => assertValidSshTarget('')).toThrow();
  });

  it('rejects a leading dash so a target cannot be smuggled as an ssh flag', () => {
    // This is the bug the bare regex misses — guarded explicitly in ssh-exec.
    expect(() => assertValidSshTarget('-oProxyCommand=evil')).toThrow();
    expect(() => assertValidSshTarget('-l')).toThrow();
    expect(SSH_TARGET_RE.test('-l')).toBe(true); // the bare regex matches '-l' — the leading-dash guard is what blocks it
  });
});

describe('shellQuote', () => {
  it('passes safe tokens through unquoted', () => {
    expect(shellQuote('claude')).toBe('claude');
    expect(shellQuote('/usr/bin/agents')).toBe('/usr/bin/agents');
  });

  it('single-quotes strings with spaces or shell metacharacters', () => {
    expect(shellQuote('fix the bug')).toBe("'fix the bug'");
    expect(shellQuote('a;b')).toBe("'a;b'");
  });

  it('escapes embedded single quotes correctly', () => {
    // it's -> 'it'\''s'  (close, escaped quote, reopen)
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
