/**
 * SSH invocation builder correctness.
 *
 * This is where auth is decided, so the real bugs are security- and
 * connectivity-shaped: password auth must route through the askpass shim and
 * disable pubkey/interactive prompts (else the password never reaches ssh, or
 * ssh hangs on a tty prompt); a Windows command must be wrapped in PowerShell
 * (a bare POSIX command silently fails on cmd); and the target must pass the
 * injection guard.
 */
import { describe, expect, it } from 'vitest';
import { buildSshInvocation, sshTargetFor, wrapRemoteCommand, ASKPASS_BUNDLE_ENV, ASKPASS_KEY_ENV } from './connect.js';
import type { DeviceProfile } from './registry.js';

function dev(over: Partial<DeviceProfile> & { name: string }): DeviceProfile {
  return {
    name: over.name,
    platform: over.platform ?? 'linux',
    shell: over.shell ?? 'posix',
    user: over.user,
    address: over.address ?? { via: 'tailscale', dnsName: `${over.name}.ts.net` },
    auth: over.auth ?? { method: 'key' },
    createdAt: '2026-06-30T00:00:00Z',
    updatedAt: '2026-06-30T00:00:00Z',
  };
}

describe('sshTargetFor', () => {
  it('builds user@host and rejects addressless devices', () => {
    expect(sshTargetFor(dev({ name: 'x', user: 'muqsit', address: { via: 'tailscale', dnsName: 'x.ts.net' } }))).toBe('muqsit@x.ts.net');
    expect(sshTargetFor(dev({ name: 'y', address: { via: 'manual', ip: '10.0.0.1' } }))).toBe('10.0.0.1');
    expect(() => sshTargetFor(dev({ name: 'z', address: { via: 'manual' } }))).toThrow(/no address/);
  });
});

describe('wrapRemoteCommand', () => {
  it('wraps Windows commands in PowerShell, leaves POSIX verbatim, undefined for interactive', () => {
    expect(wrapRemoteCommand(dev({ name: 'w', shell: 'powershell' }), ['hostname'])).toBe("powershell -NoProfile -Command hostname");
    expect(wrapRemoteCommand(dev({ name: 'l', shell: 'posix' }), ['uptime', '-p'])).toBe('uptime -p');
    expect(wrapRemoteCommand(dev({ name: 'i', shell: 'posix' }), [])).toBeUndefined();
  });
});

describe('buildSshInvocation', () => {
  it('key auth uses BatchMode and no askpass env', () => {
    const { args, env } = buildSshInvocation(dev({ name: 'k', user: 'me', auth: { method: 'key' } }), ['uptime'], '/shim');
    expect(args).toContain('BatchMode=yes');
    expect(args).not.toContain('PreferredAuthentications=password');
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(args[args.length - 2]).toBe('me@k.ts.net');
    expect(args[args.length - 1]).toBe('uptime');
  });

  it('password auth wires the askpass shim and disables pubkey + extra prompts', () => {
    const { args, env } = buildSshInvocation(
      dev({ name: 'p', user: 'muqsit', auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' } }),
      ['hostname'],
      '/shim/askpass.sh',
    );
    expect(env.SSH_ASKPASS).toBe('/shim/askpass.sh');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(env[ASKPASS_BUNDLE_ENV]).toBe('muqsit');
    expect(env[ASKPASS_KEY_ENV]).toBe('password');
    expect(args).toContain('PubkeyAuthentication=no');
    expect(args).toContain('NumberOfPasswordPrompts=1');
    expect(args).not.toContain('BatchMode=yes');
  });

  it('Windows password device wraps the command AND keeps the shim', () => {
    const { args, env } = buildSshInvocation(
      dev({ name: 'win-mini', platform: 'windows', shell: 'powershell', user: 'muqsit', auth: { method: 'password', bundle: 'muqsit' } }),
      ['hostname'],
      '/shim',
    );
    expect(args[args.length - 1]).toBe('powershell -NoProfile -Command hostname');
    expect(env.SSH_ASKPASS).toBe('/shim');
  });

  it('interactive (no command) adds -tt for a real tty', () => {
    const { args } = buildSshInvocation(dev({ name: 'i', user: 'me', auth: { method: 'key' } }), [], '/shim');
    expect(args).toContain('-tt');
    expect(args[args.length - 1]).toBe('me@i.ts.net');
  });

  it('password auth without a bundle is a hard error', () => {
    expect(() => buildSshInvocation(dev({ name: 'b', auth: { method: 'password' } }), [], '/shim')).toThrow(/no secrets bundle/);
  });
});
