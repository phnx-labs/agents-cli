/**
 * Session-summarizer configuration (PHNX-3939).
 *
 * Resolves the three knobs behind the daemon summarizer — enabled / base URL /
 * model — from `agents config` (`summarizer.*`, user-scope in the central
 * agents.yaml) with a per-process env override
 * (`AGENTS_SUMMARIZER_ENABLED` / `AGENTS_SUMMARIZER_BASEURL` /
 * `AGENTS_SUMMARIZER_MODEL`). Off by default: with no config and no env, the
 * summarizer is disabled and makes zero model calls.
 *
 * `isSummarizerEnabled()` is memoized on a short TTL because the display merge
 * (`applyImmutableMemo`) calls it once per session row on the gather path — a
 * fresh agents.yaml read per row would defeat the "blazing fast" requirement.
 */

import { getConfigValue } from '../device-config.js';

export interface SummarizerConfig {
  enabled: boolean;
  /** Anthropic-wire base URL (Ollama/vLLM/LiteLLM), or undefined when unconfigured. */
  baseUrl?: string;
  /** Model id to request, or undefined when unconfigured. */
  model?: string;
}

/** Parse a boolean-ish env value; undefined when the var is unset. */
function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '') return false;
  return undefined;
}

function envString(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

/**
 * Resolve the full summarizer config. Env overrides the stored config key by key;
 * an unset env var falls through to `agents config`, then to the built-in
 * default (disabled). Never throws — a missing/corrupt config reads as unset.
 */
export function resolveSummarizerConfig(env: NodeJS.ProcessEnv = process.env): SummarizerConfig {
  let storedEnabled: boolean | undefined;
  let storedBaseUrl: string | undefined;
  let storedModel: string | undefined;
  try {
    storedEnabled = getConfigValue('summarizer.enabled').value as boolean | undefined;
    storedBaseUrl = getConfigValue('summarizer.baseUrl').value as string | undefined;
    storedModel = getConfigValue('summarizer.model').value as string | undefined;
  } catch {
    // A missing/corrupt config store must not break the read path — treat as unset.
  }
  const enabled = envBool(env.AGENTS_SUMMARIZER_ENABLED) ?? storedEnabled ?? false;
  const baseUrl = envString(env.AGENTS_SUMMARIZER_BASEURL) ?? envString(storedBaseUrl);
  const model = envString(env.AGENTS_SUMMARIZER_MODEL) ?? envString(storedModel);
  return { enabled, baseUrl, model };
}

/**
 * True only when the summarizer is enabled AND has a base URL + model to call.
 * A configuration that is `enabled` but missing an endpoint cannot produce a
 * summary, so it is treated as unconfigured (the service no-ops, the merge marks
 * `skipped`) rather than erroring on every tick.
 */
export function isSummarizerRunnable(config: SummarizerConfig): boolean {
  return config.enabled && Boolean(config.baseUrl) && Boolean(config.model);
}

let cachedEnabled: { at: number; value: boolean } | null = null;
const ENABLED_TTL_MS = 3_000;

/**
 * Memoized "is the operator asking for summaries?" check for the hot merge path.
 * Reflects only `enabled` (not runnable) — the merge uses it to decide whether a
 * session with no cached summary reads `pending` (enabled) or `skipped`
 * (disabled). TTL keeps a config toggle visible within a few seconds without a
 * per-row agents.yaml read.
 */
export function isSummarizerEnabled(nowMs: number = Date.now()): boolean {
  if (cachedEnabled && nowMs - cachedEnabled.at < ENABLED_TTL_MS) return cachedEnabled.value;
  const value = resolveSummarizerConfig().enabled;
  cachedEnabled = { at: nowMs, value };
  return value;
}

/** Test seam: drop the memoized enabled flag so the next read re-resolves. */
export function resetSummarizerEnabledCacheForTest(): void {
  cachedEnabled = null;
}
