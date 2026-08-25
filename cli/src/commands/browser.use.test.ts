import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';

let testHome = '';
// createProfile stats the custom binary, so it must exist on the test host —
// /bin/true is Linux-only (macOS ships /usr/bin/true). process.execPath is a
// real executable everywhere the suite runs.
const TEST_PROFILE = {
  name: 'work',
  browser: 'custom' as const,
  binary: process.execPath,
  endpoints: ['cdp://127.0.0.1:9222'],
};

async function freshBrowserModules() {
  vi.resetModules();
  const browser = await import('./browser.js');
  const profiles = await import('../lib/browser/profiles.js');
  const config = await import('../lib/device-config.js');
  return { ...browser, ...profiles, ...config };
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-use-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('agents browser use', () => {
  it('sets and clears browser.profile through the real device config layer', async () => {
    const { createProfile, getConfigValue, runBrowserUse } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);

    expect(await runBrowserUse('work', {}, false)).toBe(true);
    expect(getConfigValue('browser.profile').value).toBe('work');

    expect(await runBrowserUse(undefined, { unset: true }, false)).toBe(true);
    expect(getConfigValue('browser.profile').value).toBeUndefined();
  });

  it('rejects an unknown name and prints the available profiles', async () => {
    const { createProfile, runBrowserUse } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runBrowserUse('missing', {}, false)).toBe(false);
    expect(error).toHaveBeenCalledWith('Profile "missing" not found.');
    expect(error).toHaveBeenCalledWith('Available profiles: work');
  });

  it('prints the current default and usage headlessly', async () => {
    const { createProfile, runBrowserUse } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    await runBrowserUse('work', {}, false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runBrowserUse(undefined, {}, false)).toBe(true);
    expect(log).toHaveBeenCalledWith('Default browser profile (this machine): work');
    expect(log).toHaveBeenCalledWith('Usage: agents browser use <name>  (or --unset)');
  });

  it('offers configured profiles and unconfigured installed browsers in the picker', async () => {
    const { buildBrowserUseChoices } = await freshBrowserModules();
    const choices = buildBrowserUseChoices(
      [{ name: 'work', browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] }],
      [
        { browserType: 'chrome', binary: '/usr/bin/chrome' },
        { browserType: 'brave', binary: '/usr/bin/brave' },
      ],
      'work',
    );

    expect(choices.map((choice) => choice.name)).toEqual([
      'work (current)',
      'chrome-local (installed chrome)',
      'brave-local (installed brave)',
    ]);
  });

  it('keeps profiles set-default as a hidden deprecated alias of browser use', async () => {
    const { createProfile, getConfigValue, registerBrowserCommand } = await freshBrowserModules();
    await createProfile(TEST_PROFILE);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const program = new Command();
    program.exitOverride();
    registerBrowserCommand(program);

    await program.parseAsync(['node', 'agents', 'browser', 'profiles', 'set-default', 'work']);

    expect(getConfigValue('browser.profile').value).toBe('work');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('agents browser use'));
    const profiles = program.commands.find((command) => command.name() === 'browser')!
      .commands.find((command) => command.name() === 'profiles')!;
    expect(profiles.helpInformation()).not.toContain('set-default');
    expect(profiles.commands.find((command) => command.name() === 'use')).toBeDefined();
  });
});
