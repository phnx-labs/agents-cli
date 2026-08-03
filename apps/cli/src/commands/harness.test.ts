import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../lib/state.js';
import { addProfile } from './profiles.js';
import { buildFork } from './harness.js';
import { readProfile } from '../lib/profiles.js';

let TEST_ROOT: string;
let USER_DIR: string;

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  USER_DIR = path.join(TEST_ROOT, '.agents');
  fs.mkdirSync(path.join(USER_DIR, 'profiles'), { recursive: true });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(USER_DIR);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('addProfile — host + model one-shot (custom harness)', () => {
  it('writes a profile with the model on the host env var and no auth block', async () => {
    await addProfile('spark', { host: 'opencode', model: 'meta/muse-spark-1.1' }, 'Harness');
    const p = readProfile('spark');
    expect(p.host.agent).toBe('opencode');
    expect(p.env.OPENCODE_MODEL).toBe('meta/muse-spark-1.1');
    expect(p.auth).toBeUndefined();
  });

  it('rejects --host without --model', async () => {
    await expect(addProfile('x', { host: 'opencode' })).rejects.toThrow(/both --host .* and --model/i);
  });

  it('rejects an unknown host', async () => {
    await expect(addProfile('x', { host: 'not-an-agent', model: 'm' })).rejects.toThrow(/unknown host/i);
  });

  it('refuses to overwrite an existing harness without --force', async () => {
    await addProfile('spark', { host: 'opencode', model: 'meta/muse-spark-1.1' });
    await expect(addProfile('spark', { host: 'claude', model: 'x' })).rejects.toThrow(/already exists/i);
    // --force overwrites
    await addProfile('spark', { host: 'claude', model: 'claude-x', force: true });
    expect(readProfile('spark').env.ANTHROPIC_MODEL).toBe('claude-x');
  });
});

describe('buildFork — one verb over two kinds of source', () => {
  it('turns a native agent id into a harness pinned to --model', () => {
    const forked = buildFork('opencode', 'spark', { model: 'meta/muse-spark-1.1' });
    expect(forked.host.agent).toBe('opencode');
    expect(forked.env.OPENCODE_MODEL).toBe('meta/muse-spark-1.1');
    expect(forked.forkedFrom).toBe('opencode');
    expect(forked.auth).toBeUndefined();
  });

  it('resolves a native source through the agent-name aliases', () => {
    expect(buildFork('claude-code', 'cc', { model: 'x' }).host.agent).toBe('claude');
  });

  it('requires --model when forking a native harness', () => {
    expect(() => buildFork('claude', 'x', {})).toThrow(/--model .* is required/i);
  });

  it('copies an existing custom harness, inheriting its model when none is given', async () => {
    await addProfile('deepseek', { host: 'claude', model: 'deepseek/deepseek-v4-flash-0731' }, 'Harness');
    const forked = buildFork('deepseek', 'deepseek-copy', {});
    expect(forked.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-v4-flash-0731');
    expect(forked.forkedFrom).toBe('deepseek');
  });

  it('prefers an existing custom harness over a native id of the same name', async () => {
    // A harness may legally be named after a native agent; the custom one wins
    // so `fork claude my-claude` copies the user's tuning, not a bare host.
    await addProfile('claude', { host: 'opencode', model: 'meta/muse-spark-1.1' }, 'Harness');
    expect(buildFork('claude', 'copy', {}).host.agent).toBe('opencode');
  });

  it('rejects a source that is neither a harness nor an agent', () => {
    expect(() => buildFork('nosuch', 'x', { model: 'm' })).toThrow(/no harness or agent named 'nosuch'/i);
  });

  it('rejects --auth-provider on a host with no auth env var', () => {
    expect(() => buildFork('goose', 'x', { model: 'm', authProvider: 'corp' })).toThrow(/no known auth env var/i);
  });

  it('attaches keychain-backed auth for a provider on a host that reads a token', () => {
    const forked = buildFork('claude', 'corp', { model: 'gpt-x', baseUrl: 'https://gw.corp/v1', authProvider: 'corp' });
    expect(forked.env.ANTHROPIC_BASE_URL).toBe('https://gw.corp/v1');
    expect(forked.auth).toEqual({ envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.corp.token' });
  });
});
