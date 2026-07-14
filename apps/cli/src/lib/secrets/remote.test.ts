import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SshExecResult } from '../ssh-exec.js';

const { sshExecMock, resolveHostMock, resolveRemoteOsMock, emitMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn(),
  resolveHostMock: vi.fn(),
  resolveRemoteOsMock: vi.fn(),
  emitMock: vi.fn(),
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

vi.mock('../hosts/remote-os.js', () => ({
  resolveRemoteOsSync: resolveRemoteOsMock,
}));

// Spy on the audit emit so we can assert remote resolves are audited on the
// initiating host (remote.ts only imports `emit`).
vi.mock('../events.js', () => ({ emit: emitMock }));

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
  resolveRemoteOsMock.mockReset();
  resolveRemoteOsMock.mockReturnValue(undefined);
  emitMock.mockReset();
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

  it('passes -tt and disables multiplexing when tty is requested', () => {
    sshExecMock.mockReturnValue(ok(''));
    remoteSecretsRaw('host', ['view', 'b', '--reveal'], { tty: true });
    expect(sshExecMock.mock.calls[0][2]).toMatchObject({
      extraSshArgs: ['-tt'],
      multiplex: false,
    });
  });

  it('drives the keychain export push as `import --from -` and forwards the .env over stdin', () => {
    // This is the transport the `secrets export --host` keychain push uses: it
    // pipes the resolved dotenv over ssh stdin to `import --from -` (never the
    // POSIX-only `/dev/stdin`; no `create … || true`, which broke on Windows).
    sshExecMock.mockReturnValue(ok('Imported 2 key(s).'));
    const res = remoteSecretsRaw('mac-mini', ['import', 'mybundle', '--from', '-', '--force'], { input: 'A="1"\n' });
    expect(res.stdout).toBe('Imported 2 key(s).');
    const [target, remoteCmd, opts] = sshExecMock.mock.calls[0];
    expect(target).toBe('mac-mini');
    expect(remoteCmd).toBe(`bash -lc 'agents secrets import mybundle --from - --force'`);
    expect(remoteCmd).not.toContain('/dev/stdin');
    expect(remoteCmd).not.toContain('|| true');
    expect(opts.input).toBe('A="1"\n');
  });

  it('uses the original host name to build PowerShell for inline Windows targets', () => {
    resolveRemoteOsMock.mockImplementation((name: string) => name === 'win-mini' ? 'windows' : undefined);
    sshExecMock.mockReturnValue(ok('listed'));

    remoteSecretsRaw('muqsit@100.68.123.39', ['list'], { osLookupName: 'win-mini' });

    const [target, remoteCmd] = sshExecMock.mock.calls[0];
    expect(target).toBe('muqsit@100.68.123.39');
    expect(remoteCmd).toContain('powershell -NoProfile -EncodedCommand ');
    expect(remoteCmd).not.toContain('bash -lc');
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

  it('uses the original host name when resolving an inline Windows target', async () => {
    resolveRemoteOsMock.mockImplementation((name: string) => name === 'win-mini' ? 'windows' : undefined);
    sshExecMock.mockReturnValue(ok('{"FOO":"bar"}'));

    await expect(remoteResolveEnv('muqsit@100.68.123.39', 'r2.backups', { osLookupName: 'win-mini' }))
      .resolves.toEqual({ FOO: 'bar' });

    const [target, remoteCmd] = sshExecMock.mock.calls[0];
    expect(target).toBe('muqsit@100.68.123.39');
    expect(remoteCmd).toContain('powershell -NoProfile -EncodedCommand ');
    expect(remoteCmd).not.toContain('bash -lc');
  });

  it('audits the resolve on the initiating host (secrets.get, source=remote, no value)', async () => {
    sshExecMock.mockReturnValue(ok('{"FOO":"bar","BAZ":"qux"}'));
    await remoteResolveEnv('yosemite-s1', 'r2.backups');
    expect(emitMock).toHaveBeenCalledTimes(1);
    const [event, payload] = emitMock.mock.calls[0];
    expect(event).toBe('secrets.get');
    expect(payload).toMatchObject({
      module: 'secrets',
      bundle: 'r2.backups',
      source: 'remote',
      host: 'yosemite-s1',
      status: 'success',
      keyCount: 2,
    });
    // The audit record must never carry the resolved values.
    expect(JSON.stringify(payload)).not.toContain('bar');
    expect(JSON.stringify(payload)).not.toContain('qux');
  });

  it('does not emit an audit event when the remote resolve fails', async () => {
    sshExecMock.mockReturnValue({ code: 1, stdout: '', stderr: 'no such bundle', timedOut: false });
    await expect(remoteResolveEnv('host', 'b')).rejects.toThrow();
    expect(emitMock).not.toHaveBeenCalled();
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
