import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { Command } from 'commander';

// Drives `agents browser profiles claim` and a bare `agents browser start`
// through the REAL commander registration and the REAL profile store under a
// temp HOME. The hostability gate is the production `isProfileLaunchableHere`
// path — no mocks of registry or chrome.

let testHome = '';

async function freshBrowserModules() {
  vi.resetModules();
  const browser = await import('./browser.js');
  const profiles = await import('../lib/browser/profiles.js');
  const config = await import('../lib/device-config.js');
  const registry = await import('../lib/browser/registry.js');
  return { ...browser, ...profiles, ...config, ...registry };
}

async function run(args: string[]) {
  const { registerBrowserCommand } = await freshBrowserModules();
  const program = new Command();
  program.exitOverride();
  registerBrowserCommand(program);
  await program.parseAsync(['node', 'agents', 'browser', ...args]);
}

function writeCentralBrowser(profiles: Record<string, unknown>): void {
  const file = path.join(testHome, '.agents', 'agents.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify({ browser: profiles }));
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-claim-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('agents browser profiles claim', () => {
  it('claims a leftover central profile this machine can host', async () => {
    writeCentralBrowser({
      work: {
        browser: 'custom',
        binary: process.execPath,
        endpoints: ['cdp://127.0.0.1:9222'],
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'claim']);

    const { getProfile, declaringDevices } = await freshBrowserModules();
    expect((await getProfile('work'))?.browser).toBe('custom');
    expect(declaringDevices('work')).toEqual(['testbox']);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Claimed work on testbox/);
    expect(
      yaml.parse(fs.readFileSync(path.join(testHome, '.agents', 'agents.yaml'), 'utf8'))?.browser,
    ).toBeUndefined();
  });

  it('does not claim a leftover central profile this machine cannot host', async () => {
    writeCentralBrowser({
      'comet-local': {
        browser: 'custom',
        binary: '/definitely/not/installed/comet',
        endpoints: ['cdp://localhost:9333'],
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'claim']);

    const { declaringDevices, profileKind } = await freshBrowserModules();
    expect(declaringDevices('comet-local')).toEqual([]);
    expect(profileKind('comet-local')).toBeNull();
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Skipped comet-local/);
    expect(
      yaml.parse(fs.readFileSync(path.join(testHome, '.agents', 'agents.yaml'), 'utf8')).browser['comet-local'],
    ).toBeDefined();
  });

  it('fails loud on a named claim this machine cannot host', async () => {
    writeCentralBrowser({
      'comet-local': {
        browser: 'custom',
        binary: '/definitely/not/installed/comet',
        endpoints: ['cdp://localhost:9333'],
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit ${code}`);
    }) as never);

    await expect(run(['profiles', 'claim', 'comet-local'])).rejects.toThrow(/process.exit 1/);
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /Cannot claim browser profile "comet-local"/,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('bare agents browser start with an undeclared configured default', () => {
  it('exits 1 instead of creating auto-chrome', async () => {
    const { setConfigValue } = await freshBrowserModules();
    setConfigValue('browser.profile', 'comet-local');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit ${code}`);
    }) as never);

    await expect(run(['start'])).rejects.toThrow(/process.exit 1/);
    const err = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).toMatch(/configured default browser profile "comet-local" is not declared by any device/);
    expect(err).not.toMatch(/auto-chrome/);

    const { profileRegistry } = await freshBrowserModules();
    expect(profileRegistry().has('auto-chrome')).toBe(false);
  });
});
