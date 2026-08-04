/**
 * Cost tiers for model selection: cheap / default / best / ultra.
 *
 * An orchestrating agent picks a teammate's model by a stable, cost-first tier
 * instead of a concrete id that churns per release and varies per harness. A
 * tier resolves, per (harness, installed version), to a model that version
 * actually ships — so `--model cheap|default|best|ultra` works on `agents run`
 * and `agents teams add` alike, funnelling through `resolveModel()`.
 *
 * Ranking signal, in priority (see apps/cli/docs — model ranking mechanisms):
 *   1. Provider-declared lineup — the catalog's own family names / descriptions
 *      (opus/sonnet/haiku/fable; Codex "frontier / balanced / fast"). Most
 *      drift-proof: the provider tells us its own ranking.
 *   2. Per-token price (prices.json) — cross-check + the $/Mtok display + budget.
 *   3. Size-token heuristic (nano|mini|lite|flash cheaper; pro|max|opus dearer).
 *   4. Reasoning effort for single-model harnesses (Grok) — tiers steer --effort.
 *
 * The mechanism differs per provider and drifts across versions, so tiers always
 * resolve against the installed version's own catalog.
 */
import type { AgentId } from './types.js';
import { getModelCatalog, type ModelInfo } from './models.js';
import { getModelPricing } from './pricing/index.js';
import { resolveTierOverride } from './model-tier-overrides.js';

/** The four cross-harness cost tiers, cheapest -> most capable. */
export const MODEL_TIERS = ['cheap', 'default', 'best', 'ultra'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** True if `s` is one of the four tier tokens (not a concrete model id). */
export function isTierToken(s: string | undefined | null): s is ModelTier {
  return !!s && (MODEL_TIERS as readonly string[]).includes(s);
}

/** How a single tier resolved for a given (agent, version). */
export interface TierResolution {
  tier: ModelTier;
  /** Concrete model id to forward, or null when nothing resolves (fail-safe). */
  model: string | null;
  /** Reasoning effort to forward, for single-model harnesses where the tier is effort, not model. */
  effort?: string;
  /** Set when this tier has no rung of its own: the lower tier whose model it borrowed. */
  clampedFrom?: ModelTier;
  /** Human note (e.g. why it clamped, or that it is a curated/subscription mapping). */
  note?: string;
  /** Where the model came from: 'auto' ranking, a user 'override', or a 'curated' ladder. */
  source?: 'auto' | 'override' | 'curated';
}

/**
 * Curated tier ladders for harnesses the auto-ranker can't order from names/price
 * (subscription harnesses with no price signal). Each rung is `[tier, matcher]` in
 * cheap -> best order; the newest catalog id matching each rung fills that tier,
 * missing tiers clamp. Extend this table rather than adding per-harness branches.
 */
const CURATED_LADDERS: Partial<Record<AgentId, Array<{ tier: ModelTier; match: RegExp }>>> = {
  // Kimi: K2.7 Highspeed < K2.7 Coding < K3 (the 1M-context default; k3-256k folds
  // into K3). No ultra. The name heuristic can't tell K3 > K2.7, so curate it.
  kimi: [
    { tier: 'cheap', match: /highspeed/i },
    { tier: 'default', match: /for-coding(?!.*highspeed)/i },
    { tier: 'best', match: /(^|[-/])k3(?![\d-])/i },
  ],
};

// --- single-model harnesses: the tier is reasoning effort, not a model ---------
const TIER_EFFORT: Record<ModelTier, string> = {
  cheap: 'low',
  default: 'medium',
  best: 'high',
  ultra: 'xhigh',
};

// --- Droid: no live catalog; prices in credit multipliers. Curated map, capped
//     at 2x (no 4x models like Fable 5 / Fast modes). Ids are Factory -m values.
const DROID_TIERS: Record<ModelTier, string> = {
  cheap: 'glm-5.2', // 0.55x (Droid Core)
  default: 'kimi-k3', // 0.6x (Droid Core)
  best: 'claude-opus-5', // 2x
  ultra: 'claude-opus-5', // clamp to best; avoid 4x
};

/** Router / pseudo models that are not a concrete choice and never a tier target. */
const PSEUDO = /(^|[-/])(auto|auto-review|router|dynamic)([-/]|$)/i;

/** Effort / speed suffixes aggregator harnesses (Cursor) bake into ids. */
const AGGREGATOR_SUFFIX = /-(low|medium|high|xhigh|thinking|fast|reasoning)\b/gi;

/** Anthropic capability family -> rank (cheapest 0 -> dearest 3). */
function anthropicFamilyRank(id: string): number | null {
  if (/(^|[-/])claude-haiku|(^|[-/])haiku/.test(id)) return 0;
  if (/claude-sonnet|(^|[-/])sonnet/.test(id)) return 1;
  if (/claude-opus|(^|[-/])opus/.test(id)) return 2;
  if (/claude-(fable|mythos)|(^|[-/])(fable|mythos)/.test(id)) return 3;
  return null;
}

/** Rank from the provider's own description keywords (e.g. Codex Sol/Terra/Luna). */
function descriptionRank(desc: string | undefined): number | null {
  if (!desc) return null;
  const d = desc.toLowerCase();
  if (/(fast|affordable|cost-efficient|small|cheap|mini|nano|lightweight|spark)/.test(d)) return 0;
  if (/(balanced|everyday|strong|general)/.test(d)) return 1;
  if (/(frontier|latest|flagship|most capable|complex|advanced|professional)/.test(d)) return 2;
  return null;
}

/** Last-resort ordering from size tokens embedded in the id. */
function sizeTokenRank(id: string): number {
  if (/(nano|mini|lite|flash|highspeed|small|air|spark)/.test(id)) return 0;
  if (/(pro|max|ultra|opus|sol|large|frontier|heavy|thinking)/.test(id)) return 2;
  return 1;
}

const blended = (id: string): number | null => {
  const p = getModelPricing(id);
  return p ? p.inputPerToken + p.outputPerToken : null;
};

/** Strip an aggregator's effort/speed suffixes down to a base provider id. */
function normalizeAggregatorId(id: string): string {
  return id.replace(AGGREGATOR_SUFFIX, '').replace(/-+$/,'');
}

interface Ranked {
  /** Concrete id to forward (the original catalog id, newest per family). */
  id: string;
  /** Sort key, lower = cheaper. */
  rank: number;
  /** Grouping key so variants of one model collapse to a single rung. */
  family: string;
  price: number | null;
}

/**
 * Compare two concrete ids so the newest wins within a family. Strips a trailing
 * date stamp (`-20251101`), rebuild marker (`-v1`), and `-fast` first, so a dated
 * `opus-4-5-20251101` doesn't out-rank the genuinely newer `opus-4-8` (a bare
 * `compareVersions` reads the date as a huge version component).
 */
function cleanForCompare(id: string): string {
  return id
    .replace(/-\d{8}(?=($|-))/, '')
    .replace(/-v\d+$/, '')
    .replace(/-fast$/, '');
}
/** Numeric segments of a (cleaned) id, splitting on BOTH dashes and dots. */
function versionSegments(id: string): number[] {
  const m = cleanForCompare(id).match(/\d+/g);
  return m ? m.map((n) => parseInt(n, 10)) : [];
}
/**
 * Newest concrete id within a family wins. `compareVersions` only splits on `.`,
 * so it degenerates to a single `[0]` segment for a dash-separated model id and
 * mis-ranks e.g. `claude-sonnet-5` below `claude-sonnet-4-6`. Compare the numeric
 * segments directly instead.
 */
function newer(a: string, b: string): number {
  const A = versionSegments(a);
  const B = versionSegments(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Rank a harness's catalog models cheapest -> dearest and collapse variants of
 * one model to a single rung (keeping the newest concrete id). Strategy depends
 * on the harness class: aggregator (Cursor) ranks by price of the normalized
 * base id; single-provider harnesses rank by the provider lineup with price and
 * size tokens as fallbacks.
 */
function rankCatalog(agent: AgentId, models: ModelInfo[]): Ranked[] {
  const usable = models.filter((m) => !PSEUDO.test(m.id));
  const aggregator = agent === 'cursor';

  const scored = usable.map((m) => {
    const rawId = m.id;
    const baseId = aggregator ? normalizeAggregatorId(rawId) : rawId;
    const lc = baseId.toLowerCase();
    const price = blended(baseId) ?? blended(rawId);

    let rank: number;
    let family: string;
    if (aggregator) {
      // cross-provider: price is the unifying signal; family = base id
      rank = price != null ? price * 1e6 : 100 + sizeTokenRank(lc);
      family = baseId;
    } else {
      const fam = anthropicFamilyRank(lc);
      const desc = descriptionRank(m.description);
      if (fam != null) {
        rank = fam;
        family = `anthropic-${fam}`;
      } else if (desc != null) {
        rank = desc;
        family = `desc-${desc}-${baseId.replace(/[0-9].*$/, '')}`;
      } else if (price != null) {
        rank = 10 + price * 1e6;
        // Collapse only true re-releases of ONE model (same base id, differing
        // date/rebuild suffix). Keying on price would merge two DIFFERENT models
        // that happen to cost the same (e.g. gpt-5.5 and gpt-5.6-sol), dropping
        // one from every tier.
        family = cleanForCompare(baseId);
      } else {
        rank = 20 + sizeTokenRank(lc);
        family = cleanForCompare(baseId);
      }
    }
    return { id: rawId, baseId, rank, family, price } as Ranked & { baseId: string };
  });

  // collapse by family: keep the newest concrete id, lowest (cheapest) rank
  const byFamily = new Map<string, Ranked>();
  for (const s of scored) {
    const prev = byFamily.get(s.family);
    if (!prev) { byFamily.set(s.family, s); continue; }
    // keep the newer id; keep the cheaper rank
    if (newer(s.id, prev.id) > 0) prev.id = s.id;
    if (s.rank < prev.rank) prev.rank = s.rank;
    if (prev.price == null && s.price != null) prev.price = s.price;
  }
  return [...byFamily.values()].sort((a, b) => a.rank - b.rank || newer(b.id, a.id));
}

/** Which ranked rung each tier index maps to, collapsing when there are < 4 rungs. */
function rungIndexFor(tierIndex: number, n: number): number {
  return n >= 4 ? Math.round((tierIndex / 3) * (n - 1)) : Math.min(tierIndex, n - 1);
}

/** Bucket an ordered (cheap -> dear) rung list onto the four tiers, clamping when < 4. */
function bucketRungs(rungs: Array<{ id: string }>): Record<ModelTier, TierResolution> {
  const n = rungs.length;
  const map = {} as Record<ModelTier, TierResolution>;
  if (n === 0) {
    // Fail-safe: no catalog -> every tier null, caller drops the --model flag.
    for (const t of MODEL_TIERS) map[t] = { tier: t, model: null };
    return map;
  }
  // A tier that shares the rung of the tier below has no distinct rung -> mark clamped.
  for (let i = 0; i < MODEL_TIERS.length; i++) {
    const t = MODEL_TIERS[i];
    const idx = rungIndexFor(i, n);
    const shared = i > 0 && rungIndexFor(i - 1, n) === idx;
    map[t] = shared
      ? { tier: t, model: rungs[idx].id, clampedFrom: MODEL_TIERS[i - 1], note: `no distinct ${t} rung; using ${MODEL_TIERS[i - 1]}`, source: 'auto' }
      : { tier: t, model: rungs[idx].id, source: 'auto' };
  }
  return map;
}

/** Build a tier map from a curated ladder against a catalog (newest match per rung). */
function tierizeFromLadder(
  ladder: Array<{ tier: ModelTier; match: RegExp }>,
  models: ModelInfo[],
): Record<ModelTier, TierResolution> {
  const usable = models.filter((m) => !PSEUDO.test(m.id));
  const rungs: Array<{ id: string }> = [];
  for (const rung of ladder) {
    const matches = usable.filter((m) => rung.match.test(m.id));
    if (matches.length === 0) continue;
    rungs.push({ id: matches.reduce((a, b) => (newer(b.id, a.id) > 0 ? b : a)).id });
  }
  const map = bucketRungs(rungs);
  for (const t of MODEL_TIERS) if (map[t].model) map[t].source = 'curated';
  return map;
}

/**
 * Resolve all four tiers for an (agent, version) -- what `agents models` prints and
 * `resolveTier` indexes. Precedence: user override -> curated ladder / auto-ranking.
 */
export function resolveTierMap(agent: AgentId, version: string): Record<ModelTier, TierResolution> {
  let base: Record<ModelTier, TierResolution>;
  let catalogIds: Set<string> | null;

  if (agent === 'droid') {
    // Droid: curated credit-multiplier map (no live catalog to validate against).
    base = {
      cheap: { tier: 'cheap', model: DROID_TIERS.cheap, note: 'Droid Core 0.55x', source: 'curated' },
      default: { tier: 'default', model: DROID_TIERS.default, note: 'Droid Core 0.6x', source: 'curated' },
      best: { tier: 'best', model: DROID_TIERS.best, note: '2x', source: 'curated' },
      ultra: { tier: 'ultra', model: DROID_TIERS.ultra, clampedFrom: 'best', note: 'capped at 2x (4x excluded)', source: 'curated' },
    };
    catalogIds = null;
  } else {
    const catalog = getModelCatalog(agent, version);
    const models = catalog?.models ?? [];
    const ladder = CURATED_LADDERS[agent];
    base = ladder ? tierizeFromLadder(ladder, models) : tierizeModels(agent, models);
    catalogIds = catalog ? new Set(models.map((m) => m.id)) : null;
  }

  return applyTierOverrides(agent, version, catalogIds, base);
}

/**
 * Apply user overrides on top of the auto/curated map. An overridden id is used
 * only when the version actually ships it (or when there is no catalog to check,
 * e.g. Droid); otherwise the tier keeps its auto value with a note.
 */
function applyTierOverrides(
  agent: AgentId,
  version: string | null | undefined,
  catalogIds: Set<string> | null,
  base: Record<ModelTier, TierResolution>,
): Record<ModelTier, TierResolution> {
  const overrides = resolveTierOverride(agent, version);
  if (Object.keys(overrides).length === 0) return base;
  const out = { ...base };
  for (const t of MODEL_TIERS) {
    const id = overrides[t];
    if (!id) continue;
    if (!catalogIds || catalogIds.has(id)) {
      out[t] = { tier: t, model: id, source: 'override' };
    } else {
      out[t] = { ...base[t], note: `override "${id}" not shipped by ${agent}@${version ?? '?'}; using auto`, source: base[t].source ?? 'auto' };
    }
  }
  return out;
}

/**
 * Map a harness's catalog models onto the four tiers. Pure (no catalog lookup) so
 * it is directly testable. A single-model harness maps the tiers to reasoning effort.
 */
export function tierizeModels(agent: AgentId, models: ModelInfo[]): Record<ModelTier, TierResolution> {
  const rungs = rankCatalog(agent, models);

  // Single-model harness (e.g. Grok): the tier is reasoning effort, not a model.
  if (rungs.length === 1) {
    const only = rungs[0].id;
    const map = {} as Record<ModelTier, TierResolution>;
    for (const t of MODEL_TIERS) map[t] = { tier: t, model: only, effort: TIER_EFFORT[t], note: 'single model — tier maps to reasoning effort', source: 'auto' };
    return map;
  }
  return bucketRungs(rungs);
}

/** Resolve one tier for an (agent, version). Null model => caller drops the flag. */
export function resolveTier(agent: AgentId, version: string, tier: ModelTier): TierResolution {
  return resolveTierMap(agent, version)[tier];
}
