import { describe, it, expect, afterEach, vi } from 'vitest';
import { flagValue, maybeRunOnHost, runFleetPassthrough } from './passthrough.js';
import { machineId } from '../session/sync/config.js';
import type { DeviceProfile, DeviceRegistry } from '../devices/registry.js';

function fakeDevice(name: string, platform: DeviceProfile['platform'], overrides?: Partial<DeviceProfile>): DeviceProfile {
  return {
    name,
    platform,
    shell: platform === 'windows' ? 'powershell' : 'posix',
    address: { via: 'tailscale', dnsName: `${name}.tail.ts.net` },
    auth: { method: 'key' },
    tailscale: { online: true, direct: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeRegistry(devices: DeviceProfile[]): DeviceRegistry {
  return Object.fromEntries(devices.map((d) => [d.name, d]));
}

describe('flagValue', () => {
  it('reads the space-separated long form', () => {
    expect(flagValue(['view', '--host', 'mac'], 'host', 'H')).toBe('mac');
  });
  it('reads the --host=value form', () => {
    expect(flagValue(['view', '--host=mac'], 'host', 'H')).toBe('mac');
  });
  it('reads the -H value and glued -Hmac forms', () => {
    expect(flagValue(['view', '-H', 'mac'], 'host', 'H')).toBe('mac');
    expect(flagValue(['view', '-Hmac'], 'host', 'H')).toBe('mac');
  });
  it('reads --remote-cwd (long-only, no short)', () => {
    expect(flagValue(['sync', '--remote-cwd', '/srv'], 'remote-cwd')).toBe('/srv');
  });
  it('returns undefined when absent', () => {
    expect(flagValue(['view', '--json'], 'host', 'H')).toBeUndefined();
  });
});

describe('maybeRunOnHost — local short-circuits (no SSH attempted)', () => {
  const originalArgv = process.argv.slice();

  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    process.argv = originalArgv.slice();
    process.exitCode = 0;
  });

  it('falls through for OWN_HOST commands (secrets owns its --host)', async () => {
    expect(await maybeRunOnHost('secrets', ['secrets', 'list', '--host', 'mac'])).toBe(false);
  });

  it('leaves feed host lists to the command-level fleet aggregator', async () => {
    expect(await maybeRunOnHost('feed', ['feed', '--host', 'mac', '--json'])).toBe(false);
  });

  it('leaves activity host lists to the command-level fleet aggregator', async () => {
    expect(await maybeRunOnHost('activity', ['activity', '--host', 'mac', '--json'])).toBe(false);
    expect(await maybeRunOnHost('activity', ['activity', '--device', 'a', '--devices-all'])).toBe(false);
  });

  it('rejects --host on a non-routable, non-OWN_HOST group with a clear error (not unknown option)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // setup has no remote semantics and no own-host handler — must not fall
    // through to commander (which would print "unknown option '--host'").
    expect(await maybeRunOnHost('setup', ['setup', '--host', 'mac'])).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('returns false when no --host is given', async () => {
    expect(await maybeRunOnHost('view', ['view', 'claude'])).toBe(false);
  });

  it('returns false when neither --host nor its --device alias is given', async () => {
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi'])).toBe(false);
  });

  it('returns false when --host names this very machine (runs locally instead)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(machineId()).toBe('mybox');
    process.argv = ['node', 'agents', 'view', '--host', 'mybox'];
    expect(await maybeRunOnHost('view', ['view', '--host', 'mybox'])).toBe(false);
    // Self-host strips routing flags so local commander never sees them.
    expect(process.argv).toEqual(['node', 'agents', 'view']);
    // case-insensitive: the self-check must not SSH to `MyBox` either
    process.argv = ['node', 'agents', 'view', '--host', 'MyBox'];
    expect(await maybeRunOnHost('view', ['view', '--host', 'MyBox'])).toBe(false);
  });

  it('treats --device as an alias of --host for the self-machine short-circuit', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --device naming this machine must short-circuit to a local run, exactly
    // like --host would — otherwise the alias would SSH to itself.
    process.argv = ['node', 'agents', 'message', 'abc', 'hi', '--device', 'mybox'];
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi', '--device', 'mybox'])).toBe(false);
    expect(process.argv).toEqual(['node', 'agents', 'message', 'abc', 'hi']);
    process.argv = ['node', 'agents', 'message', 'abc', 'hi', '--device=mybox'];
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi', '--device=mybox'])).toBe(false);
  });

  it('routes repos/repo --host to a non-self target (the RUSH-1691 repro path)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // Invalid target rejected by assertValidSshTarget before SSH — proves
    // repos is in REMOTE_PASSTHROUGH (previously fell through → unknown option).
    for (const cmd of ['repos', 'repo'] as const) {
      const result = await maybeRunOnHost(cmd, [cmd, 'list', '--host', '--evil']);
      expect(result).toBe(true);
      expect(process.exitCode).toBeGreaterThan(0);
      process.exitCode = 0;
    }
  });

  it('rejects a conflicting --host/--device pair without attempting SSH', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // Single-target remote path: handled (returns true) but as an error —
    // never guesses which host wins.
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi', '--host', 'a', '--device', 'b'])).toBe(true);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('falls through for OWN_HOST multi-host aggregators with both --host and --device', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // sessions/feed merge --host and --device into one list — the conflict gate
    // must not fire for them (regression: pre-OWN_HOST ordering broke this).
    expect(await maybeRunOnHost('sessions', ['sessions', '--active', '--host', 'a', '--device', 'b'])).toBe(false);
    expect(await maybeRunOnHost('feed', ['feed', '--host', 'a', '--device', 'b', '--json'])).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('routes routines --host to a non-self target (rejected by assertValidSshTarget)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --evil starts with '-' so assertValidSshTarget rejects it before any
    // SSH connection is attempted. Returning true with exitCode > 0 proves
    // the routing path was entered, not short-circuited.
    const result = await maybeRunOnHost('routines', ['routines', 'list', '--host', '--evil']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('routes routines --device alias to a non-self target', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    const result = await maybeRunOnHost('routines', ['routines', 'run', 'x', '--device', '--evil']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('does NOT bail on --devices for routines with --host (placement, not fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --devices on routines is placement; --host should still route remotely.
    // The invalid target is rejected by assertValidSshTarget (returns true,
    // exitCode > 0), proving --devices did not bail.
    const result = await maybeRunOnHost('routines', ['routines', 'add', 'x', '--host', '--evil', '--devices', 'a,b']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('bails on --devices for non-routines commands (fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --devices on a non-routines command triggers the fleet-flag bailout,
    // returning false even with a non-self --host.
    expect(await maybeRunOnHost('list', ['list', '--host', '--evil', '--devices'])).toBe(false);
  });

  it('bails on --hosts for non-routines commands (fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('list', ['list', '--host', '--evil', '--hosts'])).toBe(false);
  });

  it('bails on --hosts for routines too (generic fleet flag, not placement)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('routines', ['routines', 'list', '--host', '--evil', '--hosts'])).toBe(false);
  });

  it('rejects --device all on a non-routable command with a clear error', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    const result = await maybeRunOnHost('setup', ['setup', '--device', 'all']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});

describe('maybeRunOnHost — fleet `all` sentinel (injected runners)', () => {
  const originalArgv = process.argv.slice();
  const logs: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    process.argv = originalArgv.slice();
    process.exitCode = 0;
    logs.length = 0;
    console.log = originalLog;
  });

  function captureLogs() {
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
  }

  function makeRunner(responses: Record<string, { code: number | null; stdout: string; stderr: string }>) {
    return (device: DeviceProfile, cmd: string[]) => {
      const key = cmd.slice(0, 2).join(' '); // e.g. "agents view"
      const hit = responses[`${device.name}:${key}`] ?? responses[device.name] ?? { code: 0, stdout: '[]', stderr: '' };
      return hit;
    };
  }

  function makeLocalRunner(response: { code: number | null; stdout: string; stderr: string } = { code: 0, stdout: '[]', stderr: '' }) {
    return () => response;
  }

  it('fans out view across every device with --device all', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([
      fakeDevice('zion', 'macos'),
      fakeDevice('mac-mini', 'macos'),
      fakeDevice('yosemite-s0', 'linux'),
    ]);
    const runner = makeRunner({
      'mac-mini:agents view': { code: 0, stdout: JSON.stringify([{ agent: 'kimi', versions: [{ version: '0.4.2', isDefault: true, signedIn: true, email: 'trp.so' }] }]), stderr: '' },
      'yosemite-s0:agents view': { code: 0, stdout: JSON.stringify([{ agent: 'kimi', versions: [{ version: '0.4.1', isDefault: true, signedIn: true, email: 'trp.so' }] }]), stderr: '' },
    });
    const localRunner = makeLocalRunner({
      code: 0,
      stdout: JSON.stringify([{ agent: 'kimi', versions: [{ version: '0.4.3', isDefault: true, signedIn: true, email: 'trp.so' }] }]),
      stderr: '',
    });

    const result = await maybeRunOnHost('view', ['view', 'kimi', '--device', 'all'], {
      self: 'zion',
      loadDevices: async () => registry,
      runner,
      localRunner,
    });

    expect(result).toBe(true);
    const output = logs.join('\n');
    expect(output).toContain('view kimi');
    expect(output).toContain('macOS');
    expect(output).toContain('Linux');
    expect(output).toContain('zion');
    expect(output).toContain('mac-mini');
    expect(output).toContain('yosemite-s0');
    expect(output).toContain('← this machine');
  });

  it('fans out with --host all and --devices all too', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([fakeDevice('mac-mini', 'macos')]);
    const runner = makeRunner({ 'mac-mini:agents view': { code: 0, stdout: '[]', stderr: '' } });

    for (const flag of ['--host all', '--devices all', '--hosts all']) {
      logs.length = 0;
      const [f, v] = flag.split(' ');
      const result = await maybeRunOnHost('view', ['view', f, v], {
        self: 'zion',
        loadDevices: async () => registry,
        runner,
        localRunner: makeLocalRunner(),
      });
      expect(result).toBe(true);
      expect(logs.join('\n')).toContain('mac-mini');
    }
  });

  it('renders offline / no-address devices as skipped rows, never a hang', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([
      fakeDevice('zion', 'macos', { tailscale: { online: true, direct: true } }),
      fakeDevice('pinnacles', 'macos', { tailscale: { online: false, direct: false } }),
      fakeDevice('headless', 'linux', { address: { via: 'manual' } }), // no dns/ip → no-address
    ]);

    const result = await maybeRunOnHost('view', ['view', 'kimi', '--device', 'all'], {
      self: 'zion',
      loadDevices: async () => registry,
      runner: makeRunner({}),
      localRunner: makeLocalRunner({ code: 0, stdout: '[]', stderr: '' }),
    });

    expect(result).toBe(true);
    const output = logs.join('\n');
    expect(output).toContain('pinnacles');
    expect(output).toContain('headless');
    expect(output).toMatch(/offline|no address/);
  });

  it('emits a device-keyed JSON object under --json', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([fakeDevice('zion', 'macos'), fakeDevice('mac-mini', 'macos')]);
    // Remote `agents view <agent> --json` returns a single object, not an array.
    const remotePayload = { agent: 'kimi', versions: [{ version: '0.4.2', isDefault: true, signedIn: false, email: null }], profiles: [] };
    const runner = makeRunner({ 'mac-mini:agents view': { code: 0, stdout: JSON.stringify(remotePayload), stderr: '' } });

    const result = await maybeRunOnHost('view', ['view', 'kimi', '--device', 'all', '--json'], {
      self: 'zion',
      loadDevices: async () => registry,
      runner,
      localRunner: makeLocalRunner({ code: 0, stdout: '[]', stderr: '' }),
    });

    expect(result).toBe(true);
    const parsed = JSON.parse(logs[0]);
    expect(parsed['mac-mini']).toEqual(remotePayload);
    expect(parsed.zion).toEqual([]);
  });

  it('still bails on non-all --devices for non-routines commands', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('view', ['view', '--devices', 'mac1,mac2'])).toBe(false);
  });

  it('fans out --devices all on routines too', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([fakeDevice('mac-mini', 'macos')]);
    const runner = makeRunner({ 'mac-mini:agents routines': { code: 0, stdout: '[]', stderr: '' } });

    const result = await maybeRunOnHost('routines', ['routines', 'list', '--devices', 'all'], {
      self: 'zion',
      loadDevices: async () => registry,
      runner,
      localRunner: makeLocalRunner({ code: 0, stdout: '[]', stderr: '' }),
    });

    expect(result).toBe(true);
    expect(logs.join('\n')).toContain('mac-mini');
  });

  it('rejects a conflicting --host with --device all', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    const result = await maybeRunOnHost('view', ['view', '--device', 'all', '--host', 'other']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});

describe('runFleetPassthrough — direct unit tests', () => {
  const logs: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    logs.length = 0;
    console.log = originalLog;
    process.exitCode = 0;
    delete process.env.AGENTS_SYNC_MACHINE_ID;
  });

  it('uses the output summarizer for output command', async () => {
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    const registry = fakeRegistry([fakeDevice('mac-mini', 'macos')]);
    const runner = (_device: DeviceProfile, cmd: string[]) => {
      if (cmd[1] === 'output') {
        return {
          code: 0,
          stdout: JSON.stringify({
            machine: 'mac-mini',
            pricingVersion: '2026-01',
            since: '7d',
            burn: { costUsd: 12.5, outputTokens: 3400, tokenCount: 12000, sessionCount: 5, durationMs: 360000 },
            output: { commits: 3, commitShas: [], prsOpened: 0, prsMerged: 0, reposScanned: 2, ghAvailable: true, authors: [], logins: [] },
            breakdown: { by: 'agent', rows: [] },
            uncostedAgents: [],
          }),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };

    await runFleetPassthrough(
      'output',
      ['output', '--device', 'all'],
      {},
      {
        self: 'zion',
        loadDevices: async () => registry,
        runner,
        localRunner: () => ({ code: 0, stdout: '{}', stderr: '' }),
      },
    );

    const output = logs.join('\n');
    expect(output).toContain('mac-mini');
    expect(output).toContain('$12.50 burned');
    expect(output).toContain('3.4K output tokens');
  });
});
