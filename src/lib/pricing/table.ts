/**
 * Offline, versioned per-model pricing table.
 *
 * The canonical data lives in `prices.json` (LiteLLM-style per-token USD map)
 * and is imported with a `type: json` attribute so it survives `tsc` emit AND
 * Node ESM's import-attribute requirement at runtime (the package is ESM).
 *
 * `getModelPricing` is prefix/suffix-tolerant: real model identifiers carry
 * vendor prefixes (`us.anthropic.`), version dashes (`claude-opus-4-8`), and
 * date suffixes (`-20250514`), none of which appear in the canonical keys. We
 * normalize the input, then match against the LONGEST canonical key the
 * normalized id contains so `claude-opus-4` wins over a hypothetical
 * `claude-opus` when both are present.
 */
import pricesData from './prices.json' with { type: 'json' };

/** Per-token USD prices for a single model. Cache fields optional (not all vendors expose them). */
export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken?: number;
  cacheWritePerToken?: number;
}

interface PricesFile {
  version: string;
  models: Record<string, ModelPricing>;
}

const PRICES = pricesData as PricesFile;

/** Date-stamped version of the pricing table (e.g. "2026-06-24"). */
export const PRICING_VERSION: string = PRICES.version;

const MODELS: Record<string, ModelPricing> = PRICES.models;

// Canonical keys sorted longest-first so containment matching prefers the most
// specific key (e.g. "gemini-2.5-flash-lite" before "gemini-2.5-flash").
const KEYS_BY_LENGTH = Object.keys(MODELS).sort((a, b) => b.length - a.length);

/**
 * Normalize a raw model id into the dash-delimited token space the canonical
 * keys live in. Strips vendor prefixes (`anthropic/`, `us.anthropic.`,
 * `models/`, `openai/`), lowercases, and collapses any non [a-z0-9.] run to a
 * single dash so `claude-opus-4-8`, `Claude Opus 4`, and `claude.opus.4` all
 * normalize to a comparable form.
 */
function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  // Drop a leading vendor segment: "anthropic/claude-..", "us.anthropic.claude-..",
  // "google/gemini-..", "models/gemini-..", "openai/gpt-..".
  id = id.replace(/^[a-z]+\//, '');                 // "anthropic/x" -> "x"
  id = id.replace(/^[a-z]+\.[a-z]+\./, '');         // "us.anthropic.x" -> "x"
  id = id.replace(/^models\//, '');                 // already handled, defensive
  // Collapse separators to single dashes, keep dots (gpt-5.4) intact.
  id = id.replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  return id;
}

/**
 * Resolve per-token pricing for a model id. Tolerant of vendor prefixes,
 * version dashes, and date suffixes. Returns null when no canonical key is a
 * substring of the normalized id (i.e. genuinely unknown model).
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  if (!modelId) return null;
  const norm = normalizeModelId(modelId);

  // Exact key first (fast path + unambiguous).
  if (MODELS[norm]) return MODELS[norm];

  // Containment match, longest canonical key wins. The canonical key must
  // appear as a dash-bounded prefix of the normalized id so "claude-opus-4"
  // matches "claude-opus-4-8" and "claude-opus-4-20250514" but a stray
  // "gpt-4" inside "gpt-40-turbo-experimental" still requires the boundary.
  for (const key of KEYS_BY_LENGTH) {
    if (norm === key || norm.startsWith(key + '-') || norm.startsWith(key + '.')) {
      return MODELS[key];
    }
  }

  // Last resort: canonical key contained anywhere (handles "anthropic-claude-opus-4"
  // style ids the prefix strip missed). Still longest-first.
  for (const key of KEYS_BY_LENGTH) {
    if (norm.includes(key)) return MODELS[key];
  }

  return null;
}

/** List every canonical model id that carries a price. */
export function listPricedModels(): string[] {
  return Object.keys(MODELS);
}
