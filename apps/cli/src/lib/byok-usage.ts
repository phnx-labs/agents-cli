/**
 * BYOK (Bring Your Own Key) budget fetcher.
 *
 * For custom harnesses that use a provider's API key stored in the keychain
 * (e.g. OpenRouter), this module fetches the account's credit/usage data so
 * `agents view` can show a budget bar alongside the harness detail row — the
 * same bar style the native usage system uses, just sourced from the provider
 * API rather than the CLI's own usage tracking.
 */

import type { Profile } from './profiles.js';
import { hasKeychainToken, getKeychainToken } from './secrets/profiles.js';
import { renderBar, getUsageColor, USAGE_CACHE_FRESH_MS, USAGE_CACHE_SWR_MS } from './usage.js';
import chalk from 'chalk';

export interface ByokBudgetInfo {
  limitUsd: number | null;
  remainingUsd: number | null;
  usedUsd: number;
  usedPercent: number | null;
  fetchedAt: Date;
}

export interface ByokUsageResult {
  budget: ByokBudgetInfo | null;
  error: string | null;
}

// ─── Injectable fetch seam (tests only) ──────────────────────────────────────

let _fetch: typeof globalThis.fetch = globalThis.fetch;

export function setByokFetchForTest(fn: typeof globalThis.fetch): void {
  _fetch = fn;
}

// ─── SWR cache ───────────────────────────────────────────────────────────────

interface CacheEntry {
  result: ByokUsageResult;
  fetchedAt: number;
}

const _cache = new Map<string, CacheEntry>();

export function resetByokCacheForTest(): void {
  _cache.clear();
}

// ─── Provider registry ───────────────────────────────────────────────────────

interface ByokProviderEntry {
  fetch(keychainItem: string): Promise<ByokUsageResult>;
}

async function fetchOpenRouter(keychainItem: string): Promise<ByokUsageResult> {
  try {
    if (!hasKeychainToken(keychainItem)) return { budget: null, error: null };
  } catch {
    return { budget: null, error: null };
  }
  let token: string;
  try {
    token = getKeychainToken(keychainItem);
  } catch {
    return { budget: null, error: null };
  }
  try {
    const res = await _fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { budget: null, error: `HTTP ${res.status}` };
    const json = (await res.json()) as {
      data: { limit: number | null; limit_remaining: number | null; usage: number };
    };
    const { limit, limit_remaining, usage } = json.data;
    const limitUsd = limit ?? null;
    const usedUsd = usage;
    const usedPercent = limitUsd !== null && limitUsd > 0 ? (usedUsd / limitUsd) * 100 : null;
    return {
      budget: {
        limitUsd,
        remainingUsd: limit_remaining ?? null,
        usedUsd,
        usedPercent,
        fetchedAt: new Date(),
      },
      error: null,
    };
  } catch (err) {
    return { budget: null, error: String(err) };
  }
}

const BYOK_REGISTRY: Record<string, ByokProviderEntry> = {
  openrouter: { fetch: fetchOpenRouter },
};

export function hasByokProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(BYOK_REGISTRY, provider);
}

// ─── Bar renderer ─────────────────────────────────────────────────────────────

export function renderByokBar(result: ByokUsageResult): string {
  if (!result.budget) return '';
  const { budget } = result;
  if (budget.limitUsd === null) {
    const bar = renderBar(0, 10, 0);
    return `$: ${bar} $${budget.usedUsd.toFixed(2)} used (unlimited)`;
  }
  const pct = budget.usedPercent ?? 0;
  const bar = renderBar(pct, 10, pct > 0 ? 1 : 0);
  const color = getUsageColor(pct);
  const remaining = budget.remainingUsd !== null ? `$${budget.remainingUsd.toFixed(2)}` : '?';
  const limit = `$${budget.limitUsd.toFixed(2)}`;
  return `$: ${bar} ${color(`${Math.round(pct)}%`)} (${remaining} left of ${limit})`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the BYOK budget for a harness.
 *
 * Returns `null` when the harness has no registered BYOK provider or no auth.
 * Returns a `ByokUsageResult` with `budget: null` when the token is absent
 * from the keychain (so the caller can skip rendering a bar without error).
 *
 * Results are SWR-cached per `keychainItem` so harnesses sharing one API key
 * deduplicate to a single network request.
 */
export async function getByokUsageForHarness(
  profile: Profile,
  opts?: { forceRefresh?: boolean },
): Promise<ByokUsageResult | null> {
  if (!profile.provider || !hasByokProvider(profile.provider) || !profile.auth) return null;
  const keychainItem = profile.auth.keychainItem;
  const provider = BYOK_REGISTRY[profile.provider];
  const now = Date.now();
  const cached = _cache.get(keychainItem);

  if (!opts?.forceRefresh && cached) {
    const age = now - cached.fetchedAt;
    if (age < USAGE_CACHE_FRESH_MS) {
      return cached.result;
    }
    if (age < USAGE_CACHE_SWR_MS) {
      void provider.fetch(keychainItem).then((result) => {
        _cache.set(keychainItem, { result, fetchedAt: Date.now() });
      });
      return cached.result;
    }
  }

  const result = await provider.fetch(keychainItem);
  _cache.set(keychainItem, { result, fetchedAt: now });
  return result;
}
