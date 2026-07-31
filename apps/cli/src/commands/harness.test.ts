import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../lib/state.js';
import { addProfile } from './profiles.js';
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
