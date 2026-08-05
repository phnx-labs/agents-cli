import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../lib/state.js';
import { addProfile, applyFromSecrets } from './profiles.js';
import { buildFork, buildEdit, hasEditFlags, forkNeedsWizard, addNeedsWizard } from './harness.js';
import { readProfile, writeProfile, type Profile } from '../lib/profiles.js';
import { setKeychainBackendForTest, secretsKeychainItem, getKeychainToken, type KeychainBackend } from '../lib/secrets/index.js';
import { keychainItemName } from '../lib/secrets/profiles.js';
import { writeBundleWithItems, keychainRef } from '../lib/secrets/bundles.js';

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

describe('buildEdit — pure builder for `agents harness edit`', () => {
  beforeEach(async () => {
    await addProfile('deepseek-flash', { host: 'claude', model: 'deepseek/deepseek-v4-flash-0731', version: '2.1.170' }, 'Harness');
  });

  it('changes exactly the given field and leaves the rest untouched', () => {
    const before = readProfile('deepseek-flash');
    // --description alone touches only the description — model, version, host stay put.
    const edited = buildEdit('deepseek-flash', { description: 'new description' });
    expect(edited.description).toBe('new description');
    expect(edited.env.ANTHROPIC_MODEL).toBe(before.env.ANTHROPIC_MODEL);
    expect(edited.host.version).toBe(before.host.version);
    expect(edited.host.agent).toBe(before.host.agent);
    expect(edited.name).toBe('deepseek-flash');
  });

  it('re-derives the description from the new model when --model changes it without an explicit --description (matches forkProfile)', () => {
    const edited = buildEdit('deepseek-flash', { model: 'deepseek/deepseek-chat-v3' });
    expect(edited.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-chat-v3');
    expect(edited.description).toContain('deepseek/deepseek-chat-v3');
  });

  it('rejects a nonexistent harness', () => {
    expect(() => buildEdit('does-not-exist', { model: 'x' })).toThrow(/not found/i);
  });

  it('rejects zero flags with a message naming the available ones', () => {
    expect(() => buildEdit('deepseek-flash', {})).toThrow(/no changes given/i);
    expect(() => buildEdit('deepseek-flash', {})).toThrow(/--fallback-model/);
  });

  it('unpins the host version when --version is an explicit empty string', () => {
    expect(readProfile('deepseek-flash').host.version).toBe('2.1.170');
    const edited = buildEdit('deepseek-flash', { version: '' });
    expect(edited.host.version).toBeUndefined();
  });

  it('leaves the version untouched when --version is omitted', () => {
    const edited = buildEdit('deepseek-flash', { model: 'deepseek/deepseek-chat-v3' });
    expect(edited.host.version).toBe('2.1.170');
  });

  it('sets and clears fallback_model, an edit-only field no other flag touches', () => {
    const withFallback = buildEdit('deepseek-flash', { fallbackModel: 'deepseek/deepseek-chat-v3' });
    expect(withFallback.fallback_model).toBe('deepseek/deepseek-chat-v3');
    writeProfile(withFallback);
    const cleared = buildEdit('deepseek-flash', { fallbackModel: '' });
    expect(cleared.fallback_model).toBeUndefined();
  });

  it('does not rewrite forkedFrom to itself (the bug editProfile exists to avoid)', () => {
    const edited = buildEdit('deepseek-flash', { model: 'deepseek/deepseek-chat-v3' });
    expect(edited.forkedFrom).not.toBe('deepseek-flash');
    expect(edited.forkedFrom).toBe('claude');
  });
});

describe('hasEditFlags — zero-flags detection', () => {
  it('is false for an empty options object', () => {
    expect(hasEditFlags({})).toBe(false);
  });

  it('is true when any single recognized flag is present, including an explicit empty string', () => {
    expect(hasEditFlags({ model: 'x' })).toBe(true);
    expect(hasEditFlags({ version: '' })).toBe(true);
    expect(hasEditFlags({ fallbackModel: '' })).toBe(true);
    expect(hasEditFlags({ fromSecrets: 'bundle' })).toBe(true);
  });
});

describe('forkNeedsWizard / addNeedsWizard — when the interactive wizard should take over', () => {
  it('fork needs the wizard when source or name is missing', () => {
    expect(forkNeedsWizard(undefined, undefined, {})).toBe(true);
    expect(forkNeedsWizard('claude', undefined, {})).toBe(true);
    expect(forkNeedsWizard(undefined, 'x', {})).toBe(true);
  });

  it('fork needs the wizard when forking a native host without --model', () => {
    expect(forkNeedsWizard('claude', 'x', {})).toBe(true);
    expect(forkNeedsWizard('claude', 'x', { model: 'gpt-x' })).toBe(false);
  });

  it('fork does not need the wizard when copying an existing harness with no --model (inherits)', async () => {
    await addProfile('deepseek', { host: 'claude', model: 'deepseek/deepseek-v4-flash-0731' }, 'Harness');
    expect(forkNeedsWizard('deepseek', 'deepseek-copy', {})).toBe(false);
  });

  it('add needs the wizard with no name', () => {
    expect(addNeedsWizard(undefined, {})).toBe(true);
  });

  it('add does not need the wizard when --preset or --host+--model are sufficient', () => {
    expect(addNeedsWizard('x', { preset: 'kimi' })).toBe(false);
    expect(addNeedsWizard('x', { host: 'opencode', model: 'meta/muse-spark-1.1' })).toBe(false);
  });

  it('add needs the wizard on a partial --host/--model pair', () => {
    expect(addNeedsWizard('x', { host: 'opencode' })).toBe(true);
    expect(addNeedsWizard('x', { model: 'meta/muse-spark-1.1' })).toBe(true);
  });

  it('add does not need the wizard when a bare name matches a built-in preset (existing convenience path)', () => {
    expect(addNeedsWizard('kimi', {})).toBe(false);
  });

  it('add needs the wizard for a bare name that matches no preset', () => {
    expect(addNeedsWizard('not-a-preset-name', {})).toBe(true);
  });
});

describe('applyFromSecrets — copy a value out of an agents secrets bundle', () => {
  class MemoryKeychain implements KeychainBackend {
    store = new Map<string, string>();
    has(item: string) { return this.store.has(item); }
    get(item: string): string {
      const v = this.store.get(item);
      if (v === undefined) throw new Error(`Keychain item not found: ${item}`);
      return v;
    }
    set(item: string, value: string) { this.store.set(item, value); }
    delete(item: string) { return this.store.delete(item); }
    list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  }

  let prevBackend: ReturnType<typeof setKeychainBackendForTest>;

  beforeEach(() => {
    prevBackend = setKeychainBackendForTest(new MemoryKeychain());
    writeBundleWithItems(
      { name: 'prod', vars: { OPENROUTER_KEY: keychainRef('OPENROUTER_KEY') } },
      new Map([[secretsKeychainItem('prod', 'OPENROUTER_KEY'), 'sk-test-secret']]),
    );
    writeBundleWithItems(
      { name: 'multi', vars: { A: keychainRef('A'), B: keychainRef('B') } },
      new Map([
        [secretsKeychainItem('multi', 'A'), 'value-a'],
        [secretsKeychainItem('multi', 'B'), 'value-b'],
      ]),
    );
  });

  afterEach(() => {
    setKeychainBackendForTest(prevBackend);
  });

  it('copies the sole key of a single-key bundle into the harness\'s own keychain item', async () => {
    const profile: Profile = { name: 'corp', host: { agent: 'claude' }, env: {} };
    await applyFromSecrets(profile, 'prod', 'corp');
    expect(getKeychainToken(keychainItemName('corp'))).toBe('sk-test-secret');
    expect(profile.auth).toEqual({ envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.corp.token' });
    expect(profile.authOptional).toBe(false);
  });

  it('requires an explicit key when the bundle has more than one', async () => {
    const profile: Profile = { name: 'corp', host: { agent: 'claude' }, env: {} };
    await expect(applyFromSecrets(profile, 'multi', 'corp')).rejects.toThrow(/pick one with --from-secrets/i);
    await applyFromSecrets(profile, 'multi:B', 'corp');
    expect(getKeychainToken(keychainItemName('corp'))).toBe('value-b');
  });

  it('throws a clear error for an unknown key', async () => {
    const profile: Profile = { name: 'corp', host: { agent: 'claude' }, env: {} };
    await expect(applyFromSecrets(profile, 'multi:NOPE', 'corp')).rejects.toThrow(/no key 'NOPE'/i);
  });

  it('falls back to the profile\'s own provider when no --auth-provider is given (rotate without repeating it)', async () => {
    const profile: Profile = {
      name: 'corp',
      host: { agent: 'claude' },
      env: {},
      provider: 'corp',
      auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.corp.token' },
    };
    await applyFromSecrets(profile, 'prod');
    expect(getKeychainToken('agents-cli.corp.token')).toBe('sk-test-secret');
    // Existing auth binding is left exactly as it was — only the value rotated.
    expect(profile.auth).toEqual({ envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.corp.token' });
  });

  it('falls back to the bundle name as the provider and attaches auth when the profile had neither', async () => {
    const profile: Profile = { name: 'corp2', host: { agent: 'codex' }, env: {} };
    await applyFromSecrets(profile, 'prod');
    expect(getKeychainToken(keychainItemName('prod'))).toBe('sk-test-secret');
    expect(profile.provider).toBe('prod');
    expect(profile.auth).toEqual({ envVar: 'OPENAI_API_KEY', keychainItem: 'agents-cli.prod.token' });
  });

  it('throws a clear error when the host has no known auth env var to attach', async () => {
    const profile: Profile = { name: 'spark', host: { agent: 'cursor' }, env: {} };
    await expect(applyFromSecrets(profile, 'prod')).rejects.toThrow(/no known auth env var/i);
  });
});
