/**
 * Profile management -- named bundles of (host CLI, endpoint, model, auth).
 *
 * Profiles let users run agents against alternative providers (OpenRouter,
 * custom endpoints) without reconfiguring the agent CLI itself. Stored as
 * YAML files under ~/.agents/profiles/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from './types.js';
import { getUserAgentsDir } from './state.js';
import { getKeychainToken, hasKeychainToken, keychainItemName } from './secrets/profiles.js';
import { getPreset, type Preset } from './profiles-presets.js';

/** A named profile binding an agent host, env vars, and optional keychain auth. */
export interface Profile {
  name: string;
  host: {
    agent: AgentId;
    version?: string;
  };
  env: Record<string, string>;
  auth?: {
    envVar: string;
    keychainItem: string;
  };
  /**
   * When true, the host manages its own login and the keychain token named by
   * `auth` is optional: if it is not stored, no auth env var is injected and the
   * run proceeds on the host's own credentials (e.g. `opencode auth`). Without
   * this flag a missing keychain item is a hard error at exec time.
   */
  authOptional?: boolean;
  description?: string;
  preset?: string;
  provider?: string;
  /**
   * Optional secondary model retried on the same host when the primary model
   * env value hits a rate limit. Reuses the `--fallback` cascade in
   * `runWithFallback` (src/lib/exec.ts) — the swap is expressed as an
   * envOverride on a same-agent FallbackEntry, so only the model env var
   * changes; auth, base URL, and every other profile env value are preserved.
   */
  fallback_model?: string;
}

/**
 * Stable, machine-readable summary used by `agents view` and `--json`.
 * `agent` is the underlying harness (claude/codex/...) so consumers can
 * group profiles under installed agents without reparsing host strings.
 */
export interface ProfileSummary {
  name: string;
  agent: AgentId;
  host: string;
  provider: string;
  model: string;
  auth: string;
  path: string;
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;

/** Get the directory where profile YAML files are stored. */
export function getProfilesDir(): string {
  return path.join(getUserAgentsDir(), 'profiles');
}

function profilePath(name: string): string {
  return path.join(getProfilesDir(), `${name}.yml`);
}

/** Return the on-disk YAML path for a profile name. */
export function getProfilePath(name: string): string {
  validateProfileName(name);
  return profilePath(name);
}

/** Validate a profile name against the allowed pattern. Throws on invalid input. */
export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

/** Check whether a profile YAML file exists on disk. */
export function profileExists(name: string): boolean {
  return fs.existsSync(profilePath(name));
}

/** Read and parse a profile from disk. Throws if not found or malformed. */
export function readProfile(name: string): Profile {
  validateProfileName(name);
  const file = profilePath(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Profile '${name}' not found.`);
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = yaml.parse(raw) as Profile;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Profile '${name}' is malformed.`);
  }
  if (!parsed.name) parsed.name = name;
  if (!parsed.host?.agent) {
    throw new Error(`Profile '${name}' is missing host.agent.`);
  }
  if (!parsed.env || typeof parsed.env !== 'object') {
    parsed.env = {};
  }
  return parsed;
}

/** Write a profile to disk atomically (write-to-tmp then rename). */
export function writeProfile(profile: Profile): void {
  validateProfileName(profile.name);
  const dir = getProfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const body = yaml.stringify(profile);
  const file = profilePath(profile.name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

/** Delete a profile from disk. Returns false if it did not exist. */
export function deleteProfile(name: string): boolean {
  validateProfileName(name);
  const file = profilePath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** List all valid profiles, sorted by name. Malformed files are silently skipped. */
export function listProfiles(): Profile[] {
  const dir = getProfilesDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const profiles: Profile[] = [];
  for (const entry of entries) {
    const name = entry.replace(/\.(yml|yaml)$/, '');
    try {
      profiles.push(readProfile(name));
    } catch {
      // Skip malformed profile files; surfacing via `agents profiles view <name>`.
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

/** Format the host harness and optional pinned version for display. */
export function profileHostLabel(profile: Profile): string {
  return profile.host.version ? `${profile.host.agent}@${profile.host.version}` : profile.host.agent;
}

/** Return the configured provider name, deriving it from the shared keychain item when needed. */
export function profileProviderLabel(profile: Profile): string {
  return profile.provider || profile.auth?.keychainItem?.split('.')[1] || '-';
}

const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'OPENAI_MODEL',
  'GEMINI_MODEL',
  'GROK_MODEL',
] as const;

/** Return the configured model env value for display. */
export function profileModelLabel(profile: Profile): string {
  const key = profileModelEnvKey(profile);
  return key ? profile.env[key] : '-';
}

/**
 * Return the env var key that carries this profile's model (e.g.
 * `ANTHROPIC_MODEL`), or null when the profile has no recognizable model env.
 * `fallback_model` swaps THIS key so provider selection, auth, and base URL
 * are all preserved on retry.
 */
export function profileModelEnvKey(profile: Profile): string | null {
  for (const key of MODEL_ENV_KEYS) {
    if (profile.env[key]) return key;
  }
  for (const [key, value] of Object.entries(profile.env)) {
    if ((key === 'MODEL' || key.endsWith('_MODEL')) && value) return key;
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function maskToken(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 3)}...${token.slice(-2)}`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

const INLINE_AUTH_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
] as const;

function inlineAuthToken(profile: Profile): string | undefined {
  if (profile.auth?.envVar && profile.env[profile.auth.envVar]) {
    return profile.env[profile.auth.envVar];
  }
  for (const key of INLINE_AUTH_KEYS) {
    const value = profile.env[key];
    if (value) return value;
  }
  return undefined;
}

/**
 * Build a non-secret auth identity/status label for list surfaces.
 *
 * - Inline JWT in env: decode locally and show email / preferred_username / sub.
 * - Inline opaque token in env: masked prefix/suffix (user explicitly stored it
 *   in the YAML, so they accept the leak in their own output).
 * - Keychain-backed auth: provider + "stored" or "missing" (non-prompting).
 * - No auth at all: provider only.
 */
export function profileAuthLabel(profile: Profile): string {
  const provider = profileProviderLabel(profile);
  const token = inlineAuthToken(profile);
  if (token) {
    const payload = decodeJwtPayload(token);
    const identity =
      payload?.email ||
      payload?.preferred_username ||
      payload?.username ||
      payload?.sub;
    if (typeof identity === 'string') return `${provider} ${identity}`;
    return `${provider} ${maskToken(token)}`;
  }
  if (profile.auth) {
    return `${provider} ${hasKeychainToken(profile.auth.keychainItem) ? 'stored' : 'missing'}`;
  }
  return provider;
}

/** Build a stable, machine-readable summary for list and view surfaces. */
export function profileSummary(profile: Profile): ProfileSummary {
  return {
    name: profile.name,
    agent: profile.host.agent,
    host: profileHostLabel(profile),
    provider: profileProviderLabel(profile),
    model: profileModelLabel(profile),
    auth: profileAuthLabel(profile),
    path: getProfilePath(profile.name),
  };
}

/**
 * Build a profile from a preset. The keychain item is shared across all
 * profiles that point at the same provider, so adding kimi + deepseek prompts
 * for the OpenRouter key exactly once.
 */
export function profileFromPreset(profileName: string, preset: Preset, version?: string): Profile {
  return {
    name: profileName,
    host: { agent: preset.host, version },
    env: { ...preset.env },
    auth: {
      envVar: preset.authEnvVar,
      keychainItem: keychainItemName(preset.provider),
    },
    authOptional: preset.authOptional,
    description: preset.description,
    preset: preset.name,
    provider: preset.provider,
  };
}

/**
 * Env var each host CLI reads to override its model. Mirror of the read-side
 * `MODEL_ENV_KEYS` above, keyed by host so a one-shot `--host <agent> --model
 * <id>` writes the model onto the var that host actually honors.
 */
const MODEL_ENV_KEY_BY_HOST: Partial<Record<AgentId, string>> = {
  claude: 'ANTHROPIC_MODEL',
  opencode: 'OPENCODE_MODEL',
  grok: 'GROK_MODEL',
  gemini: 'GEMINI_MODEL',
  codex: 'OPENAI_MODEL',
};

/** Base-URL env var per host, for the OpenAI/Anthropic-compatible hosts where it applies. */
const BASE_URL_ENV_KEY_BY_HOST: Partial<Record<AgentId, string>> = {
  claude: 'ANTHROPIC_BASE_URL',
  codex: 'OPENAI_BASE_URL',
};

/** Return the model-override env var for a host (known hosts mapped; else `<HOST>_MODEL`). */
export function modelEnvKeyForHost(host: AgentId): string {
  return MODEL_ENV_KEY_BY_HOST[host] ?? `${host.toUpperCase()}_MODEL`;
}

/** Return the base-URL env var for a host, or null when the host has no known override var. */
export function baseUrlEnvKeyForHost(host: AgentId): string | null {
  return BASE_URL_ENV_KEY_BY_HOST[host] ?? null;
}

/** Env var each host reads its auth token from, for custom-endpoint (`--auth-provider`) harnesses. */
const AUTH_ENV_KEY_BY_HOST: Partial<Record<AgentId, string>> = {
  claude: 'ANTHROPIC_AUTH_TOKEN',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
};

/** Return the auth-token env var for a host, or null when unknown. */
export function authEnvKeyForHost(host: AgentId): string | null {
  return AUTH_ENV_KEY_BY_HOST[host] ?? null;
}

/** Options for {@link profileFromHostModel}. */
export interface HostModelOptions {
  version?: string;
  /** Base URL for OpenAI/Anthropic-compatible hosts (claude, codex). Ignored for hosts without a known var. */
  baseUrl?: string;
  /** Provider label + keychain namespace; only needed when the host requires a token. */
  provider?: string;
  /** Env var the host reads its auth token from; pair with `provider` to attach keychain auth. */
  authEnvVar?: string;
  description?: string;
}

/**
 * Build a custom-harness profile from a host CLI + model in one shot, without a
 * preset. The model lands on the host's model env var ({@link modelEnvKeyForHost});
 * auth is attached only when both `provider` and `authEnvVar` are supplied
 * (hosts that manage their own login — e.g. opencode — need neither).
 */
export function profileFromHostModel(name: string, host: AgentId, model: string, opts: HostModelOptions = {}): Profile {
  const env: Record<string, string> = { [modelEnvKeyForHost(host)]: model };
  if (opts.baseUrl) {
    const key = baseUrlEnvKeyForHost(host);
    if (key) env[key] = opts.baseUrl;
  }
  const profile: Profile = {
    name,
    host: { agent: host, version: opts.version },
    env,
    description: opts.description ?? `Custom harness: ${host} + ${model}`,
    provider: opts.provider ?? host,
  };
  if (opts.provider && opts.authEnvVar) {
    profile.auth = { envVar: opts.authEnvVar, keychainItem: keychainItemName(opts.provider) };
    profile.authOptional = false;
  }
  return profile;
}

/**
 * Resolve a profile into the env block that should be injected into the
 * spawned agent process. Reads the token from keychain at exec time so the
 * profile YAML never holds secrets.
 */
export function resolveProfileEnv(profile: Profile): Record<string, string> {
  const env: Record<string, string> = { ...profile.env };
  if (profile.auth) {
    // Optional auth (host manages its own login) with no stored token: inject
    // nothing and let the host use its own credentials. Only required auth
    // hard-fails on a missing keychain item.
    if (profile.authOptional && !hasKeychainToken(profile.auth.keychainItem)) {
      return env;
    }
    const token = getKeychainToken(profile.auth.keychainItem);
    env[profile.auth.envVar] = token;
  }
  return env;
}

/** Resolved profile data ready for spawning an agent process. */
export interface ResolvedProfileRun {
  agent: AgentId;
  version?: string;
  env: Record<string, string>;
  profileName: string;
  /**
   * Same-host model swap for the `--fallback` cascade. Present only when the
   * profile declares `fallback_model` AND the profile has an identifiable
   * model env key to swap. `envKey` names the var (e.g. `ANTHROPIC_MODEL`),
   * `model` is the value to write on the retry attempt.
   */
  fallbackModel?: { envKey: string; model: string };
}

/**
 * Resolve a name into (agent, version, env). Throws if the name is not a
 * profile. Callers are expected to try agent-id resolution first and fall
 * back to this when that fails, so we don't need a "isProfile" probe.
 */
export function resolveProfileForRun(name: string): ResolvedProfileRun {
  const profile = readProfile(name);
  const resolved: ResolvedProfileRun = {
    agent: profile.host.agent,
    version: profile.host.version,
    env: resolveProfileEnv(profile),
    profileName: profile.name,
  };
  if (profile.fallback_model) {
    const envKey = profileModelEnvKey(profile);
    if (envKey) {
      resolved.fallbackModel = { envKey, model: profile.fallback_model };
    }
  }
  return resolved;
}

/**
 * Look up the preset a profile was created from, if any. Used by
 * `profiles view` to show upstream metadata like signup URLs.
 */
export function getPresetForProfile(profile: Profile): Preset | undefined {
  return profile.preset ? getPreset(profile.preset) : undefined;
}
