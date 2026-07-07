import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { assertValidSshTarget, SSH_TARGET_RE, shellQuote, controlOpts, SSH_OPTS } from './ssh-exec.js';

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

describe('SSH_OPTS (hardened baseline)', () => {
  it('keeps the connection hardening', () => {
    expect(SSH_OPTS).toContain('StrictHostKeyChecking=accept-new');
    expect(SSH_OPTS).toContain('BatchMode=yes');
    expect(SSH_OPTS).toContain('ConnectTimeout=10');
  });

  it('adds keepalive so a dropped link exits instead of zombying', () => {
    // ServerAliveInterval * ServerAliveCountMax bounds how long a dead
    // connection can hang before ssh gives up (~45s here).
    expect(SSH_OPTS).toContain('ServerAliveInterval=15');
    expect(SSH_OPTS).toContain('ServerAliveCountMax=3');
  });
});

describe('controlOpts (connection multiplexing)', () => {
  it('is empty on Windows (OpenSSH there has no ControlMaster support)', () => {
    if (process.platform !== 'win32') return; // asserted on the other branch below
    expect(controlOpts()).toEqual([]);
  });

  it('returns ControlMaster/ControlPath/ControlPersist and creates the socket dir', () => {
    if (process.platform === 'win32') return; // multiplexing skipped on Windows
    const opts = controlOpts();
    expect(opts).toContain('ControlMaster=auto');
    expect(opts).toContain('ControlPersist=60s');
    const cp = opts.find((o) => o.startsWith('ControlPath='));
    expect(cp).toBeDefined();
    // %C keeps the socket path short (macOS sun_path limit) and the dir must exist.
    expect(cp).toContain('%C');
    const dir = path.dirname(cp!.replace('ControlPath=', ''));
    expect(fs.existsSync(dir)).toBe(true);
  });
});
