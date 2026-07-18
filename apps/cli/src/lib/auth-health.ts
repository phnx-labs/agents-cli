/**
 * Live auth-health: does an agent account's stored credential actually complete
 * an authenticated request right now?
 *
 * The rest of the CLI reports "signed in" from a local heuristic — a credential
 * file is present and its email decodes — which cannot distinguish a good token
 * from a revoked-but-unexpired one. This module completes a real request per
 * (agent, account) and records the verdict in a small cache that `agents view`,
 * `agents fleet status`, and the run rotation all read. The daemon and
 * `agents fleet ping` are the writers; everyone else reads.
 *
 * The network probes themselves live in lib/usage.ts (where the per-provider
 * token loaders + endpoints already are); this module classifies their result,
 * covers the best-effort (non-networked) providers, and owns the cache.
 */
import * as fs from 'fs';
import * as path from 'path';

import { ALL_AGENT_IDS, getAccountInfo, type AccountInfo } from './agents.js';
import { getCacheDir } from './state.js';
import type { AgentId } from './types.js';
import {
  probeClaudeStatus,
  probeDroidStatus,
  probeKimiStatus,
  type ProviderProbe,
} from './usage.js';
import { getVersionHomePath, listInstalledVersions } from './versions.js';

/**
 * - `live`        — completed an authenticated request (200).
 * - `revoked`     — the server rejected the token (401/403).
 * - `expired`     — locally-detected expiry; not network-verified (no refresh on the read path).
 * - `rate_limited`— token works but is throttled right now (429).
 * - `unverified`  — credential present, not locally expired, but this agent has no in-repo probe endpoint (codex/grok).
 * - `unconfigured`— no usable credential on disk.
 * - `error`       — network/other failure; verdict indeterminate (keep the last known one).
 */
export type AuthVerdict =
  | 'live'
  | 'revoked'
  | 'expired'
  | 'rate_limited'
  | 'unverified'
  | 'unconfigured'
  | 'error';

export interface AuthHealth {
  verdict: AuthVerdict;
  /** epoch ms of the probe. */
  checkedAt: number;
  /** optional short human detail (e.g. "HTTP 401", a network error). */
  detail?: string;
  /** account label for display (email / id), when known. Never part of the key. */
  account?: string;
}

/** Agents with a live network probe wired up today. The rest are best-effort. */
export const LIVE_PROBE_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'kimi', 'droid']);

// ---------------------------------------------------------------------------
// Pure classifiers / render (unit-tested; no network, no fs)
// ---------------------------------------------------------------------------

/** Map an HTTP status from a live probe to a verdict. */
export function classifyHttpStatus(status: number): AuthVerdict {
  if (status >= 200 && status < 300) return 'live';
  if (status === 401 || status === 403) return 'revoked';
  if (status === 429) return 'rate_limited';
  return 'error';
}

/** Turn a raw provider probe (from usage.ts) into a verdict. */
export function verdictFromProbe(probe: ProviderProbe): AuthVerdict {
  if (probe.token === 'missing') return 'unconfigured';
  if (probe.token === 'expired') return 'expired';
  if (probe.status == null) return 'error';
  return classifyHttpStatus(probe.status);
}

/** A short human detail line for a probe result (rendered under --verbose). */
export function probeDetail(probe: ProviderProbe): string | undefined {
  if (probe.status != null && (probe.status < 200 || probe.status >= 300)) return `HTTP ${probe.status}`;
  if (probe.error) return probe.error;
  return undefined;
}

const VERDICT_GLYPHS: Record<AuthVerdict, string> = {
  live: '●', // ●
  revoked: '○', // ○
  expired: '○', // ○
  rate_limited: '◐', // ◐
  unverified: '◐', // ◐
  unconfigured: '·', // ·
  error: '·', // ·
};

/** Uncolored glyph for a verdict (color is applied by the caller). */
export function verdictGlyph(verdict: AuthVerdict): string {
  return VERDICT_GLYPHS[verdict] ?? '·';
}

/** One-word label for matrices/verbose output. */
export function verdictLabel(verdict: AuthVerdict): string {
  switch (verdict) {
    case 'live': return 'live';
    case 'revoked': return 'revoked';
    case 'expired': return 'expired';
    case 'rate_limited': return 'limited';
    case 'unverified': return 'unverified';
    case 'unconfigured': return '—';
    case 'error': return '?';
  }
}

/** Roll a set of verdicts (one host×agent's installs) into counts for a matrix cell. */
export interface VerdictSummary {
  live: number;
  /** revoked — the server rejected the token (401/403). Genuinely needs re-login. */
  bad: number;
  /**
   * expired / rate_limited / unverified / error — degraded or unknown, but NOT
   * "re-login now". `expired` is soft for kimi/droid (their CLIs refresh the
   * token on next launch; we don't refresh on the read path), so it must not be
   * lumped with revoked or we'd cry wolf on a self-healing token.
   */
  warn: number;
  total: number;
}

export function summarizeVerdicts(verdicts: AuthVerdict[]): VerdictSummary {
  let live = 0;
  let bad = 0;
  let warn = 0;
  for (const v of verdicts) {
    if (v === 'live') live++;
    else if (v === 'revoked') bad++;
    else warn++;
  }
  return { live, bad, warn, total: verdicts.length };
}

/** Verdicts that mean "this token was rejected by the server — re-login required". */
export function isDeadVerdict(verdict: AuthVerdict): boolean {
  return verdict === 'revoked';
}

/** Human "3m ago" style age for a checkedAt timestamp. */
export function formatCheckedAge(checkedAt: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - checkedAt) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Cache identity + IO (single source of truth read by view/fleet/rotation)
// ---------------------------------------------------------------------------

/**
 * Human account label for display (email, else id). NOT used in the cache key —
 * two installs on one host can hold the same account with independently valid
 * tokens, so the key is keyed by version (below), not account.
 */
export function authAccountLabel(
  info: Pick<AccountInfo, 'email' | 'accountId' | 'userId'> | null | undefined,
): string | undefined {
  return info?.email || info?.accountId || info?.userId || undefined;
}

/** Cache key: one entry per install — (host, agent, version). Unique per token. */
export function authCacheKey(host: string, agent: AgentId | string, version: string): string {
  return `${host}:${agent}:${version}`;
}

interface AuthHealthCacheFile {
  version: 1;
  entries: Record<string, AuthHealth>;
}

function cacheFilePath(): string {
  return path.join(getCacheDir(), '.auth-health.json');
}

/** Read the whole cache (best-effort; a corrupt/missing file yields an empty map). */
export function readAuthHealthCache(): Record<string, AuthHealth> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')) as AuthHealthCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

/** Read one entry, or null. */
export function readAuthHealth(host: string, agent: AgentId | string, version: string): AuthHealth | null {
  return readAuthHealthCache()[authCacheKey(host, agent, version)] ?? null;
}

/** Merge one or more entries into the cache (best-effort write). */
export function writeAuthHealthEntries(entries: Record<string, AuthHealth>): void {
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const current = readAuthHealthCache();
    const merged: AuthHealthCacheFile = { version: 1, entries: { ...current, ...entries } };
    fs.writeFileSync(cacheFilePath(), JSON.stringify(merged, null, 2));
  } catch {
    // best-effort; a failed write just means the next reader falls back to heuristics
  }
}

// ---------------------------------------------------------------------------
// The probe (writer side)
// ---------------------------------------------------------------------------

/**
 * Complete a live auth probe for one (agent, home). For claude/kimi/droid this
 * hits the provider; for everyone else it reports a best-effort local verdict
 * (`unverified` when a credential is present, `unconfigured` otherwise) — never
 * masquerading as `live`.
 */
export async function probeAuthHealth(
  agent: AgentId,
  home: string | undefined,
  opts?: { cliVersion?: string | null; info?: AccountInfo | null },
): Promise<AuthHealth> {
  const checkedAt = Date.now();
  if (LIVE_PROBE_AGENTS.has(agent)) {
    let probe: ProviderProbe;
    if (agent === 'claude') probe = await probeClaudeStatus(home, opts?.cliVersion);
    else if (agent === 'kimi') probe = await probeKimiStatus(home);
    else probe = await probeDroidStatus(home);
    return { verdict: verdictFromProbe(probe), checkedAt, detail: probeDetail(probe) };
  }
  const info = opts?.info !== undefined ? opts.info : await getAccountInfo(agent, home).catch(() => null);
  return { verdict: info?.signedIn ? 'unverified' : 'unconfigured', checkedAt };
}

/** One probed install on a host. */
export interface AuthProbeRow {
  agent: AgentId;
  version: string;
  account?: string;
  health: AuthHealth;
}

/**
 * Enumerate every installed (agent, version) on THIS host, probe each in
 * parallel, and return the rows (installs with no credential at all are
 * dropped). Shared by `agents fleet ping --local` and the daemon refresh.
 */
export async function probeLocalFleetAuth(opts?: {
  cliVersion?: string | null;
  agents?: readonly AgentId[];
}): Promise<AuthProbeRow[]> {
  const agentIds = opts?.agents ?? ALL_AGENT_IDS;
  const tasks: Promise<AuthProbeRow | null>[] = [];
  for (const agent of agentIds) {
    for (const version of listInstalledVersions(agent)) {
      const home = getVersionHomePath(agent, version);
      tasks.push(
        (async (): Promise<AuthProbeRow | null> => {
          const info = await getAccountInfo(agent, home).catch(() => null);
          const health = await probeAuthHealth(agent, home, { cliVersion: opts?.cliVersion, info });
          health.account = authAccountLabel(info);
          if (health.verdict === 'unconfigured') return null;
          return { agent, version, account: health.account, health };
        })(),
      );
    }
  }
  const settled = await Promise.all(tasks);
  return settled.filter((r): r is AuthProbeRow => r !== null);
}

/** Persist a host's probed rows into the cache (keyed by host+agent+version). */
export function writeFleetAuthRows(host: string, rows: AuthProbeRow[]): void {
  const entries: Record<string, AuthHealth> = {};
  for (const row of rows) {
    entries[authCacheKey(host, row.agent, row.version)] = row.health;
  }
  writeAuthHealthEntries(entries);
}
