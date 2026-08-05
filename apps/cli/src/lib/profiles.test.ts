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
  profileLabel,
  editProfile,
  renameProfile,
  modelEnvKeyForHost,
  resolveProfileEnv,
  readProfile,
  resolveProfileForRun,
  writeProfile,
  listProfiles,
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

describe("resolveProfileForRun resolves cost tiers against the profile's OWN models", () => {
  it('resolves a tier token to the model configured under profile.models', () => {
    writeProfile({
      name: 'deepseek-flash',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash-0731' },
      models: {
        cheap: 'deepseek/deepseek-chat-v3',
        default: 'deepseek/deepseek-v4-flash-0731',
        best: 'deepseek/deepseek-r1',
      },
    });

    const resolved = resolveProfileForRun('deepseek-flash', 'best');
    expect(resolved.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-r1');
    expect(resolved.resolvedModel).toBe('deepseek/deepseek-r1');
    expect(resolved.tierNote).toBeUndefined();
  });

  it('clamps an unset tier to the next cheaper tier that IS set', () => {
    writeProfile({
      name: 'deepseek-flash',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash-0731' },
      // default and ultra are unset: ultra clamps down to best, default
      // clamps down to cheap.
      models: {
        cheap: 'deepseek/deepseek-chat-v3',
        best: 'deepseek/deepseek-r1',
      },
    });

    const ultra = resolveProfileForRun('deepseek-flash', 'ultra');
    expect(ultra.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-r1');
    expect(ultra.resolvedModel).toBe('deepseek/deepseek-r1');
    // A clamp is never silent -- mirrors the native-harness tier block, which
    // always announces when it substitutes a cheaper rung.
    expect(ultra.tierNote).toBe(
      `no "ultra" model configured on profile 'deepseek-flash'; using its "best" tier (deepseek/deepseek-r1)`,
    );

    const def = resolveProfileForRun('deepseek-flash', 'default');
    expect(def.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-chat-v3');
    expect(def.resolvedModel).toBe('deepseek/deepseek-chat-v3');
    expect(def.tierNote).toBe(
      `no "default" model configured on profile 'deepseek-flash'; using its "cheap" tier (deepseek/deepseek-chat-v3)`,
    );
  });

  it('degrades gracefully (no throw, env unchanged) when the profile has no models: at all', () => {
    writeProfile({
      name: 'kimi',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5' },
    });

    // No `models:` opt-in at all: this function leaves the tier token and env
    // untouched. It does NOT write its own "no model configured" note --
    // apps/cli/src/commands/exec.ts's profile-tier discard guard (merged
    // separately, "cost tiers don't apply to profile ...") is the canonical
    // message for this case, covered by its own test in exec.test.ts.
    const resolved = resolveProfileForRun('kimi', 'best');
    expect(resolved.env.ANTHROPIC_MODEL).toBe('moonshotai/kimi-k2.5');
    expect(resolved.resolvedModel).toBeUndefined();
    expect(resolved.tierNote).toBeUndefined();
  });

  it('degrades gracefully when models: is set but nothing at-or-below the requested tier is', () => {
    writeProfile({
      name: 'partial',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'some/pinned-model' },
      // Only `best` is configured; requesting `cheap` has nothing cheaper to
      // clamp to -- same no-opt-in-for-this-tier outcome as having no
      // `models:` block at all, deferring to exec.ts's discard guard.
      models: { best: 'deepseek/deepseek-r1' },
    });

    const resolved = resolveProfileForRun('partial', 'cheap');
    expect(resolved.env.ANTHROPIC_MODEL).toBe('some/pinned-model');
    expect(resolved.resolvedModel).toBeUndefined();
    expect(resolved.tierNote).toBeUndefined();
  });

  it('regression: tier resolution is NOT affected by the HOST agent\'s own catalog (the collision this fix closes)', () => {
    // The host is claude, but this profile pins its own deepseek models per
    // tier. Before this fix, resolveProfileForRun ignored the requested
    // model entirely and exec.ts's native tier block resolved "best" by
    // calling resolveTier(options.agent, ...) with options.agent already
    // overwritten to the HOST id ('claude') -- so a real claude-* id landing
    // in ANTHROPIC_MODEL here would reproduce that exact collision.
    writeProfile({
      name: 'deepseek-flash',
      host: { agent: 'claude', version: '2.1.219' },
      env: { ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash-0731' },
      models: {
        cheap: 'deepseek/deepseek-chat-v3',
        default: 'deepseek/deepseek-v4-flash-0731',
        best: 'deepseek/deepseek-r1',
      },
    });

    const resolved = resolveProfileForRun('deepseek-flash', 'best');
    expect(resolved.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-r1');
    // Never a native Claude catalog id -- proves the substitution came from
    // the profile's own `models:` map, not from resolving "best" against
    // claude's catalog.
    expect(resolved.env.ANTHROPIC_MODEL.startsWith('claude')).toBe(false);
  });

  it('leaves env untouched when --model is a concrete id, not a tier token', () => {
    writeProfile({
      name: 'kimi',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5' },
      models: { best: 'moonshotai/kimi-k3' },
    });

    const resolved = resolveProfileForRun('kimi', 'moonshotai/kimi-k2-0905');
    expect(resolved.env.ANTHROPIC_MODEL).toBe('moonshotai/kimi-k2.5');
    expect(resolved.resolvedModel).toBeUndefined();
    expect(resolved.tierNote).toBeUndefined();
  });

  it("leaves env unchanged when no --model is requested at all (today's default behavior)", () => {
    writeProfile({
      name: 'kimi',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5' },
      models: { best: 'moonshotai/kimi-k3' },
    });

    const resolved = resolveProfileForRun('kimi');
    expect(resolved.env.ANTHROPIC_MODEL).toBe('moonshotai/kimi-k2.5');
    expect(resolved.resolvedModel).toBeUndefined();
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

  it('a stored label field is never read for display — display derives from name always', () => {
    // Even if the source YAML carries a label key, profileLabel ignores it.
    const labelled: Profile = { ...source, label: 'DeepSeek Flash' };
    const forked = forkProfile(labelled, 'deepseek-chat', { model: 'deepseek/deepseek-chat-v3' });
    // 'deepseek-chat' → tokens ['deepseek','chat'] → 'DeepSeek Chat'
    expect(profileSummary(forked).label).toBe('DeepSeek Chat');
    // Plain copy: 'twin' → 'Twin'
    expect(profileSummary(forkProfile(labelled, 'twin')).label).toBe('Twin');
  });

  it('an inherited label field in YAML is not read for display after a fork', () => {
    // A profile whose YAML carries a 'label' key (old format) — profileLabel ignores it.
    const withStoredLabel: Profile = { ...source, label: 'Some Label' };
    const forked = forkProfile(withStoredLabel, 'chat');
    // name 'chat' has no vendor-table match → 'Chat'
    expect(profileSummary(forked).label).toBe('Chat');
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

describe('profileLabel — vendor/brand table + fallback', () => {
  const p = (name: string): Profile => ({ name, host: { agent: 'claude' }, env: {} });

  it('maps known vendor tokens to their canonical brand names', () => {
    expect(profileLabel(p('deepseek-flash'))).toBe('DeepSeek Flash');
    expect(profileLabel(p('openai-gpt4'))).toBe('OpenAI Gpt4');
    expect(profileLabel(p('grok-beta'))).toBe('Grok Beta');
    expect(profileLabel(p('gemini-pro'))).toBe('Gemini Pro');
    expect(profileLabel(p('kimi-k2'))).toBe('Kimi K2');
    expect(profileLabel(p('mistralai-large'))).toBe('Mistral Large');
    expect(profileLabel(p('gpt-4o'))).toBe('GPT 4o');
    expect(profileLabel(p('xai-grok'))).toBe('xAI Grok');
  });

  it('handles the multi-word moonshot expansion', () => {
    expect(profileLabel(p('moonshotai'))).toBe('Moonshot AI');
    expect(profileLabel(p('moonshot-v1'))).toBe('Moonshot AI V1');
  });

  it('capitalizes-first unmatched tokens', () => {
    expect(profileLabel(p('spark'))).toBe('Spark');
    expect(profileLabel(p('flash'))).toBe('Flash');
    expect(profileLabel(p('v3'))).toBe('V3');
  });

  it('splits on both dash and underscore', () => {
    expect(profileLabel(p('deepseek_chat_v3'))).toBe('DeepSeek Chat V3');
    expect(profileLabel(p('deepseek-flash'))).toBe('DeepSeek Flash');
  });

  it('is case-insensitive on vendor table lookups; fallback preserves rest-of-token case', () => {
    // vendor table matches are case-insensitive; unmatched tokens only capitalize the first char
    expect(profileLabel(p('DeepSeek-Flash'))).toBe('DeepSeek Flash');
    expect(profileLabel(p('GROK-beta'))).toBe('Grok Beta');
    // 'BETA' matches no table entry → first char already uppercase, rest preserved → 'BETA'
    expect(profileLabel(p('GROK-BETA'))).toBe('Grok BETA');
  });

  it('never reads a stored label field on the profile', () => {
    const withLabel: Profile = { ...p('deepseek-flash'), label: 'Stored Label' };
    expect(profileLabel(withLabel)).toBe('DeepSeek Flash');
  });
});

describe('editProfile — in-place edit preserving lineage', () => {
  const source: Profile = {
    name: 'deepseek-flash',
    host: { agent: 'claude' },
    env: {
      ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash-0731',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    },
    forkedFrom: 'openrouter',
    provider: 'openrouter',
  };

  it('returns a profile with the same name as the source', () => {
    const edited = editProfile(source, { model: 'deepseek/deepseek-chat-v3' });
    expect(edited.name).toBe('deepseek-flash');
  });

  it('applies overrides via forkProfile logic', () => {
    const edited = editProfile(source, { model: 'deepseek/deepseek-chat-v3' });
    expect(edited.env.ANTHROPIC_MODEL).toBe('deepseek/deepseek-chat-v3');
    expect(edited.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
  });

  it('restores forkedFrom to the original — does not self-reference', () => {
    // forkProfile would set forkedFrom = 'deepseek-flash'; editProfile must undo that.
    const edited = editProfile(source, { model: 'deepseek/deepseek-chat-v3' });
    expect(edited.forkedFrom).toBe('openrouter');
  });

  it('preserves a null forkedFrom when the source had none', () => {
    const noLineage: Profile = { ...source, forkedFrom: undefined };
    const edited = editProfile(noLineage, { model: 'deepseek/deepseek-chat-v3' });
    expect(edited.forkedFrom).toBeUndefined();
  });
});

describe('renameProfile — rename + forkedFrom cascade', () => {
  function writeTestProfile(name: string, forkedFrom?: string): void {
    writeProfile({
      name,
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'some-model' },
      ...(forkedFrom ? { forkedFrom } : {}),
    });
  }

  it('renames the profile on disk', () => {
    writeTestProfile('old-name');
    renameProfile('old-name', 'new-name');
    expect(readProfile('new-name').name).toBe('new-name');
    const profiles = listProfiles().map((p) => p.name);
    expect(profiles).toContain('new-name');
    expect(profiles).not.toContain('old-name');
  });

  it('throws when the source does not exist', () => {
    expect(() => renameProfile('no-such-profile', 'target')).toThrow(/not found/i);
  });

  it('throws when the target name already exists — no overwrite path', () => {
    writeTestProfile('source');
    writeTestProfile('target');
    expect(() => renameProfile('source', 'target')).toThrow(/already exists/i);
  });

  it('cascades forkedFrom across all children referencing the old name', () => {
    writeTestProfile('parent');
    writeTestProfile('child-a', 'parent');
    writeTestProfile('child-b', 'parent');
    writeTestProfile('unrelated', 'other-source');

    renameProfile('parent', 'parent-v2');

    expect(readProfile('child-a').forkedFrom).toBe('parent-v2');
    expect(readProfile('child-b').forkedFrom).toBe('parent-v2');
    // Unrelated profile's forkedFrom is untouched.
    expect(readProfile('unrelated').forkedFrom).toBe('other-source');
  });

  it('does not modify the renamed profile\'s own forkedFrom', () => {
    writeTestProfile('grandparent');
    writeTestProfile('parent', 'grandparent');
    writeTestProfile('child', 'parent');

    renameProfile('parent', 'parent-v2');

    // parent-v2's forkedFrom was 'grandparent' — must not be changed.
    expect(readProfile('parent-v2').forkedFrom).toBe('grandparent');
    // child's forkedFrom pointed at 'parent' → updated to 'parent-v2'.
    expect(readProfile('child').forkedFrom).toBe('parent-v2');
  });

  it('rejects an invalid new name before doing anything', () => {
    writeTestProfile('existing');
    expect(() => renameProfile('existing', 'bad name!')).toThrow(/invalid profile name/i);
    // existing profile must still be there
    expect(readProfile('existing').name).toBe('existing');
  });
});

describe('profileSummary — first-class harness fields', () => {
  it('surfaces the host version, description and fork lineage; label derives from name', () => {
    const summary = profileSummary({
      name: 'spark',
      label: 'Muse Spark',  // stored in YAML but not read for display
      host: { agent: 'opencode', version: '1.16.0' },
      env: { OPENCODE_MODEL: 'meta/muse-spark-1.1' },
      description: 'Muse Spark through OpenCode',
      forkedFrom: 'opencode',
    });
    // label derived from name 'spark' → 'Spark', not from the stored 'Muse Spark'
    expect(summary.label).toBe('Spark');
    expect(summary.hostVersion).toBe('1.16.0');
    expect(summary.description).toBe('Muse Spark through OpenCode');
    expect(summary.forkedFrom).toBe('opencode');
    expect(summary.model).toBe('meta/muse-spark-1.1');
  });

  it('label derives from name even when no label field is present', () => {
    const summary = profileSummary({ name: 'spark', host: { agent: 'opencode' }, env: {} });
    // 'spark' → no vendor match → 'Spark'
    expect(summary.label).toBe('Spark');
    expect(summary.hostVersion).toBeNull();
    expect(summary.forkedFrom).toBeNull();
  });
});
