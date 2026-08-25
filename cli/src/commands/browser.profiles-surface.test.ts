import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { Command } from 'commander';

/**
 * Drives `agents browser profiles list` / `doctor` / `add` through the real
 * commander registration and the real device-file registry under a temp HOME.
 * No mocks of registry, profiles, or chrome: the doctor check is the original
 * comet-local shape (identity-bearing loopback, this box is not the declarer).
 */

let testHome = '';

async function freshBrowserModules() {
  vi.resetModules();
  const browser = await import('./browser.js');
  const profiles = await import('../lib/browser/profiles.js');
  return { ...browser, ...profiles };
}

async function run(args: string[]) {
  const { registerBrowserCommand } = await freshBrowserModules();
  const program = new Command();
  program.exitOverride();
  registerBrowserCommand(program);
  await program.parseAsync(['node', 'agents', 'browser', ...args]);
}

function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(value));
}

function deviceFile(device: string): string {
  return path.join(testHome, '.agents', 'devices', device, 'agents.yaml');
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-surface-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('agents browser profiles list', () => {
  it('prints a WHERE column of declaring devices', async () => {
    const chrome = { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] };
    writeYaml(deviceFile('zion'), { browser: { agents: { browser: 'comet', endpoints: ['cdp://localhost:9333'] } } });
    writeYaml(deviceFile('testbox'), { browser: { scratch: chrome } });
    writeYaml(deviceFile('s0'), { browser: { scratch: chrome } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'list']);

    const output = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/\bWHERE\b/);
    expect(output).not.toMatch(/\bSCOPE\b/);
    expect(output).toMatch(/agents/);
    expect(output).toMatch(/zion/);
    expect(output).toMatch(/scratch/);
    expect(output).toMatch(/s0/);
  });

  it('--json includes devices + kind for every profile', async () => {
    const chrome = { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] };
    writeYaml(deviceFile('zion'), { browser: { agents: { browser: 'comet', endpoints: ['cdp://localhost:9333'] } } });
    writeYaml(deviceFile('testbox'), { browser: { scratch: chrome } });
    writeYaml(deviceFile('s0'), { browser: { scratch: chrome } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['profiles', 'list', '--json']);

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    const agents = parsed.find((row: { name: string }) => row.name === 'agents');
    const scratch = parsed.find((row: { name: string }) => row.name === 'scratch');
    expect(agents.devices).toEqual(['zion']);
    expect(agents.kind).toBe('identity');
    expect(scratch.devices.sort()).toEqual(['s0', 'testbox']);
    expect(scratch.kind).toBe('fungible');
  });
});

describe('agents browser profiles doctor', () => {
  it('fails where on an identity-bearing loopback profile declared elsewhere', async () => {
    writeYaml(deviceFile('zion'), {
      browser: {
        'comet-local': { browser: 'comet', endpoints: ['cdp://localhost:9333'] },
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit ${code}`);
    }) as never);

    await expect(run(['profiles', 'doctor', 'comet-local'])).rejects.toThrow(/process.exit 1/);
    const output = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/FAIL\s+where/);
    expect(output).toContain('zion');
    expect(output).toContain('testbox');
    expect(output).toContain('cdp://localhost:9333');
    expect(output).not.toMatch(/\bscope\b/);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('passes where when this machine is the declaring device', async () => {
    writeYaml(deviceFile('testbox'), {
      browser: {
        work: {
          browser: 'custom',
          binary: process.execPath,
          endpoints: ['cdp://127.0.0.1:9222'],
        },
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit ${code}`);
    }) as never);

    try {
      await run(['profiles', 'doctor', 'work']);
    } catch (err) {
      // Later checks (onboarding) may still fail on a never-started profile.
      expect(String(err)).toMatch(/process.exit 1/);
    }
    const output = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/OK\s+where\s+identity, declared on testbox/);
  });
});

describe('agents browser profiles add', () => {
  it('is an alias of create and says which device was written', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run([
      'profiles',
      'add',
      'agents',
      '--browser',
      'custom',
      '--binary',
      process.execPath,
      '--endpoint',
      'cdp://127.0.0.1:9333',
    ]);

    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toBe(
      'Added "agents" on testbox (port 9333).',
    );
    const yamlPath = deviceFile('testbox');
    expect(yaml.parse(fs.readFileSync(yamlPath, 'utf8')).browser.agents.browser).toBe('custom');
  });
});
