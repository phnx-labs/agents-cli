import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import * as state from '../lib/state.js';
import { registerRouteCommands } from './route.js';
import { readRouter, routerExists } from '../lib/routers.js';

let TEST_ROOT: string;
let USER_DIR: string;

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'route-cmd-test-'));
  USER_DIR = path.join(TEST_ROOT, '.agents');
  fs.mkdirSync(USER_DIR, { recursive: true });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(USER_DIR);
  vi.spyOn(state, 'getSystemAgentsDir').mockReturnValue(path.join(TEST_ROOT, 'system', '.agents'));
  vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  exitCode: number | null;
}

/** Run `agents route <args>` in-process against the mocked user dir. */
async function runRoute(args: string[]): Promise<RunResult> {
  const program = new Command();
  program.exitOverride();
  registerRouteCommands(program);

  const chunks: string[] = [];
  let exitCode: number | null = null;
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${exitCode})`);
  }) as typeof process.exit);

  try {
    await program.parseAsync(['node', 'agents', 'route', ...args]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout: chunks.join('\n'), exitCode };
}

describe('agents route create', () => {
  it('writes a router yml with the given harnesses and tiers', async () => {
    const result = await runRoute(['create', 'research', '--harness', 'gemini,kimi', '--tier', 'cheap,default', '--task', 'research']);
    expect(result.exitCode).toBeNull();
    expect(routerExists('research')).toBe(true);
    expect(fs.existsSync(path.join(USER_DIR, 'routers', 'research.yml'))).toBe(true);

    const router = readRouter('research');
    expect(router.task).toBe('research');
    expect(router.harnesses.gemini.models).toEqual(['cheap', 'default']);
    expect(router.harnesses.kimi.models).toEqual(['cheap', 'default']);
  });

  it('fails loud (writes nothing) when the router already exists', async () => {
    await runRoute(['create', 'research', '--harness', 'gemini']);
    const before = readRouter('research');
    const result = await runRoute(['create', 'research', '--harness', 'kimi']);
    expect(result.exitCode).toBe(1);
    expect(readRouter('research')).toEqual(before);
  });

  it('fails loud when --harness is missing', async () => {
    const result = await runRoute(['create', 'research']);
    expect(result.exitCode).toBe(1);
    expect(routerExists('research')).toBe(false);
  });
});

describe('agents route allow', () => {
  it('replaces (narrows) a harness model set, preserving existing accounts', async () => {
    await runRoute(['create', 'research', '--harness', 'gemini,kimi', '--tier', 'cheap,default']);
    await runRoute(['link-account', 'research', 'kimi', 'work']);

    const result = await runRoute(['allow', 'research', 'kimi', 'kimi-k2']);
    expect(result.exitCode).toBeNull();

    const router = readRouter('research');
    expect(router.harnesses.kimi.models).toEqual(['kimi-k2']);
    expect(router.harnesses.kimi.accounts).toEqual(['work']);
    // gemini is untouched by narrowing kimi
    expect(router.harnesses.gemini.models).toEqual(['cheap', 'default']);
  });

  it('can allow a brand-new harness not present at create time', async () => {
    await runRoute(['create', 'research', '--harness', 'gemini']);
    await runRoute(['allow', 'research', 'claude', 'best']);
    expect(readRouter('research').harnesses.claude.models).toEqual(['best']);
  });
});

describe('agents route link-account / unlink-account', () => {
  it('link-account adds an account; unlink-account removes it', async () => {
    await runRoute(['create', 'research', '--harness', 'gemini']);

    await runRoute(['link-account', 'research', 'gemini', 'personal']);
    expect(readRouter('research').harnesses.gemini.accounts).toEqual(['personal']);

    // linking the same account twice does not duplicate it
    await runRoute(['link-account', 'research', 'gemini', 'personal']);
    expect(readRouter('research').harnesses.gemini.accounts).toEqual(['personal']);

    await runRoute(['unlink-account', 'research', 'gemini', 'personal']);
    expect(readRouter('research').harnesses.gemini.accounts).toEqual([]);
  });

  it('fails loud linking an account to a harness that is not part of the router', async () => {
    await runRoute(['create', 'research', '--harness', 'gemini']);
    const result = await runRoute(['link-account', 'research', 'kimi', 'work']);
    expect(result.exitCode).toBe(1);
    expect(readRouter('research').harnesses.kimi).toBeUndefined();
  });
});

describe('agents route list --json', () => {
  it('emits one summary object per router', async () => {
    await runRoute(['create', 'zeta', '--harness', 'gemini', '--tier', 'cheap']);
    await runRoute(['create', 'alpha', '--harness', 'kimi,claude', '--tier', 'best']);

    const result = await runRoute(['list', '--json']);
    const payload = JSON.parse(result.stdout);
    expect(payload).toHaveLength(2);
    expect(payload.map((r: { name: string }) => r.name)).toEqual(['alpha', 'zeta']);
    const alpha = payload.find((r: { name: string }) => r.name === 'alpha');
    expect(alpha).toMatchObject({ name: 'alpha', harnessCount: 2, tierSummary: 'tier=best' });
  });

  it('emits an empty array when no routers exist', async () => {
    const result = await runRoute(['list', '--json']);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
});

describe('agents route show --json (alias view)', () => {
  it('emits the full router object', async () => {
    await runRoute(['create', 'research', '--harness', 'gemini,kimi', '--tier', 'cheap,default', '--task', 'research']);
    await runRoute(['link-account', 'research', 'gemini', 'personal']);

    const result = await runRoute(['show', 'research', '--json']);
    const payload = JSON.parse(result.stdout);
    expect(payload.name).toBe('research');
    expect(payload.task).toBe('research');
    expect(payload.harnesses.gemini).toEqual({ models: ['cheap', 'default'], accounts: ['personal'] });
    expect(payload.harnesses.kimi).toEqual({ models: ['cheap', 'default'] });
  });

  it('the view alias behaves identically to show', async () => {
    await runRoute(['create', 'research', '--harness', 'gemini']);
    const result = await runRoute(['view', 'research', '--json']);
    expect(JSON.parse(result.stdout).name).toBe('research');
  });

  it('fails loud for a router that does not exist', async () => {
    const result = await runRoute(['show', 'nope']);
    expect(result.exitCode).toBe(1);
  });
});

describe('agents route rm (alias remove)', () => {
  it('deletes the router file', async () => {
    await runRoute(['create', 'research', '--harness', 'gemini']);
    const result = await runRoute(['rm', 'research']);
    expect(result.exitCode).toBeNull();
    expect(routerExists('research')).toBe(false);
  });

  it('fails loud when the router does not exist', async () => {
    const result = await runRoute(['remove', 'nope']);
    expect(result.exitCode).toBe(1);
  });
});
