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
vi.mock('../feed/events.js', () => ({ emit: emitMock }));

import {
  parseHostsOption,
  splitBundleRef,
  resolveHostSshTarget,
  remoteSecretsRaw,
  remoteResolveEnv,
  isDangerousRemoteEnvKey,
  verifyRemoteKeychainPush,
  evaluateKeychainWriteVerification,
  keychainWriteFailureMessage,
  buildRemoteFileImportCommand,
  assertCredentialTransportHostPinned,
  credentialTransportSshOpts,
} from './remote.js';

/** Flatten an ssh `-o KEY=VALUE` opt list to the KEY=VALUE strings for assertions. */
function optValues(hostKeyOpts: string[] | undefined): string[] {
  const out: string[] = [];
  for (let i = 0; i < (hostKeyOpts?.length ?? 0); i++) {
    if (hostKeyOpts![i] === '-o' && hostKeyOpts![i + 1]) out.push(hostKeyOpts![i + 1]);
  }
  return out;
}

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

  it('resolves --device identically to --host', () => {
    expect(parseHostsOption({ device: 'mac-mini' })).toEqual(['mac-mini']);
  });

  it('resolves --devices identically to --hosts', () => {
    expect(parseHostsOption({ devices: 'yosemite-s0,yosemite-s1' })).toEqual(['yosemite-s0', 'yosemite-s1']);
  });

  it('--host and --device dedupe to the same resolved target', () => {
    // A user passing both the host name and its device alias must not get it twice.
    expect(parseHostsOption({ host: 'mac-mini', device: 'mac-mini' })).toEqual(['mac-mini']);
  });

  it('composes all four flags in host,device,hosts,devices order, deduped', () => {
    expect(parseHostsOption({ host: 'a', device: 'b', hosts: 'c,a', devices: 'd,b' }))
      .toEqual(['a', 'b', 'c', 'd']);
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

describe('resolveHostSshTarget', () => {
  it('resolves an enrolled host through the registry', async () => {
    resolveHostMock.mockResolvedValue({ source: 'ssh-config', name: 'yosemite-s1' });
    expect(await resolveHostSshTarget('Y1')).toBe('yosemite-s1');
  });

  it('falls back to a raw ssh target when the registry misses', async () => {
    resolveHostMock.mockResolvedValue(null);
    expect(await resolveHostSshTarget('muqsit@box')).toBe('muqsit@box');
  });

  it('rejects an injection-shaped raw target', async () => {
    resolveHostMock.mockResolvedValue(null);
    await expect(resolveHostSshTarget('a;rm -rf /')).rejects.toThrow();
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
    // This is the transport the `secrets export --device` keychain push uses: it
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

  it('a plain browse call inherits the shared multiplexed baseline — no host-key pin', () => {
    // Only the secret-bearing push tightens the posture; a read-only `list`
    // should stay on the fast, shared connection (no needless pin churn).
    sshExecMock.mockReturnValue(ok('listed'));
    remoteSecretsRaw('yosemite-s1', ['list']);
    const opts = sshExecMock.mock.calls[0][2] ?? {};
    expect(opts.multiplex).toBeUndefined();
    expect(opts.hostKeyOpts).toBeUndefined();
  });

  it('a secret-bearing push pins the managed host key and refuses to multiplex (RUSH-2527)', () => {
    // The credential-transport posture: managed known_hosts (a changed key is
    // refused) plus no reusable control master left to the destination.
    sshExecMock.mockReturnValue(ok('Imported 2 key(s).'));
    remoteSecretsRaw('mac-mini', ['import', 'mybundle', '--from', '-'], { input: 'A="1"\n', secret: true });
    const opts = sshExecMock.mock.calls[0][2] ?? {};
    expect(opts.multiplex).toBe(false);
    const kv = optValues(opts.hostKeyOpts);
    expect(kv.some((s) => s.startsWith('UserKnownHostsFile='))).toBe(true);
    expect(kv.some((s) => s.startsWith('StrictHostKeyChecking='))).toBe(true);
  });

  it('tty COMPOSES with secret — a remote `view --reveal` both prompts AND pins the host key (RUSH-2527)', () => {
    // `tty` must not short-circuit past `secret`: a `view --reveal` over `--device`
    // allocates a PTY (for the prompt) AND streams the plaintext value back, so
    // it needs the managed host-key pin, not just `-tt` + no-multiplex.
    sshExecMock.mockReturnValue(ok('SECRET_VALUE'));
    remoteSecretsRaw('mac-mini', ['view', 'b', '--reveal'], { tty: true, secret: true });
    const opts = sshExecMock.mock.calls[0][2] ?? {};
    expect(opts.extraSshArgs).toEqual(['-tt']);
    expect(opts.multiplex).toBe(false);
    expect(optValues(opts.hostKeyOpts).some((s) => s.startsWith('StrictHostKeyChecking='))).toBe(true);
  });
});

describe('credentialTransportSshOpts (RUSH-2527)', () => {
  it('always refuses to multiplex and pins against the CLI-managed known_hosts store', () => {
    const opts = credentialTransportSshOpts('some-host');
    expect(opts.multiplex).toBe(false);
    const kv = optValues(opts.hostKeyOpts);
    expect(kv.find((s) => s.startsWith('UserKnownHostsFile='))).toBeDefined();
    expect(kv.find((s) => s.startsWith('StrictHostKeyChecking='))).toBeDefined();
  });

  it('matches on the host part of a user@host target for known_hosts lookup', () => {
    const a = credentialTransportSshOpts('muqsit@box');
    const b = credentialTransportSshOpts('box');
    expect(optValues(a.hostKeyOpts)).toEqual(optValues(b.hostKeyOpts));
  });
});

describe('remoteResolveEnv', () => {
  it('resolves a bundle to an env map via export --format json (no passphrase)', async () => {
    sshExecMock.mockReturnValue(ok('{"FOO":"bar","BAZ":"qux"}'));
    const env = await remoteResolveEnv('yosemite-s1', 'r2.backups');
    expect(env).toEqual({ FOO: 'bar', BAZ: 'qux' });
    const [, remoteCmd, opts] = sshExecMock.mock.calls[0];
    // The transport marker is what lets the remote's json emitter print at all —
    // the public shell-eval export mode was removed (RUSH-2774).
    expect(remoteCmd).toBe(`bash -lc 'export AGENTS_SECRETS_REMOTE_TRANSPORT=1; agents secrets export r2.backups --plaintext --format json'`);
    expect(opts.input).toBeUndefined();
    // The plaintext streams back over ssh stdout, so this read is secret-bearing:
    // it pins the managed host key and refuses to multiplex (RUSH-2527).
    expect(opts.multiplex).toBe(false);
    expect(optValues(opts.hostKeyOpts).some((s) => s.startsWith('StrictHostKeyChecking='))).toBe(true);
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

  it('drops dangerous-override keys returned by a peer, keeps benign ones (RUSH-1762)', async () => {
    // A compromised/misconfigured peer returns keys that would silently reshape
    // THIS process once merged (proxy MITM, base-url redirect, git/loader hijack).
    sshExecMock.mockReturnValue(ok(JSON.stringify({
      FOO: 'bar',                              // benign — kept
      ANTHROPIC_BASE_URL: 'http://evil.test',  // *_BASE_URL — dropped
      HTTPS_PROXY: 'http://evil.test:8080',    // *_PROXY — dropped
      ALL_PROXY: 'socks5://evil.test',         // *_PROXY — dropped
      GIT_SSH_COMMAND: 'ssh -o Foo=bar',       // GIT_* — dropped
      GIT_CONFIG_GLOBAL: '/tmp/evil',          // GIT_* — dropped
      LD_PRELOAD: '/tmp/evil.so',              // LD_* — dropped
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',// DYLD_* — dropped
      NODE_OPTIONS: '--require /tmp/evil.js',   // loader — dropped
    })));
    const env = await remoteResolveEnv('host', 'b');
    expect(env).toEqual({ FOO: 'bar' });
    for (const blocked of [
      'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'ALL_PROXY',
      'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL',
      'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS',
    ]) {
      expect(env).not.toHaveProperty(blocked);
    }
  });
});

describe('isDangerousRemoteEnvKey', () => {
  it('blocks the override classes and passes ordinary secret keys', () => {
    for (const k of [
      'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS',
      'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL',
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL',
    ]) {
      expect(isDangerousRemoteEnvKey(k)).toBe(true);
      expect(isDangerousRemoteEnvKey(k.toLowerCase())).toBe(true); // case-insensitive
    }
    for (const k of ['FOO', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'GITHUB_TOKEN', 'MY_PROXYING']) {
      expect(isDangerousRemoteEnvKey(k)).toBe(false);
    }
  });
});

describe('evaluateKeychainWriteVerification (post-push read-back verdict)', () => {
  it('passes when the read-back returns every pushed key', () => {
    expect(evaluateKeychainWriteVerification(['A', 'B'], { ok: true, keys: ['A', 'B', 'C'] }))
      .toEqual({ ok: true });
  });

  it('flags locked-keychain when a pushed key is absent from the read-back', () => {
    const v = evaluateKeychainWriteVerification(['A', 'B'], { ok: true, keys: ['A'] });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected failure');
    expect(v.kind).toBe('locked-keychain');
    expect(v.reason).toContain('B');
  });

  it('flags locked-keychain on the remote "not unlocked in the secrets agent" read-back error', () => {
    const v = evaluateKeychainWriteVerification(['A'], {
      ok: false,
      stderr: "Bundle 'apple.com' is not unlocked in the secrets agent.",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected failure');
    expect(v.kind).toBe('locked-keychain');
  });

  it('flags locked-keychain on the "stored item ... not found" read-back error', () => {
    const v = evaluateKeychainWriteVerification(['A'], {
      ok: false,
      stderr: "Bundle 'apple.com' key 'A': stored item 'agents-cli.secrets.apple.com.A' not found.",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected failure');
    expect(v.kind).toBe('locked-keychain');
  });

  it('does NOT diagnose a locked keychain from a transient SSH/network failure', () => {
    // A flaky connection must be re-surfaced as-is, never mislabeled "locked keychain".
    const v = evaluateKeychainWriteVerification(['A'], {
      ok: false,
      stderr: 'ssh: connect to host mac-mini port 22: Connection refused',
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected failure');
    expect(v.kind).toBe('error');
    expect(v.reason).toContain('Connection refused');
  });
});

describe('keychainWriteFailureMessage', () => {
  it('names the locked-login-keychain cause and steers to --remote-backend file', () => {
    const msg = keychainWriteFailureMessage('mac-mini', 'apple.com', 'the remote could not read it back');
    expect(msg).toContain('mac-mini');
    expect(msg).toContain('apple.com');
    expect(msg).toContain('login keychain is LOCKED');
    expect(msg).toContain('--remote-backend file');
    expect(msg).toContain('unlock the remote keychain');
  });
});

describe('verifyRemoteKeychainPush (real read-back over the stubbed SSH boundary)', () => {
  it('passes when the remote read-back returns the pushed keys, and never retains values', () => {
    // The remote export returns plaintext values; verification keeps only key names.
    sshExecMock.mockReturnValue(ok('{"APPLE_ID":"secret-value","APP_PWD":"another"}'));
    const v = verifyRemoteKeychainPush('mac-mini', 'apple.com', ['APPLE_ID', 'APP_PWD']);
    expect(v).toEqual({ ok: true });
    // The verdict must not leak the plaintext values it read back.
    expect(JSON.stringify(v)).not.toContain('secret-value');
    // It drove the same read a headless release performs.
    const [, remoteCmd] = sshExecMock.mock.calls[0];
    expect(remoteCmd).toContain('agents secrets export apple.com --plaintext --format json');
    expect(remoteCmd).toContain('AGENTS_SECRETS_REMOTE_TRANSPORT=1');
  });

  it('flags locked-keychain when the remote headless read-back fails with the not-unlocked guard', () => {
    // This is the real silent-failure: keychain write "succeeded" (exit 0 on the
    // import) but the value items are unreadable, so the remote's own headless read
    // (agentOnly guard) refuses — exactly what a later release hits.
    sshExecMock.mockReturnValue({
      code: 1,
      stdout: '',
      stderr: "Bundle 'apple.com' is not unlocked in the secrets agent. Run: agents secrets unlock apple.com",
      timedOut: false,
    });
    const v = verifyRemoteKeychainPush('mac-mini', 'apple.com', ['APPLE_ID']);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected failure');
    expect(v.kind).toBe('locked-keychain');
  });

  it('flags locked-keychain when a pushed key is missing from a successful read-back', () => {
    sshExecMock.mockReturnValue(ok('{"APPLE_ID":"v"}'));
    const v = verifyRemoteKeychainPush('mac-mini', 'apple.com', ['APPLE_ID', 'APP_PWD']);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected failure');
    expect(v.kind).toBe('locked-keychain');
    expect(v.reason).toContain('APP_PWD');
  });

  it('re-surfaces a transient error verbatim rather than diagnosing a locked keychain', () => {
    sshExecMock.mockReturnValue({ code: null, stdout: '', stderr: '', timedOut: true });
    const v = verifyRemoteKeychainPush('mac-mini', 'apple.com', ['APPLE_ID']);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected failure');
    expect(v.kind).toBe('error');
    expect(v.reason).toContain('timed out');
  });
});

describe('buildRemoteFileImportCommand (secrets export --device --remote-backend file)', () => {
  const DOTENV = 'APPLE_ID="me@example.com"\nAPPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"\n';

  it('with NO passphrase: builds a plain `import --backend file` with NO read/export prologue, .env is the only stdin', () => {
    // This is the headless-by-default path: no AGENTS_SECRETS_PASSPHRASE forwarded,
    // so it stays UNSET on the remote → the file store's machine-local key → headless
    // reads. The regression the fix closes: the old code REQUIRED a passphrase here.
    const { remoteCmd, input } = buildRemoteFileImportCommand('apple.com', DOTENV);
    expect(remoteCmd).toBe(`bash -lc 'agents secrets import apple.com --from - --backend file'`);
    // No passphrase-forwarding prologue at all — the giveaway that the remote runs headless.
    expect(remoteCmd).not.toContain('read -r AGENTS_SECRETS_PASSPHRASE');
    expect(remoteCmd).not.toContain('export AGENTS_SECRETS_PASSPHRASE');
    expect(remoteCmd).not.toContain('AGENTS_SECRETS_PASSPHRASE');
    // Stdin is JUST the .env — no passphrase line prepended.
    expect(input).toBe(DOTENV);
    expect(input.startsWith('\n')).toBe(false);
  });

  it('never forwards AGENTS_SECRETS_PASSPHRASE (PHNX-2371)', () => {
    const { remoteCmd, input } = buildRemoteFileImportCommand('apple.com', DOTENV);
    expect(remoteCmd).not.toContain('AGENTS_SECRETS_PASSPHRASE');
    expect(remoteCmd).toContain('agents secrets import apple.com --from - --backend file');
    expect(input).toBe(DOTENV);
  });

  it('threads --force through the file-backend import', () => {
    expect(buildRemoteFileImportCommand('b', DOTENV, { force: true }).remoteCmd)
      .toContain('--backend file --force');
    expect(buildRemoteFileImportCommand('b', DOTENV).remoteCmd)
      .toContain('--backend file');
    expect(buildRemoteFileImportCommand('b', DOTENV).remoteCmd)
      .not.toContain('--force');
  });

  it('sets policy never in the same import command', () => {
    const { remoteCmd } = buildRemoteFileImportCommand('b', DOTENV, { policyNever: true });
    expect(remoteCmd).toContain('agents secrets import b --from - --backend file --policy never --i-understand');
    expect(remoteCmd).not.toContain('secrets policy');
  });

  it('shell-quotes the bundle name against injection', () => {
    const evil = 'b; rm -rf /';
    // The bundle name is single-quoted inside the import command, which is itself
    // single-quoted for `bash -lc`, so the inner quotes come back re-escaped as
    // '\'' — the metacharacters are inert either way, so the remote shell can't run
    // the injected `rm`. Assert the safe escaped form, and that a bare unquoted
    // `; rm -rf /` never appears.
    const cmd = buildRemoteFileImportCommand(evil, DOTENV).remoteCmd;
    expect(cmd).toBe(
      `bash -lc 'agents secrets import '\\''b; rm -rf /'\\'' --from - --backend file'`,
    );
  });
});

describe('assertCredentialTransportHostPinned', () => {
  it('refuses a provider credential transfer before the destination key is pinned', () => {
    expect(() => assertCredentialTransportHostPinned('user@worker', false)).toThrow(/before its SSH host key is pinned/);
  });

  it('allows the transfer after the destination key is pinned', () => {
    expect(() => assertCredentialTransportHostPinned('user@worker', true)).not.toThrow();
  });
});
