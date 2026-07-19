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
  it('registers the browser/computer/share capability subcommands', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    const subs = setup!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['browser', 'computer', 'share']);
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

describe('listInstalledBrowsers', () => {
  it('returns [] on an unknown platform (no crash on non-mac/linux/win)', () => {
    expect(listInstalledBrowsers('sunos')).toEqual([]);
  });
});
