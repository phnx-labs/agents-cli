import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from './state.js';
import {
  profileModelEnvKey,
  profileFromHostModel,
  modelEnvKeyForHost,
  resolveProfileEnv,
  readProfile,
  resolveProfileForRun,
  writeProfile,
  type Profile,
} from './profiles.js';

let TEST_ROOT: string;
let USER_DIR: string;

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
  USER_DIR = path.join(TEST_ROOT, '.agents');
  fs.mkdirSync(path.join(USER_DIR, 'profiles'), { recursive: true });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(USER_DIR);
});

afterEach(() => {
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
