import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { Command } from 'commander';

let testHome = '';

async function freshBrowserModules() {
  vi.resetModules();
  const browser = await import('./browser.js');
  const index = await import('../lib/browser/task-index.js');
  const registry = await import('../lib/browser/registry.js');
  return { ...browser, ...index, ...registry };
}

async function run(args: string[]) {
  const { registerBrowserCommand } = await freshBrowserModules();
  const program = new Command();
  program.exitOverride();
  registerBrowserCommand(program);
  await program.parseAsync(['node', 'agents', 'browser', ...args]);
}

function deviceFile(device: string): string {
  return path.join(testHome, '.agents', 'devices', device, 'agents.yaml');
}

function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(value));
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit ${code}`);
  }) as never);
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-task-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  delete process.env.AGENT_SESSION_ID;
  delete process.env.AGENTS_SESSION_ID;
  delete process.env.AGENTS_BROWSER_TASK;
  delete process.env.AGENTS_FLEET_REMOTE;
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  delete process.env.AGENT_SESSION_ID;
  delete process.env.AGENTS_SESSION_ID;
  delete process.env.AGENTS_BROWSER_TASK;
  delete process.env.AGENTS_FLEET_REMOTE;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('page verbs reject --device (T3)', () => {
  it('rejects --device on screenshot and points at start', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();
    await expect(run(['screenshot', '--device', 'zion', '--task', 'post'])).rejects.toThrow(
      /process.exit 1/,
    );
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /agents browser start/,
    );
  });

  it('rejects --device on stop --profile instead of stopping the local profile', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();
    await expect(run(['stop', '--profile', 'work', '--device', 'zion'])).rejects.toThrow(
      /process.exit 1/,
    );
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /agents browser start/,
    );
  });
});

describe('unknown and killed tasks fail loud (T3)', () => {
  it('a verb naming an unknown task lists the open tasks and exits non-zero', async () => {
    const { bindTask } = await freshBrowserModules();
    bindTask('post', {
      device: 'zion',
      url: 'https://x.com/compose',
      createdAt: Date.now(),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();
    await expect(run(['screenshot', '--task', 'nope'])).rejects.toThrow(/process.exit 1/);
    const err = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).toMatch(/Unknown browser task "nope"/);
    expect(err).toMatch(/url=https:\/\/x.com\/compose/);
    expect(err).toMatch(/device=zion/);
  });

  it('killing the task then issuing a verb errors; it does not open a second browser', async () => {
    const { bindTask, unbindTask } = await freshBrowserModules();
    bindTask('post', {
      device: 'testbox',
      url: 'https://example.com',
      createdAt: Date.now(),
    });
    unbindTask('post');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();
    await expect(run(['click', '@e3', '--task', 'post'])).rejects.toThrow(/process.exit 1/);
    const err = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).toMatch(/Unknown browser task "post"/);
    expect(err).toMatch(/no open tasks/);
  });
});

describe('ambiguous task listing (RUSH-3087)', () => {
  it('shows the real URL and the device when this session owns 2+ tasks', async () => {
    process.env.AGENT_SESSION_ID = 'sess-1';
    const { bindTask } = await freshBrowserModules();
    bindTask('post', {
      device: 'zion',
      url: 'https://x.com/compose',
      sessionId: 'sess-1',
      createdAt: Date.now(),
    });
    bindTask('mail', {
      device: 'zion',
      url: 'https://github.com/notifications',
      sessionId: 'sess-1',
      createdAt: Date.now(),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();
    await expect(run(['screenshot'])).rejects.toThrow(/process.exit 1/);
    const err = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).toMatch(/pass --task/);
    expect(err).toMatch(/url=https:\/\/x.com\/compose/);
    expect(err).toMatch(/url=https:\/\/github.com\/notifications/);
    expect(err).toMatch(/device=zion/);
    expect(err).not.toMatch(/url=-/);
  });
});

describe('start --device validates the declaration (T3)', () => {
  it('rejects a --device that does not declare the profile', async () => {
    writeYaml(deviceFile('zion'), {
      browser: {
        agents: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] },
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();
    await expect(
      run(['start', '--profile', 'agents', '--device', 'ghost', '--task', 'post']),
    ).rejects.toThrow(/process.exit 1/);
    const err = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(err).toMatch(/Device "ghost" does not declare browser profile "agents"/);
    expect(err).toMatch(/Declared on: zion/);
  });

  it('rejects --device all: a task lives on one device', async () => {
    writeYaml(deviceFile('testbox'), {
      browser: {
        agents: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] },
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();
    await expect(
      run(['start', '--profile', 'agents', '--device', 'all', '--task', 'post']),
    ).rejects.toThrow(/process.exit 1/);
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /a task lives on one device/,
    );
  });

  // PHNX-3289 fix 4: a bare `start --device <remote>` must route to the target
  // BEFORE any local browser/profile resolution — the browser lives on the
  // target. It used to resolve the profile here first, so a browserless box
  // failed with a misleading "No supported browser found" (or, on a box that
  // does have a browser, resolved and mis-attributed the profile) before the
  // start ever reached the device. We assert it reaches the remote-dispatch
  // path (an unregistered device fails loud with "Unknown device") and never
  // touches local browser auto-pick — deterministic regardless of whether the
  // host running the test has a Chromium browser installed.
  it('routes a bare start to --device before resolving a local browser', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockExit();
    await expect(
      run(['start', '--device', 'ghost', '--task', 'post']),
    ).rejects.toThrow(/process.exit 1/);
    const err = error.mock.calls.map((c) => String(c[0])).join('\n');
    // Reached the remote dispatch (past local resolution).
    expect(err).toMatch(/Unknown device "ghost"/);
    // Did NOT try to auto-pick / require a browser on THIS machine.
    expect(err).not.toMatch(/No supported browser found/);
  });
});
