import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SshExecResult } from '../ssh-exec.js';

const { sshExecMock, resolveHostMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn(),
  resolveHostMock: vi.fn(),
}));

// Keep the real assertValidSshTarget / shellQuote (so injection guarding and
// quoting are exercised for real); only the network call is stubbed.
vi.mock('../ssh-exec.js', async () => {
  const actual = await vi.importActual<typeof import('../ssh-exec.js')>('../ssh-exec.js');
  return { ...actual, sshExec: sshExecMock };
});

vi.mock('../hosts/registry.js', () => ({
  resolveHost: resolveHostMock,
}));

import {
  parseHostsOption,
  splitBundleRef,
  resolveSshTarget,
  remoteSecretsRaw,
  remoteResolveEnv,
} from './remote.js';

const ok = (stdout: string): SshExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });

beforeEach(() => {
  sshExecMock.mockReset();
  resolveHostMock.mockReset();
  delete process.env.AGENTS_SECRETS_PASSPHRASE;
});

describe('parseHostsOption', () => {
  it('returns empty when neither flag is set', () => {
    expect(parseHostsOption({})).toEqual([]);
  });

  it('takes a single --host', () => {
    expect(parseHostsOption({ host: 'yosemite-s1' })).toEqual(['yosemite-s1']);
  });

  it('splits a comma-separated --hosts list', () => {
    expect(parseHostsOption({ hosts: 'yosemite-s0,yosemite-s1' })).toEqual(['yosemite-s0', 'yosemite-s1']);
  });

  it('merges --host and --hosts, trims, drops empties, dedupes in order', () => {
    expect(parseHostsOption({ host: 'a', hosts: 'b, a ,,c' })).toEqual(['a', 'b', 'c']);
  });
});

describe('splitBundleRef', () => {
  it('treats a plain name as a local bundle', () => {
    expect(splitBundleRef('r2.backups')).toEqual({ bundle: 'r2.backups' });
  });

  it('splits bundle@host', () => {
    expect(splitBundleRef('r2.backups@yosemite-s1')).toEqual({ bundle: 'r2.backups', host: 'yosemite-s1' });
  });

  it('splits on the FIRST @ so a user@host target survives', () => {
    expect(splitBundleRef('r2.backups@muqsit@box')).toEqual({ bundle: 'r2.backups', host: 'muqsit@box' });
  });

  it('rejects a malformed reference with an empty side', () => {
    expect(() => splitBundleRef('@box')).toThrow(/Expected 'bundle@host'/);
    expect(() => splitBundleRef('bundle@')).toThrow(/Expected 'bundle@host'/);
  });
});

describe('resolveSshTarget', () => {
  it('resolves an enrolled host through the registry', async () => {
    resolveHostMock.mockResolvedValue({ source: 'ssh-config', name: 'yosemite-s1' });
    expect(await resolveSshTarget('Y1')).toBe('yosemite-s1');
  });

  it('falls back to a raw ssh target when the registry misses', async () => {
    resolveHostMock.mockResolvedValue(null);
    expect(await resolveSshTarget('muqsit@box')).toBe('muqsit@box');
  });

  it('rejects an injection-shaped raw target', async () => {
    resolveHostMock.mockResolvedValue(null);
    await expect(resolveSshTarget('a;rm -rf /')).rejects.toThrow();
  });
});

describe('remoteSecretsRaw', () => {
  it('drives the remote agents secrets CLI under bash -lc', () => {
    sshExecMock.mockReturnValue(ok('listed'));
    const res = remoteSecretsRaw('yosemite-s1', ['list']);
    expect(res.stdout).toBe('listed');
    const [target, remoteCmd, opts] = sshExecMock.mock.calls[0];
    expect(target).toBe('yosemite-s1');
    expect(remoteCmd).toBe(`bash -lc 'agents secrets list'`);
    expect(opts.extraSshArgs).toBeUndefined();
  });

  it('shell-quotes each argument against injection', () => {
    sshExecMock.mockReturnValue(ok(''));
    remoteSecretsRaw('host', ['view', 'a; rm -rf /']);
    const remoteCmd = sshExecMock.mock.calls[0][1] as string;
    // The malicious arg is single-quoted inside, so the remote shell can't run it.
    expect(remoteCmd).toContain(`'a; rm -rf /'`);
    expect(remoteCmd.startsWith('bash -lc ')).toBe(true);
  });

  it('passes -tt when tty is requested', () => {
    sshExecMock.mockReturnValue(ok(''));
    remoteSecretsRaw('host', ['view', 'b', '--reveal'], { tty: true });
    expect(sshExecMock.mock.calls[0][2].extraSshArgs).toEqual(['-tt']);
  });
});

describe('remoteResolveEnv', () => {
  it('resolves a bundle to an env map via export --format json (no passphrase)', async () => {
    sshExecMock.mockReturnValue(ok('{"FOO":"bar","BAZ":"qux"}'));
    const env = await remoteResolveEnv('yosemite-s1', 'r2.backups');
    expect(env).toEqual({ FOO: 'bar', BAZ: 'qux' });
    const [, remoteCmd, opts] = sshExecMock.mock.calls[0];
    expect(remoteCmd).toBe(`bash -lc 'agents secrets export r2.backups --plaintext --format json'`);
    expect(opts.input).toBeUndefined();
  });

  it('does NOT forward the local passphrase — the remote unlocks with its own', async () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'hunter2hunter2';
    sshExecMock.mockReturnValue(ok('{"FOO":"bar"}'));
    await remoteResolveEnv('host', 'b');
    const [, remoteCmd, opts] = sshExecMock.mock.calls[0];
    expect(opts.input).toBeUndefined();
    expect(remoteCmd).not.toContain('hunter2hunter2');
    expect(remoteCmd).not.toContain('AGENTS_SECRETS_PASSPHRASE');
  });

  it('tolerates login-shell banner noise around the JSON', async () => {
    sshExecMock.mockReturnValue(ok('Welcome to box\n{"A":"1"}\nlogout'));
    expect(await remoteResolveEnv('host', 'b')).toEqual({ A: '1' });
  });

  it('throws with the remote stderr on a non-zero exit', async () => {
    sshExecMock.mockReturnValue({ code: 1, stdout: '', stderr: 'no such bundle', timedOut: false });
    await expect(remoteResolveEnv('host', 'b')).rejects.toThrow(/no such bundle/);
  });

  it('throws a clear hint when the remote payload is not JSON', async () => {
    sshExecMock.mockReturnValue(ok('command not found: agents'));
    await expect(remoteResolveEnv('host', 'b')).rejects.toThrow(/--format json/);
  });
});
