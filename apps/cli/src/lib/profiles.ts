/**
 * Profile management -- named bundles of (host CLI, endpoint, model, auth).
 *
 * Profiles let users run agents against alternative providers (OpenRouter,
 * custom endpoints) without reconfiguring the agent CLI itself. Stored as
 * YAML files under ~/.agents/profiles/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import type { AgentId } from './types.js';
import { getUserAgentsDir } from './state.js';
import { deleteKeychainToken, getKeychainToken, hasKeychainToken, keychainItemName } from './secrets/profiles.js';
import { getPreset, type Preset } from './profiles-presets.js';
import { MODEL_TIERS, isTierToken, type ModelTier } from './model-tiers.js';
import { addAccount, findAccount, resolveCredentialAccount } from './account-registry.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { listAccountProviders } from './account-provider-registry.js';

/** A named profile binding an agent host, env vars, and optional keychain auth. */
export interface Profile {
  name: string;
  host: {
    agent: AgentId;
    version?: string;
  };
  env: Record<string, string>;
  /** Default durable credential account. A per-run --account overrides it. */
  account?: string;
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
   * Stored for backward-compatible YAML parsing only — no longer read for
   * display. `profileLabel()` always derives the display name from `name` via
   * the vendor/brand table. Old YAML files that carry this key still parse
   * correctly; it is simply ignored.
   */
  label?: string;
  /**
   * Name of the harness this one was forked from — either a native agent id
   * (`claude`, `opencode`) or another custom harness. Display-only lineage:
   * the fork is a full copy, so deleting the source never affects it.
   */
  forkedFrom?: string;
  /**
   * Optional secondary model retried on the same host when the primary model
   * env value hits a rate limit. Reuses the `--fallback` cascade in
   * `runWithFallback` (src/lib/exec.ts) — the swap is expressed as an
   * envOverride on a same-agent FallbackEntry, so only the model env var
   * changes; auth, base URL, and every other profile env value are preserved.
   */
  fallback_model?: string;
  /**
   * Per-tier model ids for this harness's OWN catalog, keyed by the same cost
   * tiers `agents run --model cheap|default|best|ultra` uses for a native
   * agent. Lets a custom harness (which runs through a host agent's binary,
   * e.g. `deepseek-flash` hosted on `claude`) resolve a tier against its own
   * models instead of colliding with the host agent's native catalog
   * (`resolveTier` in model-tiers.ts, which only knows native agents).
   * An unset tier clamps to the next CHEAPER tier that IS set (see
   * `resolveProfileTierModel`). Omitted entirely -> tiers are not supported
   * for this profile and a requested tier falls back to the harness's single
   * pinned model, unchanged from before this field existed.
   */
  models?: Partial<Record<ModelTier, string>>;
}

/**
 * Stable, machine-readable summary used by `agents view` and `--json`.
 * `agent` is the underlying harness (claude/codex/...) so consumers can
 * group profiles under installed agents without reparsing host strings.
 */
export interface ProfileSummary {
  name: string;
  /** Human-facing header label — always derived from `name` via the vendor/brand table. */
  label: string;
  agent: AgentId;
  host: string;
  /** Host version pin, or null when the harness follows the host's default. */
  hostVersion: string | null;
  provider: string;
  model: string;
  auth: string;
  path: string;
  description: string | null;
  /** Native agent id or custom harness this one was forked from, if recorded. */
  forkedFrom: string | null;
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
  migrateLegacyProfileAuth(parsed, file);
  return parsed;
}

function migrateLegacyProfileAuth(profile: Profile, file: string): void {
  if (!profile.auth || profile.account) return;
  if (!profile.provider) {
    throw new Error(`Profile '${profile.name}' owns a legacy credential without a provider. Add a durable account with 'agents accounts add', then set account: <name> in ${file}.`);
  }
  const provider = listAccountProviders().includes(profile.provider) ? profile.provider : 'proxy';
  const suffix = crypto.createHash('sha256').update(profile.auth.keychainItem).digest('hex').slice(0, 8);
  const accountName = `legacy-${profile.provider}-${suffix}`;
  if (!findAccount(accountName)) {
    const kind = profile.auth.envVar.includes('BEARER_TOKEN') ? 'bearer-token' : 'api-key';
    addAccount(accountName, provider, kind, getKeychainToken(profile.auth.keychainItem));
  }
  const migratedAccount = findAccount(accountName)!;
  const oldItem = profile.auth.keychainItem;
  profile.account = migratedAccount.id;
  delete profile.auth;
  delete profile.authOptional;
  atomicWriteFileSync(file, yaml.stringify(profile));

  const stillReferenced = fs.readdirSync(path.dirname(file))
    .filter(entry => /\.ya?ml$/.test(entry) && path.join(path.dirname(file), entry) !== file)
    .some(entry => {
      try {
        const other = yaml.parse(fs.readFileSync(path.join(path.dirname(file), entry), 'utf8')) as Profile | null;
        return other?.auth?.keychainItem === oldItem;
      } catch { return false; }
    });
  if (!stillReferenced) deleteKeychainToken(oldItem);
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

/**
 * Curated vendor/brand display names, matched case-insensitively per token.
 * Entries with a space (e.g. 'Moonshot AI') are single-token → multi-word expansions.
 */
const VENDOR_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['deepseek', 'DeepSeek'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['claude', 'Claude'],
  ['grok', 'Grok'],
  ['xai', 'xAI'],
  ['gpt', 'GPT'],
  ['meta', 'Meta'],
  ['mistral', 'Mistral'],
  ['mistralai', 'Mistral'],
  ['qwen', 'Qwen'],
  ['gemini', 'Gemini'],
  ['moonshot', 'Moonshot AI'],
  ['moonshotai', 'Moonshot AI'],
  ['kimi', 'Kimi'],
  ['cohere', 'Cohere'],
  ['perplexity', 'Perplexity'],
];

function tokenToDisplayName(token: string): string {
  const lower = token.toLowerCase();
  for (const [key, display] of VENDOR_TABLE) {
    if (lower === key) return display;
  }
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Header label for the harness — derived from `profile.name` by splitting on
 * `[-_]` and mapping each token through the vendor/brand table. Never reads
 * the stored `label` field; old YAML files with a `label:` key are unaffected.
 *
 * Examples: `deepseek-flash` → `'DeepSeek Flash'`, `spark` → `'Spark'`,
 * `deepseek_chat_v3` → `'DeepSeek Chat V3'`.
 */
export function profileLabel(profile: Profile): string {
  return profile.name.split(/[-_]/).map(tokenToDisplayName).join(' ');
}

/** Build a stable, machine-readable summary for list and view surfaces. */
export function profileSummary(profile: Profile): ProfileSummary {
  return {
    name: profile.name,
    label: profileLabel(profile),
    agent: profile.host.agent,
    host: profileHostLabel(profile),
    hostVersion: profile.host.version ?? null,
    provider: profileProviderLabel(profile),
    model: profileModelLabel(profile),
    auth: profileAuthLabel(profile),
    path: getProfilePath(profile.name),
    description: profile.description ?? null,
    forkedFrom: profile.forkedFrom ?? null,
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
    forkedFrom: preset.host,
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
    forkedFrom: host,
  };
  if (opts.provider && opts.authEnvVar) {
    profile.auth = { envVar: opts.authEnvVar, keychainItem: keychainItemName(opts.provider) };
    profile.authOptional = false;
  }
  return profile;
}

/** Overrides applied on top of the source when forking a harness. */
export interface ForkProfileOptions {
  /** Swap the pinned model. Written onto the source's model env key when it has
   *  one, else onto the host's canonical model var. */
  model?: string;
  /** Swap the endpoint. Only applied for hosts with a known base-URL var. */
  baseUrl?: string;
  /** Repoint auth at a different provider's keychain item. */
  provider?: string;
  /** Env var the host reads its token from; pair with `provider`. */
  authEnvVar?: string;
  /** Re-pin (or unpin, with an empty string) the host CLI version. */
  version?: string;
  description?: string;
}

/**
 * Copy an existing harness under a new name, applying overrides. The fork is a
 * full copy — env, auth binding, and fallback model all carry over — so the two
 * diverge from here and deleting the source never affects the fork.
 */
export function forkProfile(source: Profile, name: string, opts: ForkProfileOptions = {}): Profile {
  validateProfileName(name);
  const host = source.host.agent;
  const env = { ...source.env };
  if (opts.model) {
    env[profileModelEnvKey(source) ?? modelEnvKeyForHost(host)] = opts.model;
  }
  if (opts.baseUrl) {
    const key = baseUrlEnvKeyForHost(host);
    if (!key) {
      throw new Error(`Host '${host}' has no known base-URL env var; drop --base-url or fork onto a claude/codex host.`);
    }
    env[key] = opts.baseUrl;
  }
  const forked: Profile = {
    ...source,
    name,
    host: { agent: host, ...(opts.version ? { version: opts.version } : source.host.version ? { version: source.host.version } : {}) },
    env,
    // The source's description names the source's model, so inheriting it
    // across a model swap would describe the fork wrongly.
    description: opts.description ?? (opts.model ? `Forked from ${source.name}: ${opts.model}` : source.description),
    forkedFrom: source.name,
  };
  // A fork that repoints the model or endpoint is no longer that preset — keep
  // the preset link only while the fork still matches what the preset defines.
  if (opts.model || opts.baseUrl) delete forked.preset;
  if (opts.provider) {
    const envVar = opts.authEnvVar ?? source.auth?.envVar ?? authEnvKeyForHost(host);
    if (!envVar) {
      throw new Error(`Host '${host}' has no known auth env var; --provider cannot be attached to this fork.`);
    }
    forked.provider = opts.provider;
    forked.auth = { envVar, keychainItem: keychainItemName(opts.provider) };
    forked.authOptional = source.authOptional ?? false;
  }
  return forked;
}

/**
 * Edit an existing profile in-place, applying overrides without changing its
 * name or lineage. Reuses {@link forkProfile}'s validation and override logic
 * (model swap, base-URL validation, auth repoint), then restores the original
 * `forkedFrom` so an edit never self-references the profile.
 *
 * Note: this returns the updated `Profile` object but does NOT write it to
 * disk — callers should follow up with `writeProfile(result)` if persistence
 * is needed.
 */
export function editProfile(source: Profile, opts: ForkProfileOptions = {}): Profile {
  const edited = forkProfile(source, source.name, opts);
  // forkProfile sets forkedFrom = source.name; for an in-place edit that would
  // be a self-reference. Restore the original lineage instead.
  edited.forkedFrom = source.forkedFrom;
  return edited;
}

/**
 * Rename a profile on disk, then rewrite `forkedFrom` in every other profile
 * that pointed at the old name so lineage display never goes stale.
 *
 * Throws if `oldName` does not exist or `newName` already exists. There is no
 * `--force` / overwrite path — a collision is a hard error directing the user
 * to remove the target first.
 */
export function renameProfile(oldName: string, newName: string): void {
  validateProfileName(newName);
  if (!profileExists(oldName)) {
    throw new Error(`Profile '${oldName}' not found.`);
  }
  if (profileExists(newName)) {
    throw new Error(`Profile '${newName}' already exists; remove it first.`);
  }
  const profile = readProfile(oldName);
  profile.name = newName;
  writeProfile(profile);
  deleteProfile(oldName);
  // Rewrite forkedFrom in every other profile that referenced the old name.
  for (const other of listProfiles()) {
    if (other.name !== newName && other.forkedFrom === oldName) {
      other.forkedFrom = newName;
      writeProfile(other);
    }
  }
}

/**
 * Resolve a profile into the env block that should be injected into the
 * spawned agent process. Reads the token from keychain at exec time so the
 * profile YAML never holds secrets.
 */
export function resolveProfileEnv(profile: Profile): Record<string, string> {
  const env: Record<string, string> = { ...profile.env };
  if (profile.account) {
    const account = resolveCredentialAccount(profile.account, profile.host.agent, profile.provider);
    Object.assign(env, account.env);
  }
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
  /**
   * Set when the caller requested a cost tier (`--model cheap|default|...`)
   * but this profile has no `models:` entry to resolve it against (not even a
   * cheaper tier to clamp to). `env` is returned unmodified — the harness's
   * single pinned model — and this note is informational only, matching the
   * "using harness default" convention exec.ts's native tier block already
   * uses; the caller prints it, it never throws.
   */
  tierNote?: string;
  /**
   * Set when `requestedModel` was a tier token AND this profile resolved it
   * against its own `models:` map. Callers that forward a `--model` value
   * downstream (e.g. as `ExecOptions.model`) should substitute this in place
   * of the original tier token — exec.ts's native tier block only knows how
   * to resolve a tier against the HOST agent's own catalog, which is the
   * wrong catalog for a profile's own harness identity. Undefined both when
   * no tier was requested and when tier resolution degraded (see `tierNote`).
   */
  resolvedModel?: string;
}

/**
 * Resolve a requested cost tier against a profile's `models:` map. An unset
 * tier clamps to the next CHEAPER tier that IS set (ultra -> best -> default
 * -> cheap), mirroring the clamp semantics of `bucketRungs` in
 * model-tiers.ts. Returns null when the profile declares no `models:` at all,
 * or none of the tiers at-or-below the request are set.
 */
function resolveProfileTierModel(
  profile: Profile,
  tier: ModelTier,
): { model: string; clampedFrom?: ModelTier } | null {
  if (!profile.models) return null;
  const idx = MODEL_TIERS.indexOf(tier);
  for (let i = idx; i >= 0; i--) {
    const rung = MODEL_TIERS[i];
    const model = profile.models[rung];
    if (model) return { model, clampedFrom: rung === tier ? undefined : rung };
  }
  return null;
}

/**
 * Resolve a name into (agent, version, env). Throws if the name is not a
 * profile. Callers are expected to try agent-id resolution first and fall
 * back to this when that fails, so we don't need a "isProfile" probe.
 *
 * `requestedModel` is the caller's raw `--model` value. When it is a cost-tier
 * token (`cheap`/`default`/`best`/`ultra`), it is resolved against the
 * profile's OWN `models:` map (see `resolveProfileTierModel`) and substituted
 * into `env` as a concrete model id BEFORE returning — so exec.ts's native
 * tier-resolution block (which indexes the HOST agent's catalog, e.g. Claude's
 * own models) never sees a tier token for a profile-based run, and can't
 * collide the profile's harness identity with its host's catalog.
 */
export function resolveProfileForRun(name: string, requestedModel?: string): ResolvedProfileRun {
  const profile = readProfile(name);
  const env = resolveProfileEnv(profile);
  const resolved: ResolvedProfileRun = {
    agent: profile.host.agent,
    version: profile.host.version,
    env,
    profileName: profile.name,
  };
  if (profile.fallback_model) {
    const envKey = profileModelEnvKey(profile);
    if (envKey) {
      resolved.fallbackModel = { envKey, model: profile.fallback_model };
    }
  }
  if (isTierToken(requestedModel)) {
    const tierPick = resolveProfileTierModel(profile, requestedModel);
    if (tierPick) {
      const envKey = profileModelEnvKey(profile) ?? modelEnvKeyForHost(profile.host.agent);
      env[envKey] = tierPick.model;
      resolved.resolvedModel = tierPick.model;
      // Mirror the native-harness tier block (lib/exec.ts's resolveTier callers):
      // a clamp is always announced, never silent, so a user asking for "ultra"
      // on a harness that only configures "best" knows what it actually got.
      if (tierPick.clampedFrom) {
        resolved.tierNote = `no "${requestedModel}" model configured on profile '${profile.name}'; using its "${tierPick.clampedFrom}" tier (${tierPick.model})`;
      }
    }
    // No `models:` opt-in at all, or no rung to clamp to: leave `env` and
    // `requestedModel` untouched. `agents commands/exec.ts`'s own profile-tier
    // guard (the "cost tiers don't apply to profile ..." discard) still sees
    // the raw tier token downstream and handles the message -- this function
    // doesn't compete with that canonical fallback for the no-opt-in case.
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
