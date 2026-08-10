import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The profile resolver: central `fleet.devices.<name>.config` ssh.* / platform /
 * user keys overlay the registry's discovery record. Exercises the REAL read path —
 * temp HOME + registry fixtures, fresh modules per test (state.ts captures HOME
 * at import time), and the real buildSshInvocation argv builder.
 */
let TMP = '';

async function freshModules() {
  vi.resetModules();
  const resolver = await import('./resolve-profile.js');
  const connect = await import('./connect.js');
  const registry = await import('./registry.js');
  return { ...resolver, ...connect, ...registry };
}

function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.agents', 'agents.yaml'), yamlText);
}

function seedRegistry(profiles: Record<string, unknown>) {
  const dir = path.join(TMP, '.agents', '.history', 'devices');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(profiles));
}

const NOW = new Date().toISOString();
function profile(over: Record<string, unknown> = {}) {
  return {
    name: 'worker',
    platform: 'linux',
    shell: 'posix',
    user: 'discovered',
    address: { via: 'tailscale', dnsName: 'worker.example.ts.net' },
    auth: { method: 'key' },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as any;
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resolve-profile-test-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
});
afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  delete process.env.AGENTS_DEVICES_DIR;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('resolveDeviceProfile', () => {
  it('returns the registry profile unchanged when no config is set', async () => {
    const { resolveDeviceProfile } = await freshModules();
    const p = profile();
    expect(resolveDeviceProfile(p)).toBe(p);
  });

  it('overlays central ssh.* / platform / user values onto the registry profile', async () => {
    writeCentral(
      'fleet:\n  devices:\n    worker:\n      config:\n        sshUser: ops\n        sshIdentityFile: /keys/fleet\n        platform: windows\n',
    );
    const { resolveDeviceProfile } = await freshModules();

    const resolved = resolveDeviceProfile(profile());

    expect(resolved.user).toBe('ops');
    expect(resolved.auth.identityFile).toBe('/keys/fleet');
    expect(resolved.platform).toBe('windows');
    // The shell follows the overridden platform.
    expect(resolved.shell).toBe('powershell');
    // Discovery fields are untouched.
    expect(resolved.address.dnsName).toBe('worker.example.ts.net');
  });

  it('central ssh.identity-file wins in the real buildSshInvocation argv', async () => {
    writeCentral(
      'fleet:\n  devices:\n    worker:\n      config:\n        sshIdentityFile: /keys/central\n',
    );
    const { buildSshInvocation } = await freshModules();

    const { args } = buildSshInvocation(profile({ auth: { method: 'key', identityFile: '/keys/registry' } }), ['uptime'], '/tmp/askpass.sh');

    const i = args.indexOf('-i');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('/keys/central');
    expect(args).toContain('IdentitiesOnly=yes');
    // The target still uses the discovered address (+ the discovered user).
    expect(args).toContain('discovered@worker.example.ts.net');
  });

  it('central ssh.user overrides the dial user', async () => {
    writeCentral('fleet:\n  devices:\n    worker:\n      config:\n        sshUser: ops\n');
    const { buildSshInvocation } = await freshModules();

    const { args } = buildSshInvocation(profile(), ['uptime'], '/tmp/askpass.sh');
    expect(args).toContain('ops@worker.example.ts.net');
  });

  it('central platform=windows switches the remote command wrap to PowerShell', async () => {
    writeCentral('fleet:\n  devices:\n    worker:\n      config:\n        platform: windows\n');
    const { buildSshInvocation } = await freshModules();

    const { args } = buildSshInvocation(profile(), ['uptime'], '/tmp/askpass.sh');
    const remote = args[args.length - 1];
    expect(remote).toMatch(/^powershell -NoProfile -EncodedCommand /);
  });

  it('central ssh.auth=password drives the askpass auth path', async () => {
    writeCentral(
      'fleet:\n  devices:\n    worker:\n      config:\n        sshAuth: password\n        sshBundle: fleet\n        sshBundleKey: password.work\n',
    );
    const { buildSshInvocation, ASKPASS_BUNDLE_ENV, ASKPASS_KEY_ENV } = await freshModules();

    const { args, env } = buildSshInvocation(profile(), ['uptime'], '/tmp/askpass.sh');
    expect(args).toContain('PreferredAuthentications=password');
    expect(env.SSH_ASKPASS).toBe('/tmp/askpass.sh');
    expect(env[ASKPASS_BUNDLE_ENV]).toBe('fleet');
    expect(env[ASKPASS_KEY_ENV]).toBe('password.work');
  });
});
