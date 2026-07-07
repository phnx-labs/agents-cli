/**
 * Rush Cloud provider -- dispatches tasks to the Factory Floor via api.prix.dev.
 *
 * Auth: reads the session token from ~/.rush/user.yaml (written by `rush login`).
 * Requires the Rush GitHub App installed on the target repo.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import { getCloudDir } from '../state.js';
import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
  ProviderCapabilities,
  ImageAttachment,
  SkillRef,
} from './types.js';
import { resolveDispatchRepos, MAX_IMAGES_PER_DISPATCH } from './types.js';
import { parseSSE } from './stream.js';
import { listInstalledVersions, getVersionHomePath } from '../versions.js';
import { getAccountInfo } from '../agents.js';
import { loadClaudeOauth } from '../usage.js';
import { selectBalancedVersion } from '../rotate.js';

const PROXY_BASE = process.env.RUSH_PROXY_BASE ?? 'https://api.prix.dev';
const PROXY_HOST = new URL(PROXY_BASE).host;
const USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml');

// Persistent consent record for uploading Claude OAuth blobs to Rush Cloud.
// Created on first explicit consent (env var or flag); subsequent dispatches
// see it and proceed without re-prompting.
export const RUSH_CONSENT_PATH = path.join(getCloudDir(), 'rush-consent.json');
const RUSH_CONSENT_ENV = 'AGENTS_RUSH_UPLOAD_TOKENS';

interface RushConsentFile {
  granted_at: string;
  granted_by: 'env' | 'flag' | 'manual';
  host: string;
  account_fingerprint: string;
}

export function hasRushUploadConsent(accountFingerprint: string, opts?: DispatchOptions, consentPath = RUSH_CONSENT_PATH): boolean {
  if (process.env[RUSH_CONSENT_ENV] === '1') return true;
  const po = opts?.providerOptions as { uploadAccountTokens?: boolean } | undefined;
  if (po?.uploadAccountTokens === true) return true;
  try {
    if (!fs.existsSync(consentPath)) return false;
    const body = JSON.parse(fs.readFileSync(consentPath, 'utf-8')) as Partial<RushConsentFile>;
    return body.host === PROXY_HOST && body.account_fingerprint === accountFingerprint;
  } catch {
    return false;
  }
}

function recordRushUploadConsent(grantedBy: RushConsentFile['granted_by'], accountFingerprint: string): void {
  try {
    fs.mkdirSync(path.dirname(RUSH_CONSENT_PATH), { recursive: true });
    const body: RushConsentFile = {
      granted_at: new Date().toISOString(),
      granted_by: grantedBy,
      host: PROXY_HOST,
      account_fingerprint: accountFingerprint,
    };
    fs.writeFileSync(RUSH_CONSENT_PATH, JSON.stringify(body, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal: consent persistence is a UX optimization, not a security
    // boundary. Worst case, the user is asked to consent again next dispatch.
  }
}

interface UserYaml {
  session?: {
    email?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
  };
}

interface Installation {
  id: number;
  account_login: string;
  repositories?: { name: string; full_name: string }[];
  repository_selection?: string;
}

/** Map a Factory Floor status string to the canonical CloudTaskStatus enum. */
function mapStatus(s: string): CloudTaskStatus {
  switch (s) {
    case 'allocating': return 'allocating';
    case 'running': return 'running';
    case 'needs_review': return 'input_required';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'running';
  }
}

/** Read the Rush session access token from ~/.rush/user.yaml. */
function readToken(): string {
  if (!fs.existsSync(USER_YAML)) {
    throw new Error('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(USER_YAML, 'utf-8');
  const data = yaml.parse(raw) as UserYaml;
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  return token;
}

/** Read the user's email from the Rush session config, if available. */
function readEmail(): string | undefined {
  try {
    const raw = fs.readFileSync(USER_YAML, 'utf-8');
    const data = yaml.parse(raw) as UserYaml;
    return data?.session?.email;
  } catch {
    return undefined;
  }
}

/** Make an authenticated request to the Rush API proxy. */
async function api(method: string, endpoint: string, token: string, body?: unknown): Promise<Response> {
  const url = endpoint.startsWith('http') ? endpoint : `${PROXY_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Find the GitHub App installation ID for a given owner/repo pair. */
async function findInstallation(token: string, owner: string, repo: string): Promise<number> {
  const res = await api('GET', '/api/v1/github/app/installations', token);
  if (!res.ok) {
    throw new Error(`Failed to fetch GitHub installations (${res.status}). Is the Rush GitHub App installed?`);
  }
  const data = await res.json() as { installations: Installation[] };

  for (const inst of data.installations ?? []) {
    if (inst.account_login?.toLowerCase() === owner.toLowerCase()) {
      if (inst.repository_selection === 'all') return inst.id;
      if (inst.repositories?.some(r => r.name.toLowerCase() === repo.toLowerCase())) {
        return inst.id;
      }
    }
  }

  throw new Error(
    `No GitHub App installation found for ${owner}/${repo}. Install the Rush GitHub App at https://github.com/apps/cloud-bot.`,
  );
}

/** One version's entry in the account manifest sent on every dispatch. */
export interface AccountManifestEntry {
  version: string;
  email: string;
  cred_fp: string;
}

/**
 * Manifest of the user's local Claude accounts. Sent on every dispatch so the
 * server can detect "new account" or "token rotated" drift and ask the client
 * to upload the underlying credentials. The manifest itself contains no
 * secrets — only public-ish identifiers + a hash of each token.
 */
export interface AccountManifest {
  fp: string;
  versions: AccountManifestEntry[];
}

/** Token blob uploaded on retry when the server detects drift. */
export interface AccountTokenEntry {
  version: string;
  /** Stringified OAuth credentials JSON (Mac: keychain blob; Linux: .credentials.json). */
  credentials_json: string;
}

/** sha256 → hex. */
function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Strip tokens/credentials from a server error body before surfacing it.
 * If the body is JSON with a `message` or `error` field, prefer that.
 * Otherwise truncate and redact anything that looks like a bearer token or JWT.
 */
function sanitizeErrorBody(body: string): string {
  const MAX_LEN = 300;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const msg = (parsed.message ?? parsed.error ?? parsed.detail) as string | undefined;
    if (typeof msg === 'string') return msg.slice(0, MAX_LEN);
  } catch { /* not JSON, fall through */ }
  let safe = body.slice(0, MAX_LEN);
  safe = safe.replace(/eyJ[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]');
  safe = safe.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  safe = safe.replace(/"(access_token|refresh_token|credentials_json)"\s*:\s*"[^"]*"/g, '"$1":"[REDACTED]"');
  if (body.length > MAX_LEN) safe += '...';
  return safe;
}

/**
 * Pull `prompt_code` out of a JSON-encoded error body. Returns null when the
 * body isn't JSON or doesn't carry one — caller falls through to the generic
 * dispatch-failed path.
 */
function parsePromptCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { prompt_code?: unknown };
    return typeof parsed.prompt_code === 'string' ? parsed.prompt_code : null;
  } catch {
    return null;
  }
}

/**
 * Read the raw OAuth credentials for one Claude version. On Mac, prefer the
 * Keychain blob (canonical). On Linux/CI, fall back to `.claude/.credentials.json`
 * inside the version home (where the Linux Claude CLI stores its OAuth).
 *
 * Returns null when no credentials are findable — caller treats as "version
 * is installed but not signed in" and skips it from the manifest.
 */
async function readClaudeCredentialsBlob(home: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const oauth = await loadClaudeOauth(home);
    if (oauth && oauth.accessToken) {
      return JSON.stringify(oauth);
    }
  }
  const credsPath = path.join(home, '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credsPath)) {
      const raw = fs.readFileSync(credsPath, 'utf-8').trim();
      if (raw) return raw;
    }
  } catch {
    // fall through to null
  }
  return null;
}

/**
 * Build a manifest of the user's local Claude installations to send on every
 * cloud dispatch. The manifest is the contract the server uses to detect when
 * the user has added a new account or rotated a token.
 *
 * Returns null when no Claude versions are signed in (the dispatch falls back
 * to the platform-wide key, current behavior).
 */
export async function buildAccountManifest(strategy?: string): Promise<AccountManifest | null> {
  let candidateVersions: Array<{ version: string; email: string }>;

  if (strategy === 'balanced') {
    // Use the same health-checked, deduped-by-email set that `agents run --balanced` uses.
    // `result.healthy` contains one candidate per unique email, ordered by remaining capacity.
    const result = await selectBalancedVersion('claude');
    if (!result || result.healthy.length === 0) return null;
    candidateVersions = result.healthy
      .filter((c) => !!c.email)
      .map((c) => ({ version: c.version, email: c.email! }));
  } else {
    // Default: all installed versions that have a signed-in account.
    const versions = listInstalledVersions('claude');
    if (versions.length === 0) return null;
    const rows = await Promise.all(
      versions.map(async (version) => {
        const home = getVersionHomePath('claude', version);
        const info = await getAccountInfo('claude', home);
        return info.email ? { version, email: info.email } : null;
      }),
    );
    candidateVersions = rows.filter((r): r is { version: string; email: string } => r !== null);
  }

  const entries: AccountManifestEntry[] = [];
  for (const { version, email } of candidateVersions) {
    const home = getVersionHomePath('claude', version);
    const blob = await readClaudeCredentialsBlob(home);
    if (!blob) continue;
    entries.push({ version, email, cred_fp: sha256(blob) });
  }

  if (entries.length === 0) return null;
  entries.sort((a, b) => a.version.localeCompare(b.version));
  const fp = sha256(JSON.stringify(entries));
  return { fp, versions: entries };
}

/**
 * Re-load OAuth blobs for the given versions so they can be uploaded to the
 * server on a retry. Only the versions named in the manifest are loaded — we
 * never upload tokens for versions the server hasn't asked about.
 */
export async function buildAccountTokensPayload(
  versions: string[],
): Promise<AccountTokenEntry[]> {
  const out: AccountTokenEntry[] = [];
  for (const version of versions) {
    const home = getVersionHomePath('claude', version);
    const blob = await readClaudeCredentialsBlob(home);
    if (!blob) continue;
    out.push({ version, credentials_json: blob });
  }
  return out;
}

export function accountTokensFingerprint(tokens: AccountTokenEntry[]): string {
  const canonical = [...tokens].sort((a, b) => a.version.localeCompare(b.version));
  return sha256(JSON.stringify(canonical));
}

/**
 * Build the POST body for /api/v1/cloud-runs. Exported so tests can verify
 * the back-compat shape (singular fields + repos[]) without needing real
 * GitHub installations or a live Rush session. `findInstallation` is the
 * only other I/O and it's tested by the halo/proxy integration suite.
 */
export function buildDispatchBody(input: {
  agent?: string;
  prompt: string;
  mode?: string;
  strategy?: string;
  resolvedRepos: Array<{ installation_id: number; repo_owner: string; repo_name: string }>;
  accountManifest?: AccountManifest | null;
  accountTokens?: AccountTokenEntry[] | null;
  /**
   * Skill ride-alongs so the cloud pod isn't context-blind. Forwarded verbatim
   * as `skills` so the Factory Floor can mount them by id/version before the
   * agent runs. Omitted when empty.
   */
  skills?: SkillRef[] | null;
  /**
   * Base64 image attachments for vision dispatch. Sliced to
   * MAX_IMAGES_PER_DISPATCH — extras are dropped, never sent. Omitted when empty.
   */
  images?: ImageAttachment[] | null;
}): Record<string, unknown> {
  if (input.resolvedRepos.length === 0) {
    throw new Error('buildDispatchBody: resolvedRepos must have at least one entry');
  }
  const primary = input.resolvedRepos[0];
  const body: Record<string, unknown> = {
    agent: input.agent ?? 'claude',
    prompt: input.prompt,
    repos: input.resolvedRepos,
    mode: input.mode,
    ...(input.strategy ? { strategy: input.strategy } : {}),
  };
  if (input.resolvedRepos.length === 1) {
    body.installation_id = primary.installation_id;
    body.repo_owner = primary.repo_owner;
    body.repo_name = primary.repo_name;
  }
  if (input.accountManifest) {
    body.account_manifest = input.accountManifest;
  }
  if (input.accountTokens && input.accountTokens.length > 0) {
    body.account_tokens = input.accountTokens;
  }
  if (input.skills && input.skills.length > 0) {
    body.skills = input.skills;
  }
  if (input.images && input.images.length > 0) {
    body.images = input.images.slice(0, MAX_IMAGES_PER_DISPATCH);
  }
  return body;
}

/** A single account registered in Rush Cloud's multi-account rotation pool. */
export interface RemoteAccount {
  id: string;
  provider: string;
  email: string | null;
  subscription_type: string | null;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  usage_fetched_at: string | null;
  created_at: string;
}

/** Fetch all Claude accounts in this user's Rush Cloud rotation pool (no tokens). */
export async function listRemoteAccounts(): Promise<RemoteAccount[]> {
  const token = readToken();
  const res = await api('GET', '/api/v1/cloud-accounts', token);
  if (!res.ok) {
    throw new Error(`Failed to list accounts (${res.status}): ${sanitizeErrorBody(await res.text())}`);
  }
  const data = await res.json() as { accounts: RemoteAccount[] };
  return data.accounts ?? [];
}

/**
 * Register a CLAUDE_CODE_OAUTH_TOKEN with Rush Cloud's rotation pool.
 * The server validates the token against the Anthropic usage API and stores it
 * encrypted in Vault. Returns the account metadata (no token).
 */
export async function addRemoteAccount(provider: string, pastedToken: string): Promise<RemoteAccount & { five_hour_pct: number | null; seven_day_pct: number | null }> {
  const token = readToken();
  const res = await api('POST', '/api/v1/cloud-accounts', token, { provider, token: pastedToken });
  if (!res.ok) {
    throw new Error(`Failed to add account (${res.status}): ${sanitizeErrorBody(await res.text())}`);
  }
  return await res.json() as RemoteAccount & { five_hour_pct: number | null; seven_day_pct: number | null };
}

/** Remove a Claude account from Rush Cloud's rotation pool by its ID. */
export async function removeRemoteAccount(id: string): Promise<void> {
  const token = readToken();
  const res = await api('DELETE', `/api/v1/cloud-accounts/${encodeURIComponent(id)}`, token);
  if (!res.ok) {
    throw new Error(`Failed to remove account (${res.status}): ${sanitizeErrorBody(await res.text())}`);
  }
}

export class RushCloudProvider implements CloudProvider {
  id = 'rush' as const;
  name = 'Rush Cloud';

  capabilities(): ProviderCapabilities {
    return {
      available: fs.existsSync(USER_YAML),
      dispatch: true,
      status: true,
      list: true,
      stream: true,
      cancel: true,
      message: true,
      multiRepo: true,
      skills: true,
      images: true,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const repos = resolveDispatchRepos(options);
    if (repos.length === 0) {
      throw new Error('Rush Cloud requires --repo <owner/repo> (or --repo repeated for multi-repo).');
    }

    // Budget pre-flight gate (issue #346). Cloud dispatches inherit the local
    // project's caps; we refuse to POST a run that would breach an on_exceed:block
    // cap. The repo slug is the project attribution key. Server-side spend is
    // authoritative for live enforcement; this pre-flight is the deterministic
    // "don't even start it" guard. Dormant when no caps are configured.
    {
      const { runPreflightGate } = await import('../budget/preflight.js');
      const projectKey = repos[0] ?? process.cwd();
      const gate = runPreflightGate({
        agent: options.agent ?? 'cloud',
        model: options.model ?? `${options.agent ?? 'cloud'}-default`,
        prompt: options.prompt,
        project: projectKey,
      });
      if (!gate.dormant && !gate.decision.allow) {
        throw new Error(`[budget] BLOCKED cloud dispatch (${projectKey}): ${gate.decision.reason}`);
      }
    }

    // Validate each repo's shape and resolve its installation_id up front.
    // Any bad entry fails the whole dispatch — we never want a half-started
    // multi-repo run that only found installations for some of the repos.
    const token = readToken();
    const parsed = repos.map((full) => {
      const parts = full.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format: ${JSON.stringify(full)}. Use owner/repo.`);
      }
      return { full, owner: parts[0], name: parts[1] };
    });

    const resolvedRepos = await Promise.all(
      parsed.map(async (r) => ({
        installation_id: await findInstallation(token, r.owner, r.name),
        repo_owner: r.owner,
        repo_name: r.name,
      })),
    );

    const strategy = (options.providerOptions as { strategy?: string } | undefined)?.strategy;
    // When balanced, the server owns the pool and rotates internally — no
    // client-side manifest needed. We just forward the strategy so the server
    // knows to load from Vault instead of waiting for a manifest.
    const accountManifest = strategy === 'balanced' ? null : await buildAccountManifest();

    const body = buildDispatchBody({
      agent: options.agent,
      prompt: options.prompt,
      mode: options.providerOptions?.mode as string | undefined,
      resolvedRepos,
      accountManifest,
      strategy,
      skills: options.skills,
      images: options.images,
    });

    let res = await api('POST', '/api/v1/cloud-runs', token, body);

    // Server detects drift (new account or rotated token) by comparing the
    // manifest's fp against what's stored. It returns 401 with a prompt_code
    // telling the client to re-upload the actual token blobs and retry once.
    if (res.status === 401 && accountManifest) {
      const errBody = await res.clone().text();
      const promptCode = parsePromptCode(errBody);
      if (promptCode === 'NEW_ACCOUNT' || promptCode === 'TOKEN_ROTATED') {
        const accountTokens = await buildAccountTokensPayload(
          accountManifest.versions.map((v) => v.version),
        );
        const accountFingerprint = accountTokensFingerprint(accountTokens);

        // Refuse to silently exfiltrate Claude OAuth credentials. The retry
        // path below reads accessToken+refreshToken from every installed
        // Claude version and POSTs them to api.prix.dev. That's an explicit
        // data-flow decision the user has to opt into.
        if (!hasRushUploadConsent(accountFingerprint, options)) {
          throw new Error(
            [
              `Rush Cloud asked to sync your Claude credentials (reason: ${promptCode.toLowerCase()}).`,
              `This would upload accessToken + refreshToken from every installed Claude version`,
              `to ${PROXY_BASE} so Factory Floor pods can act as your Anthropic account.`,
              ``,
              `To consent, re-run with one of:`,
              `  AGENTS_RUSH_UPLOAD_TOKENS=1 agents cloud run ...`,
              `  agents cloud run --upload-account-tokens ...`,
              ``,
              `Consent will be recorded at ${RUSH_CONSENT_PATH} so you won't be asked again.`,
              `Remove that file to revoke.`,
            ].join('\n'),
          );
        }

        // Always-on stderr notice (no isTTY gate). Scripts and CI need to see
        // this in their captured stderr / logs.
        const grantedBy: RushConsentFile['granted_by'] =
          process.env[RUSH_CONSENT_ENV] === '1' ? 'env'
            : (options.providerOptions as { uploadAccountTokens?: boolean } | undefined)?.uploadAccountTokens === true ? 'flag'
              : 'manual';
        process.stderr.write(`[rush] uploading ${accountTokens.length} account token(s) to ${PROXY_HOST}\n`);
        const retryBody = buildDispatchBody({
          agent: options.agent,
          prompt: options.prompt,
          mode: options.providerOptions?.mode as string | undefined,
          resolvedRepos,
          accountManifest,
          accountTokens,
          skills: options.skills,
          images: options.images,
        });
        res = await api('POST', '/api/v1/cloud-runs', token, retryBody);

        // Persist consent on first successful upload so we don't re-prompt
        // every time tokens rotate.
        if (res.ok && grantedBy !== 'manual') {
          recordRushUploadConsent(grantedBy, accountFingerprint);
        }
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dispatch failed (${res.status}): ${sanitizeErrorBody(text)}`);
    }

    const data = await res.json() as { execution_id: string };
    const now = new Date().toISOString();

    return {
      id: data.execution_id,
      provider: 'rush',
      status: 'queued',
      agent: options.agent ?? 'claude',
      prompt: options.prompt,
      repo: repos[0],
      repos: repos,
      branch: options.branch,
      createdAt: now,
      updatedAt: now,
    };
  }

  async status(taskId: string): Promise<CloudTask> {
    const token = readToken();
    const res = await api('GET', `/api/v1/cloud-runs/${encodeURIComponent(taskId)}`, token);
    if (!res.ok) {
      throw new Error(`Failed to get task status (${res.status}).`);
    }
    const data = await res.json() as Record<string, unknown>;
    return {
      id: taskId,
      provider: 'rush',
      status: mapStatus(data.status as string),
      agent: (data.agent as string) || undefined,
      prompt: (data.prompt as string) || '',
      repo: data.repo_owner && data.repo_name ? `${data.repo_owner}/${data.repo_name}` : undefined,
      branch: (data.branch as string) || undefined,
      prUrl: (data.pr_url as string) || undefined,
      summary: (data.summary as string) || undefined,
      createdAt: (data.created_at as string) || new Date().toISOString(),
      updatedAt: (data.updated_at as string) || new Date().toISOString(),
    };
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const token = readToken();
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await api('GET', `/api/v1/cloud-runs${qs}`, token);
    if (!res.ok) {
      throw new Error(`Failed to list tasks (${res.status}).`);
    }
    const data = await res.json() as { executions: Record<string, unknown>[] };
    return (data.executions ?? []).map((e) => ({
      id: e.execution_id as string,
      provider: 'rush' as const,
      status: mapStatus(e.status as string),
      agent: (e.agent as string) || undefined,
      prompt: (e.prompt as string) || '',
      repo: e.repo_owner && e.repo_name ? `${e.repo_owner}/${e.repo_name}` : undefined,
      branch: (e.branch as string) || undefined,
      prUrl: (e.pr_url as string) || undefined,
      summary: (e.summary as string) || undefined,
      createdAt: (e.created_at as string) || '',
      updatedAt: (e.updated_at as string) || '',
    }));
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const token = readToken();
    const res = await fetch(`${PROXY_BASE}/api/v1/cloud-runs/${encodeURIComponent(taskId)}/stream`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to connect to stream (${res.status}).`);
    }
    yield* parseSSE(res);
  }

  async cancel(taskId: string): Promise<void> {
    const token = readToken();
    const res = await api('DELETE', `/api/v1/cloud-runs/${encodeURIComponent(taskId)}`, token);
    if (!res.ok) {
      throw new Error(`Failed to cancel task (${res.status}).`);
    }
  }

  async message(taskId: string, content: string): Promise<void> {
    const token = readToken();
    const res = await api('POST', `/api/v1/cloud-runs/${encodeURIComponent(taskId)}/message`, token, { content });
    if (!res.ok) {
      throw new Error(`Failed to send message (${res.status}).`);
    }
  }
}
