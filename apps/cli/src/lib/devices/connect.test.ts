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
import { buildAskpassShimBody, buildSshInvocation, fleetDialTarget, sshTargetFor, wrapRemoteCommand, ASKPASS_BUNDLE_ENV, ASKPASS_KEY_ENV } from './connect.js';
import type { DeviceProfile } from './registry.js';

function decodePowerShell(cmd: string): string {
  const m = cmd.match(/^powershell -NoProfile -EncodedCommand (\S+)$/);
  if (!m) throw new Error(`not an EncodedCommand invocation: ${cmd}`);
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

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

describe('fleetDialTarget', () => {
  it('prefers the registry Tailscale dnsName over the bare name (drift-proof)', () => {
    // The whole point: dialing the bare "yosemite-m1" lets a stale ~/.ssh/config
    // block win; dialing the dnsName sidesteps it entirely.
    expect(fleetDialTarget(dev({ name: 'yosemite-m1', user: 'muqsit', address: { via: 'tailscale', dnsName: 'yosemite-m1.ts.net' } })))
      .toBe('muqsit@yosemite-m1.ts.net');
  });

  it('uses the IP when there is no dnsName, and omits an absent user', () => {
    expect(fleetDialTarget(dev({ name: 'm', user: 'muqsit', address: { via: 'manual', ip: '100.74.242.106' } })))
      .toBe('muqsit@100.74.242.106');
    expect(fleetDialTarget(dev({ name: 'm', address: { via: 'tailscale', dnsName: 'm.ts.net' } }))).toBe('m.ts.net');
  });

  it('falls back to the bare name for an address-less manual device (never worse than before)', () => {
    expect(fleetDialTarget(dev({ name: 'yosemite-m1', user: 'muqsit', address: { via: 'manual' } }))).toBe('muqsit@yosemite-m1');
    expect(fleetDialTarget(dev({ name: 'yosemite-m1', address: { via: 'manual' } }))).toBe('yosemite-m1');
  });
});

describe('wrapRemoteCommand', () => {
  it('wraps Windows commands in a PowerShell EncodedCommand, leaves POSIX verbatim, undefined for interactive', () => {
    const wrapped = wrapRemoteCommand(dev({ name: 'w', shell: 'powershell' }), ['Write-Output', "'ran'"]);
    expect(wrapped).toMatch(/^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(decodePowerShell(wrapped!)).toBe("Write-Output 'ran'");
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
    expect(decodePowerShell(args[args.length - 1])).toBe('hostname');
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

  it('learns the host key on first connect (accept-new) against the managed store', () => {
    const { args } = buildSshInvocation(dev({ name: 'k', user: 'me' }), ['uptime'], '/shim', { knownHostsFile: '/managed/kh' });
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('UserKnownHostsFile=/managed/kh');
    expect(args).not.toContain('StrictHostKeyChecking=yes');
  });

  it('verifies strictly once the host key is pinned (RUSH-1767: no silent TOFU re-accept)', () => {
    const { args } = buildSshInvocation(
      dev({ name: 'k', user: 'me' }),
      ['uptime'],
      '/shim',
      { pinned: true, knownHostsFile: '/managed/kh' },
    );
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('UserKnownHostsFile=/managed/kh');
    expect(args).not.toContain('StrictHostKeyChecking=accept-new');
  });
});

describe('buildAskpassShimBody', () => {
  // The bug (#password-auth-on-standalone): the shim used to be hand-rolled from
  // `[process.execPath, process.argv[1], …]`. On a Bun standalone binary
  // process.argv[1] is the virtual embedded entry `/$bunfs/root/agents`, so the
  // shim ran `<binary> /$bunfs/root/agents ssh __askpass`; the CLI saw the
  // virtual path as a subcommand, died with `unknown command '/$bunfs/root/agents'`,
  // printed nothing, and handed ssh an EMPTY password -> Permission denied on
  // every password-auth device. The shim must never carry a /$bunfs path, and
  // must exec the launch argv resolved by getCliLaunch.
  it('standalone binary launch: execs the physical binary, never the /$bunfs virtual entry', () => {
    // getCliLaunch on a standalone build returns { command: <physical binary>, args: ['ssh','__askpass'] }.
    const body = buildAskpassShimBody({ command: '/opt/agents/bin/agents', args: ['ssh', '__askpass'] });
    expect(body).not.toContain('/$bunfs');
    expect(body).toContain("exec /opt/agents/bin/agents ssh __askpass");
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('JS/dev build launch: execs node with the real entry script', () => {
    // getCliLaunch on a JS install returns { command: node, args: [entry,'ssh','__askpass'] }.
    const body = buildAskpassShimBody({ command: '/usr/bin/node', args: ['/app/dist/index.js', 'ssh', '__askpass'] });
    expect(body).not.toContain('/$bunfs');
    expect(body).toContain("exec /usr/bin/node /app/dist/index.js ssh __askpass");
  });

  it('shell-quotes every argv element (paths with spaces stay one word)', () => {
    const body = buildAskpassShimBody({ command: '/opt/my agents/agents', args: ['ssh', '__askpass'] });
    expect(body).toContain("exec '/opt/my agents/agents' ssh __askpass");
  });

  it('default (no arg) resolves through getCliLaunch — never leaks a /$bunfs entry', () => {
    // Whatever the running shape, the real getCliLaunch must not emit a virtual entry.
    const body = buildAskpassShimBody();
    expect(body).not.toContain('/$bunfs');
    expect(body).toMatch(/\bssh __askpass\n$/);
  });
});
