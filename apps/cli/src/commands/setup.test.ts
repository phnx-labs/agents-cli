import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Isolate HOME before importing modules that capture path constants at import.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-setup-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
const { getSetupStatus, registerSetupCommand, runSetup, runSetupHub } = await import('./setup.js');
const { listInstalledBrowsers } = await import('../lib/browser/chrome.js');

describe('agents setup command group', () => {
  it('registers the browser/computer/share/fleet/mine/secrets capability subcommands', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    const subs = setup!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['browser', 'computer', 'fleet', 'mine', 'secrets', 'share', 'status', 'watchdog']);
  });

  it('keeps the bare `setup` command with its force / no-system-repo flags', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup')!;
    const flags = setup.options.map((o) => o.long).sort();
    expect(flags).toContain('--force');
    expect(flags).toContain('--no-system-repo');
  });

  it('reports real ready/missing rows after core setup already exists', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });

    const rows = await getSetupStatus();
    expect(rows.find((row) => row.phase === 'core')).toMatchObject({ state: 'ready', detail: 'system repo ready' });
    expect(rows.find((row) => row.phase === 'browser')?.state).toBe('missing');
    expect(rows.find((row) => row.phase === 'computer')).toBeDefined();
    expect(rows.map((row) => row.phase)).toEqual([
      'core', 'browser', 'computer', 'secrets', 'fleet', 'share', 'watchdog', 'preferences',
    ]);
  });

  it('re-enters the onboarding hub instead of returning when core is configured', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });
    let hubRuns = 0;
    await runSetup(new Command(), { runHub: async () => { hubRuns += 1; } });
    expect(hubRuns).toBe(1);
  });

  it('starts the daemon on first setup / --force when daemon.enabled', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });
    let starts = 0;
    await runSetup(new Command(), {
      force: true,
      systemRepo: false,
      suppressFooter: true,
      isDaemonEnabledFn: () => true,
      startDaemonFn: () => {
        starts += 1;
        return { pid: 99, method: 'detached' };
      },
    });
    expect(starts).toBe(1);
  });

  it('does not start the daemon on setup when daemon.enabled=false', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });
    let starts = 0;
    await runSetup(new Command(), {
      force: true,
      systemRepo: false,
      suppressFooter: true,
      isDaemonEnabledFn: () => false,
      startDaemonFn: () => {
        starts += 1;
        return { pid: 99, method: 'detached' };
      },
    });
    expect(starts).toBe(0);
  });

  it('does not start the daemon when re-entering the hub without --force', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });
    let starts = 0;
    await runSetup(new Command(), {
      runHub: async () => {},
      startDaemonFn: () => {
        starts += 1;
        return { pid: 99, method: 'detached' };
      },
    });
    expect(starts).toBe(0);
  });

  it('re-enters the hub, runs a selected wizard seam, then refreshes status', async () => {
    const selected: string[] = [];
    let promptCount = 0;
    await runSetupHub({
      interactive: true,
      selectPhase: async () => (promptCount++ === 0 ? 'browser' : 'exit'),
      runPhase: async (phase) => { selected.push(phase); },
    });
    expect(selected).toEqual(['browser']);
    expect(promptCount).toBe(2);
  });

  it('uses the configured named browser profile for readiness', async () => {
    const { createProfile } = await import('../lib/browser/profiles.js');
    const { setConfigValue } = await import('../lib/device-config.js');
    await createProfile({
      name: 'work',
      browser: 'custom',
      binary: process.execPath,
      endpoints: ['cdp://127.0.0.1:9333'],
      viewport: { width: 1280, height: 720 },
    });
    setConfigValue('browser.profile', 'work');
    const rows = await getSetupStatus();
    expect(rows.find((row) => row.phase === 'browser')).toMatchObject({ state: 'ready', detail: 'profile work' });
  });

  it('reports a configured browser profile with a missing binary as unavailable', async () => {
    const { updateProfile } = await import('../lib/browser/profiles.js');
    await updateProfile({
      name: 'work',
      browser: 'custom',
      binary: path.join(TEST_HOME, 'missing-browser'),
      endpoints: ['cdp://127.0.0.1:9333'],
      viewport: { width: 1280, height: 720 },
    });
    const rows = await getSetupStatus();
    expect(rows.find((row) => row.phase === 'browser')).toMatchObject({
      state: 'missing',
      detail: 'profile work cannot launch here',
    });
  });

  it('prints status, returns without prompting, and exits nonzero for missing phases outside a TTY', async () => {
    let selected = false;
    try {
      await runSetupHub({
        interactive: false,
        selectPhase: async () => { selected = true; return 'exit'; },
      });
      expect(selected).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });
});

describe('agents setup secrets', () => {
  it('non-interactively persists backend preference and the existing secrets policy default', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    await program.parseAsync(['setup', 'secrets', '--backend', 'file', '--policy', 'always'], {
      from: 'user',
    });

    const prefs = JSON.parse(
      fs.readFileSync(path.join(TEST_HOME, '.agents', '.history', 'setup', 'secrets.json'), 'utf-8'),
    );
    expect(prefs.defaultBackend).toBe('file');
    expect(prefs.defaultPolicy).toBe('always');

    const { readMeta } = await import('../lib/state.js');
    expect(readMeta().secrets?.backend).toBe('file');
    expect(readMeta().secrets?.policy).toBe('always');
  });

  it('does not treat omitted --import-from as a CLI-selected import source', () => {
    const program = new Command();
    registerSetupCommand(program);

    const setup = program.commands.find((c) => c.name() === 'setup')!;
    const secrets = setup.commands.find((c) => c.name() === 'secrets')!;
    secrets.parseOptions([]);

    expect(secrets.opts().importFrom).toBeUndefined();
  });

  it('makes future secrets create/import use the saved backend default', async () => {
    const originalPassphrase = process.env.AGENTS_SECRETS_PASSPHRASE;
    const originalNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_SECRETS_PASSPHRASE = 'setup-test-passphrase';
    process.env.AGENTS_SECRETS_NO_AGENT = '1';

    try {
      const setupProgram = new Command();
      setupProgram.exitOverride();
      registerSetupCommand(setupProgram);
      await setupProgram.parseAsync(['setup', 'secrets', '--backend', 'file', '--policy', 'daily'], {
        from: 'user',
      });

      const { registerSecretsCommands } = await import('./secrets.js');
      const { readBundle } = await import('../lib/secrets/bundles.js');
      const { setKeychainBackendForTest } = await import('../lib/secrets/index.js');
      const restoreBackend = setKeychainBackendForTest({
        has: () => false,
        get: (item: string) => { throw new Error(`missing test keychain item ${item}`); },
        set: () => {},
        delete: () => false,
        list: () => [],
      });

      try {
        const createProgram = new Command();
        createProgram.exitOverride();
        registerSecretsCommands(createProgram);
        await createProgram.parseAsync(['secrets', 'create', 'setup-default-create'], { from: 'user' });
        expect(readBundle('setup-default-create')?.backend).toBe('file');

        const envPath = path.join(TEST_HOME, 'setup-default.env');
        fs.writeFileSync(envPath, 'SETUP_DEFAULT=1\n');
        const importProgram = new Command();
        importProgram.exitOverride();
        registerSecretsCommands(importProgram);
        await importProgram.parseAsync(['secrets', 'import', 'setup-default-import', '--from', envPath], { from: 'user' });
        expect(readBundle('setup-default-import')?.backend).toBe('file');
      } finally {
        setKeychainBackendForTest(restoreBackend);
      }
    } finally {
      if (originalPassphrase === undefined) {
        delete process.env.AGENTS_SECRETS_PASSPHRASE;
      } else {
        process.env.AGENTS_SECRETS_PASSPHRASE = originalPassphrase;
      }
      if (originalNoAgent === undefined) {
        delete process.env.AGENTS_SECRETS_NO_AGENT;
      } else {
        process.env.AGENTS_SECRETS_NO_AGENT = originalNoAgent;
      }
    }
  });
});

describe('agents setup fleet', () => {
  it('prints install guidance and exits cleanly when tailscale is unavailable', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const program = new Command();
      program.exitOverride();
      registerSetupCommand(program);

      await program.parseAsync(['setup', 'fleet', '--yes'], { from: 'user' });
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.env.PATH = originalPath;
      process.exitCode = undefined;
    }
  });
});

describe('listInstalledBrowsers', () => {
  it('returns [] on an unknown platform (no crash on non-mac/linux/win)', () => {
    expect(listInstalledBrowsers('sunos')).toEqual([]);
  });
});
