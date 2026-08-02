import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate HOME before importing modules that capture path constants at import.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-setup-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
const { registerSetupCommand } = await import('./setup.js');
const { listInstalledBrowsers } = await import('../lib/browser/chrome.js');

describe('agents setup command group', () => {
  it('registers the browser/computer/share/fleet/mine/secrets capability subcommands', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    const subs = setup!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['browser', 'computer', 'fleet', 'mine', 'secrets', 'share']);
  });

  it('keeps the bare `setup` command with its force / no-system-repo flags', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup')!;
    const flags = setup.options.map((o) => o.long).sort();
    expect(flags).toContain('--force');
    expect(flags).toContain('--no-system-repo');
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
    process.env.AGENTS_SECRETS_PASSPHRASE = 'setup-test-passphrase';

    const setupProgram = new Command();
    setupProgram.exitOverride();
    registerSetupCommand(setupProgram);
    await setupProgram.parseAsync(['setup', 'secrets', '--backend', 'file', '--policy', 'daily'], {
      from: 'user',
    });

    const { registerSecretsCommands } = await import('./secrets.js');
    const { readBundle } = await import('../lib/secrets/bundles.js');

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
