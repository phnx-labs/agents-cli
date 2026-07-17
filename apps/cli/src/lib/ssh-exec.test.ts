import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assertValidSshTarget, SSH_TARGET_RE, shellQuote, controlOpts, SSH_OPTS, sshConnectOpts, sshExecAsync } from './ssh-exec.js';

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

describe('sshConnectOpts (host-key override ordering)', () => {
  it('is the plain baseline when no override is given', () => {
    expect(sshConnectOpts(['-o', 'ControlMaster=auto'])).toEqual([
      ...SSH_OPTS,
      '-o', 'ControlMaster=auto',
    ]);
  });

  it('prepends host-key opts AHEAD of the accept-new baseline (RUSH-1767: ssh honors the first value)', () => {
    const override = ['-o', 'UserKnownHostsFile=/managed/kh', '-o', 'StrictHostKeyChecking=yes'];
    const args = sshConnectOpts([], override);
    const firstStrict = args.indexOf('StrictHostKeyChecking=yes');
    const baselineAcceptNew = args.indexOf('StrictHostKeyChecking=accept-new');
    // The strict override must appear before the baseline accept-new, or ssh
    // would silently keep accept-new and ship creds over an unverified connect.
    expect(firstStrict).toBeGreaterThanOrEqual(0);
    expect(baselineAcceptNew).toBeGreaterThan(firstStrict);
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

describe('sshExecAsync (real spawn via a PATH ssh stub — no mocks)', () => {
  // Put a genuine executable named `ssh` first on PATH so sshExecAsync's spawn('ssh')
  // runs it: a real subprocess round-trip that exercises stdout/stderr capture,
  // exit-code propagation, and the timeout -> SIGTERM path — the primitive the fleet
  // fan-out is built on — without needing a reachable host.
  function withStubSsh<T>(script: string, fn: () => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshstub-'));
    fs.writeFileSync(path.join(dir, 'ssh'), script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = dir + path.delimiter + prevPath;
    return fn().finally(() => {
      process.env.PATH = prevPath;
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('captures stdout/stderr and propagates the exit code from a real spawn', async () => {
    const res = await withStubSsh(
      '#!/bin/sh\nprintf "OUT_OK"\nprintf "ERR_OK" 1>&2\nexit 7\n',
      () => sshExecAsync('testhost', 'echo hi', { multiplex: false }),
    );
    expect(res.stdout).toContain('OUT_OK');
    expect(res.stderr).toContain('ERR_OK');
    expect(res.code).toBe(7);
    expect(res.timedOut).toBe(false);
  });

  it('kills the child and flags timedOut when it exceeds timeoutMs', async () => {
    const res = await withStubSsh(
      // exec so the killed pid IS the sleep (its stdio pipes close on death, firing
      // 'close'); a plain `sleep` child would orphan and hold the pipes open.
      '#!/bin/sh\nexec sleep 30\n',
      () => sshExecAsync('testhost', 'slow', { multiplex: false, timeoutMs: 150 }),
    );
    expect(res.timedOut).toBe(true);
    expect(res.code).toBeNull(); // SIGTERM-terminated child closes with a null exit code
  });
});
