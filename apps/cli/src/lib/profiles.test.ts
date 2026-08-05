import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from './state.js';
import {
  profileModelEnvKey,
  profileFromHostModel,
  forkProfile,
  profileSummary,
  modelEnvKeyForHost,
  resolveProfileEnv,
  readProfile,
  resolveProfileForRun,
  writeProfile,
  editProfile,
  renameProfile,
  profileExists,
  type Profile,
} from './profiles.js';
import { setKeychainBackendForTest, setKeychainHeadlessDetectorForTest, type KeychainBackend } from './secrets/index.js';

let TEST_ROOT: string;
let USER_DIR: string;
let prevBackend: ReturnType<typeof setKeychainBackendForTest>;

/**
 * An always-empty keychain. `resolveProfileEnv` probes for a stored token, and
 * on macOS that probe resolves the signed helper — which ships only in a built
 * npm tarball, so on CI and on any source checkout it threw "Source Agents
 * CLI.app not found" before the authOptional branch could be reached. Installing
 * the sanctioned test backend gives the probe a real answer (no token stored)
 * without a helper, and keeps the production primitive failing loudly, which is
 * what protects the --force overwrite guards that also call it.
 */
class EmptyKeychain implements KeychainBackend {
  store = new Map<string, string>();
  has(item: string) { return this.store.has(item); }
  // Mirrors the production wording so the required-auth test still asserts on
  // the message a real missing item produces.
  get(item: string): string { throw new Error(`Keychain item not found: ${item}`); }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
}

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
  USER_DIR = path.join(TEST_ROOT, '.agents');
  fs.mkdirSync(path.join(USER_DIR, 'profiles'), { recursive: true });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(USER_DIR);
  prevBackend = setKeychainBackendForTest(new EmptyKeychain());
});

afterEach(() => {
  setKeychainBackendForTest(prevBackend);
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('Profile fallback_model round-trip', () => {
  it('writes fallback_model to YAML and reads it back unchanged', () => {
    const profile: Profile = {
      name: 'kimi',
      host: { agent: 'claude' },
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
      },
      provider: 'openrouter',
      fallback_model: 'moonshotai/kimi-k2-0905',
    };
    writeProfile(profile);

    const raw = fs.readFileSync(path.join(USER_DIR, 'profiles', 'kimi.yml'), 'utf-8');
    expect(raw).toContain('fallback_model: moonshotai/kimi-k2-0905');

    const roundTripped = readProfile('kimi');
    expect(roundTripped.fallback_model).toBe('moonshotai/kimi-k2-0905');
    expect(roundTripped.env.ANTHROPIC_MODEL).toBe('moonshotai/kimi-k2.5');
  });

  it('omits fallback_model when not set (backward compatible)', () => {
    const profile: Profile = {
      name: 'plain',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
    };
    writeProfile(profile);

    const roundTripped = readProfile('plain');
    expect(roundTripped.fallback_model).toBeUndefined();
  });
});

describe('profileModelEnvKey', () => {
  it('returns ANTHROPIC_MODEL when set', () => {
    const p: Profile = {
      name: 'p',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'claude-x' },
    };
    expect(profileModelEnvKey(p)).toBe('ANTHROPIC_MODEL');
  });

  it('returns OPENAI_MODEL for codex-shaped profiles', () => {
    const p: Profile = {
      name: 'p',
      host: { agent: 'codex' },
      env: { OPENAI_MODEL: 'gpt-x', OPENAI_BASE_URL: 'https://x' },
    };
    expect(profileModelEnvKey(p)).toBe('OPENAI_MODEL');
  });

  it('falls back to any *_MODEL suffix when no known key matches', () => {
    const p: Profile = {
      name: 'p',
      host: { agent: 'claude' },
      env: { CUSTOM_MODEL: 'x' },
    };
    expect(profileModelEnvKey(p)).toBe('CUSTOM_MODEL');
  });

  it('returns null when no model env is present', () => {
    const p: Profile = {
      name: 'p',
      host: { agent: 'claude' },
      env: { ANTHROPIC_BASE_URL: 'https://x' },
    };
    expect(profileModelEnvKey(p)).toBeNull();
  });
});

describe('profileFromHostModel (custom harness from host + model)', () => {
  it('pins the model on the host-appropriate env key', () => {
    expect(modelEnvKeyForHost('opencode')).toBe('OPENCODE_MODEL');
    expect(modelEnvKeyForHost('claude')).toBe('ANTHROPIC_MODEL');
    expect(modelEnvKeyForHost('grok')).toBe('GROK_MODEL');

    const spark = profileFromHostModel('spark', 'opencode', 'meta/muse-spark-1.1');
    expect(spark.host.agent).toBe('opencode');
    expect(spark.env.OPENCODE_MODEL).toBe('meta/muse-spark-1.1');
    // No provider/authEnvVar → no auth block; the host uses its own login.
    expect(spark.auth).toBeUndefined();
  });

  it('sets ANTHROPIC_BASE_URL for a claude host when --base-url is given', () => {
    const p = profileFromHostModel('corp', 'claude', 'gpt-x', { baseUrl: 'https://gw.corp/v1' });
    expect(p.env.ANTHROPIC_MODEL).toBe('gpt-x');
    expect(p.env.ANTHROPIC_BASE_URL).toBe('https://gw.corp/v1');
  });

  it('attaches a keychain auth block only when provider + authEnvVar are supplied', () => {
    const p = profileFromHostModel('corp', 'claude', 'gpt-x', {
      provider: 'corp',
      authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    });
    expect(p.auth?.envVar).toBe('ANTHROPIC_AUTH_TOKEN');
    expect(p.auth?.keychainItem).toContain('corp');
    expect(p.authOptional).toBe(false);
  });
});

describe('resolveProfileEnv honors authOptional', () => {
  it('does not throw and injects no auth env when auth is optional and no token is stored', () => {
    const p: Profile = {
      name: 'spark',
      host: { agent: 'opencode' },
      env: { OPENCODE_MODEL: 'meta/muse-spark-1.1' },
      auth: { envVar: 'OPENCODE_API_KEY', keychainItem: 'agents-cli.no-such-provider-xyz.token' },
      authOptional: true,
    };
    const env = resolveProfileEnv(p);
    expect(env.OPENCODE_MODEL).toBe('meta/muse-spark-1.1');
    expect(env.OPENCODE_API_KEY).toBeUndefined();
  });

  it('STILL throws for REQUIRED auth with a missing token (the load-bearing safety property)', () => {
    // authOptional omitted (required). A missing keychain item must hard-fail —
    // the authOptional skip must never leak into the required-auth path.
    const p: Profile = {
      name: 'corp',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'gpt-x' },
      auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.no-such-provider-xyz.token' },
    };
    expect(() => resolveProfileEnv(p)).toThrow(/not found/i);
  });
});

describe('resolveProfileEnv fails fast in a headless context', () => {
  // The Touch ID storm fix: `agents run <profile>` beneath a headless/teams/
  // terminal runtime (or any TTY-less spawn) must throw the actionable error
  // instead of raising a sheet nobody is watching. The memory backend is
  // removed for these tests so resolveProfileEnv reaches the REAL raw-read
  // guard in getKeychainToken; the detector seam stands in for the darwin-only
  // headless signal so the throw is exercisable on any CI platform.
  it('throws the actionable headless error instead of attempting a prompting read', () => {
    setKeychainBackendForTest(null);
    setKeychainHeadlessDetectorForTest(() => true);
    try {
      const p: Profile = {
        name: 'kimi',
        host: { agent: 'kimi' as Profile['host']['agent'] },
        env: {},
        auth: { envVar: 'KIMI_API_KEY', keychainItem: 'agents-cli.kimi.token' },
      };
      expect(() => resolveProfileEnv(p)).toThrow(/non-interactive/);
      expect(() => resolveProfileEnv(p)).toThrow(/agents-cli\.kimi\.token/);
    } finally {
      setKeychainHeadlessDetectorForTest(null);
    }
  });

  it('an interactive context is unaffected — the required-auth missing-item error survives', () => {
    setKeychainBackendForTest(null);
    setKeychainHeadlessDetectorForTest(() => false);
    try {
      const p: Profile = {
        name: 'corp',
        host: { agent: 'claude' },
        env: {},
        auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.no-such-provider-xyz.token' },
      };
      // Past the guard the read reaches the real platform path (helper absent
      // in a source checkout / item absent on CI) — never the headless error.
      expect(() => resolveProfileEnv(p)).toThrow(/^(?!.*non-interactive).*$/);
    } finally {
      setKeychainHeadlessDetectorForTest(null);
    }
  });
});

describe('resolveProfileForRun surfaces fallback_model as an env-swap', () => {
  it('reports the model env key + fallback value so the fallback cascade can swap it', () => {
    writeProfile({
      name: 'kimi',
      host: { agent: 'claude' },
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
      },
      fallback_model: 'moonshotai/kimi-k2-0905',
    });

    const resolved = resolveProfileForRun('kimi');
    expect(resolved.fallbackModel).toEqual({
      envKey: 'ANTHROPIC_MODEL',
      model: 'moonshotai/kimi-k2-0905',
    });
    // Primary env still points at the primary model — the swap only applies
    // on retry via the runWithFallback envOverride.
    expect(resolved.env.ANTHROPIC_MODEL).toBe('moonshotai/kimi-k2.5');
  });

  it('leaves fallbackModel undefined when the profile omits fallback_model', () => {
    writeProfile({
      name: 'plain',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
    });
    expect(resolveProfileForRun('plain').fallbackModel).toBeUndefined();
  });

  it('leaves fallbackModel undefined when the profile has no recognizable model env key', () => {
    writeProfile({
      name: 'weird',
      host: { agent: 'claude' },
      env: { ANTHROPIC_BASE_URL: 'https://x' },
      fallback_model: 'ignored-because-no-key-to-swap',
    });
    expect(resolveProfileForRun('weird').fallbackModel).toBeUndefined();
  });
});

describe('forkProfile — copy an existing harness under a new name', () => {
  const source: Profile = {
    name: 'deepseek',
    host: { agent: 'claude', version: '2.1.219' },
    env: {
      ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash-0731',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    },
    auth: { envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.openrouter.token' },
    authOptional: false,
    description: 'Custom harness: claude + deepseek/deepseek-v4-flash-0731',
    preset: 'deepseek',
    provider: 'openrouter',
    fallback_model: 'deepseek/deepseek-chat-v3',
  };

  it('carries env, auth, host pin and fallback across, and records the lineage', () => {
    const forked = forkProfile(source, 'deepseek-copy');
    expect(forked.name).toBe('deepseek-copy');
    expect(forked.forkedFrom).toBe('deepseek');
    expect(forked.host).toEqual({ agent: 'claude', version: '2.1.219' });
    expect(forked.env).toEqual(source.env);
    expect(forked.auth).toEqual(source.auth);
    expect(forked.fallback_model).toBe('deepseek/deepseek-chat-v3');
  });

  it('does not alias the source env — editing the fork leaves the source alone', () => {
    const forked = forkProfile(source, 'deepseek-copy', { model: 'deepseek/deepseek-chat-v3' });
    expect(forked.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-chat-v3');
    expect(source.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('writes the swapped model onto the source model env key, keeping the endpoint', () => {
    const forked = forkProfile(source, 'chat', { model: 'deepseek/deepseek-chat-v3' });
    expect(forked.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-chat-v3');
    expect(forked.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
  });

  it('drops the preset link and the stale description once the model is swapped', () => {
    const forked = forkProfile(source, 'chat', { model: 'deepseek/deepseek-chat-v3' });
    expect(forked.preset).toBeUndefined();
    expect(forked.description).toBe('Forked from deepseek: deepseek/deepseek-chat-v3');
  });

  it('keeps the preset link and description when nothing model-shaped changed', () => {
    const forked = forkProfile(source, 'twin');
    expect(forked.preset).toBe('deepseek');
    expect(forked.description).toBe(source.description);
  });

  it('repoints auth at another provider keychain item, reusing the host auth env var', () => {
    const forked = forkProfile(source, 'corp', { provider: 'corp' });
    expect(forked.provider).toBe('corp');
    expect(forked.auth).toEqual({ envVar: 'ANTHROPIC_AUTH_TOKEN', keychainItem: 'agents-cli.corp.token' });
  });

  it('never inherits the source label — two harnesses must not share one view header', () => {
    const labelled: Profile = { ...source, label: 'DeepSeek Flash' };
    const forked = forkProfile(labelled, 'deepseek-chat', { model: 'deepseek/deepseek-chat-v3' });
    expect(forked.label).toBeUndefined();
    expect(profileSummary(forked).label).toBe('deepseek-chat');
    // A straight copy with no overrides must not inherit it either.
    expect(forkProfile(labelled, 'twin').label).toBeUndefined();
  });

  it('carries an explicitly given label onto the fork', () => {
    const forked = forkProfile(source, 'chat', { label: 'DeepSeek Chat' });
    expect(profileSummary(forked).label).toBe('DeepSeek Chat');
  });

  it('re-pins the host version when asked', () => {
    expect(forkProfile(source, 'pinned', { version: '2.1.170' }).host.version).toBe('2.1.170');
  });

  it('rejects --base-url on a host with no known base-URL env var', () => {
    const opencodeSource: Profile = { name: 'spark', host: { agent: 'opencode' }, env: { OPENCODE_MODEL: 'm' } };
    expect(() => forkProfile(opencodeSource, 'spark2', { baseUrl: 'https://gw.corp/v1' })).toThrow(/no known base-URL env var/i);
  });

  it('rejects an invalid fork name before copying anything', () => {
    expect(() => forkProfile(source, 'bad name!')).toThrow(/invalid profile name/i);
  });
});

describe('profileSummary — first-class harness fields', () => {
  it('surfaces the label, host version, description and fork lineage', () => {
    const summary = profileSummary({
      name: 'spark',
      label: 'Muse Spark',
      host: { agent: 'opencode', version: '1.16.0' },
      env: { OPENCODE_MODEL: 'meta/muse-spark-1.1' },
      description: 'Muse Spark through OpenCode',
      forkedFrom: 'opencode',
    });
    expect(summary.label).toBe('Muse Spark');
    expect(summary.hostVersion).toBe('1.16.0');
    expect(summary.description).toBe('Muse Spark through OpenCode');
    expect(summary.forkedFrom).toBe('opencode');
    expect(summary.model).toBe('meta/muse-spark-1.1');
  });

  it('falls back to the harness name when no label is set', () => {
    const summary = profileSummary({ name: 'spark', host: { agent: 'opencode' }, env: {} });
    expect(summary.label).toBe('spark');
    expect(summary.hostVersion).toBeNull();
    expect(summary.forkedFrom).toBeNull();
  });
});

describe('editProfile — in-place field edits', () => {
  function seedProfile(p: Profile): void {
    writeProfile(p);
  }

  it('swaps the model onto the existing model env key', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: { OPENCODE_MODEL: 'meta/muse-spark-1.1' } });
    const updated = editProfile('spark', { model: 'meta/muse-spark-2.0' });
    expect(updated.env.OPENCODE_MODEL).toBe('meta/muse-spark-2.0');
    expect(readProfile('spark').env.OPENCODE_MODEL).toBe('meta/muse-spark-2.0');
  });

  it('falls back to the host model env key when no key is already present', () => {
    seedProfile({ name: 'bare', host: { agent: 'claude' }, env: {} });
    editProfile('bare', { model: 'claude-opus-5' });
    expect(readProfile('bare').env.ANTHROPIC_MODEL).toBe('claude-opus-5');
  });

  it('sets the label', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: {} });
    editProfile('spark', { label: 'Muse Spark 2.0' });
    expect(readProfile('spark').label).toBe('Muse Spark 2.0');
  });

  it('clears the label when passed as empty string', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: {}, label: 'Old Label' });
    editProfile('spark', { label: '' });
    expect(readProfile('spark').label).toBeUndefined();
  });

  it('sets the description', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: {} });
    editProfile('spark', { description: 'fast coding assistant' });
    expect(readProfile('spark').description).toBe('fast coding assistant');
  });

  it('clears the description when passed as empty string', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: {}, description: 'old' });
    editProfile('spark', { description: '' });
    expect(readProfile('spark').description).toBeUndefined();
  });

  it('sets the base URL for a claude host', () => {
    seedProfile({ name: 'corp', host: { agent: 'claude' }, env: {} });
    editProfile('corp', { baseUrl: 'https://gw.corp/v1' });
    expect(readProfile('corp').env.ANTHROPIC_BASE_URL).toBe('https://gw.corp/v1');
  });

  it('clears the base URL when passed as empty string', () => {
    seedProfile({ name: 'corp', host: { agent: 'claude' }, env: { ANTHROPIC_BASE_URL: 'https://old.corp' } });
    editProfile('corp', { baseUrl: '' });
    expect(readProfile('corp').env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('rejects --base-url on a host with no known base-URL env var', () => {
    seedProfile({ name: 'grok-h', host: { agent: 'grok' }, env: {} });
    expect(() => editProfile('grok-h', { baseUrl: 'https://x.ai' })).toThrow(/no known base-URL env var/i);
  });

  it('pins the host version', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: {} });
    editProfile('spark', { version: '1.2.0' });
    expect(readProfile('spark').host.version).toBe('1.2.0');
  });

  it('unpins the host version when passed as empty string', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode', version: '1.1.0' }, env: {} });
    editProfile('spark', { version: '' });
    expect(readProfile('spark').host.version).toBeUndefined();
  });

  it('sets the fallback model', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: { OPENCODE_MODEL: 'meta/muse-spark-1.1' } });
    editProfile('spark', { fallbackModel: 'meta/muse-spark-lite' });
    expect(readProfile('spark').fallback_model).toBe('meta/muse-spark-lite');
  });

  it('clears the fallback model when passed as empty string', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: {}, fallback_model: 'old-fallback' });
    editProfile('spark', { fallbackModel: '' });
    expect(readProfile('spark').fallback_model).toBeUndefined();
  });

  it('leaves untouched fields unchanged', () => {
    seedProfile({ name: 'spark', host: { agent: 'opencode' }, env: { OPENCODE_MODEL: 'meta/muse-spark-1.1' }, label: 'Spark', description: 'fast' });
    editProfile('spark', { model: 'meta/muse-spark-2.0' });
    const updated = readProfile('spark');
    expect(updated.label).toBe('Spark');
    expect(updated.description).toBe('fast');
  });

  it('throws when the profile does not exist', () => {
    expect(() => editProfile('nosuch', { model: 'x' })).toThrow(/not found/i);
  });
});

describe('renameProfile — rename file and name field', () => {
  it('creates the new file, updates name, and removes the old file', () => {
    writeProfile({ name: 'spark', host: { agent: 'opencode' }, env: { OPENCODE_MODEL: 'meta/muse-spark-1.1' } });
    renameProfile('spark', 'muse');
    expect(profileExists('spark')).toBe(false);
    expect(profileExists('muse')).toBe(true);
    const renamed = readProfile('muse');
    expect(renamed.name).toBe('muse');
    expect(renamed.env.OPENCODE_MODEL).toBe('meta/muse-spark-1.1');
  });

  it('preserves all other fields across the rename', () => {
    writeProfile({ name: 'spark', host: { agent: 'opencode' }, env: {}, label: 'Spark', description: 'fast', forkedFrom: 'opencode' });
    renameProfile('spark', 'muse');
    const renamed = readProfile('muse');
    expect(renamed.label).toBe('Spark');
    expect(renamed.description).toBe('fast');
    expect(renamed.forkedFrom).toBe('opencode');
  });

  it('throws when new name already exists', () => {
    writeProfile({ name: 'spark', host: { agent: 'opencode' }, env: {} });
    writeProfile({ name: 'muse', host: { agent: 'opencode' }, env: {} });
    expect(() => renameProfile('spark', 'muse')).toThrow(/already exists/i);
  });

  it('throws when old name does not exist', () => {
    expect(() => renameProfile('nosuch', 'newname')).toThrow(/not found/i);
  });

  it('rejects an invalid new name', () => {
    writeProfile({ name: 'spark', host: { agent: 'opencode' }, env: {} });
    expect(() => renameProfile('spark', 'bad name!')).toThrow(/invalid profile name/i);
  });
});
