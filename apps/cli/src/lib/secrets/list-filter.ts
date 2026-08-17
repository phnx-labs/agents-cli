/**
 * Filters for `agents secrets list`.
 *
 * The listing had no filtering at all: `--device`/`--device` pick a machine and
 * `--json` picks a format, but nothing selected over the bundles themselves. On
 * a fleet with fifty-odd bundles the answerable questions — which ones read with
 * no Touch ID at all, which hold a raw literal, which have already expired, what
 * has not been touched in three months — meant piping the table through grep, or
 * were simply unanswerable.
 *
 * Everything here is pure: parsing produces a `SecretsListFilter`, and
 * `bundleMatchesFilter` is a predicate over a bundle plus the ambient facts it
 * cannot derive itself (which bundles the broker currently holds, and the
 * current time). That keeps the whole surface unit-testable without a keychain.
 *
 * Shape follows the `agents sessions` house style: comma-separated lists, an
 * unknown value is a loud error naming the valid set (never a silent ignore),
 * and every axis narrows independently so they AND-compose.
 */

import { parseCommaSeparatedList } from '../format.js';
// From the leaf module, NOT discover.js — the latter imports `../sqlite.js`, so
// reaching through it for one parser would pull node:sqlite into every `agents
// secrets` invocation and print Node's SQLite ExperimentalWarning on stderr.
import { parseTimeFilter } from '../session/relative-time.js';
import {
  describeBundle,
  bundlePolicy,
  SECRET_TYPES,
  type SecretsBundle,
  type SecretsPolicy,
  type SecretsBackend,
  type SecretType,
} from './bundles.js';

/** Ref kinds a var's value can have, from `describeBundle`. */
export const REF_KINDS = ['literal', 'keychain', 'env', 'file', 'exec'] as const;
export type RefKind = typeof REF_KINDS[number];

const POLICIES: readonly SecretsPolicy[] = ['always', 'hold', 'never'];
const BACKENDS: readonly SecretsBackend[] = ['keychain', 'file', 'vault'];

/** Default window for `--expiring` with no argument — matches the EXPIRING column. */
export const DEFAULT_EXPIRING_DAYS = 30;

/** A parsed, validated filter. Every field is optional; absent ⇒ that axis does
 * not narrow. All present axes must match (AND). */
export interface SecretsListFilter {
  /** Case-insensitive substring over bundle name and description. */
  query?: string;
  policy?: SecretsPolicy[];
  backend?: SecretsBackend[];
  type?: SecretType[];
  kind?: RefKind[];
  /** true ⇒ only bundles the broker holds; false ⇒ only those it does not. */
  held?: boolean;
  /** Only bundles with at least one var whose `expires` is already past. */
  expired?: boolean;
  /** Only bundles with at least one var expiring within this many days. */
  expiringDays?: number;
  /** Only bundles whose `last_used` is older than this epoch-ms (or never used). */
  unusedBefore?: number;
}

/** The raw option bag commander hands us. */
export interface SecretsListFilterOpts {
  policy?: string;
  backend?: string;
  type?: string;
  kind?: string;
  held?: boolean;
  notHeld?: boolean;
  expired?: boolean;
  expiring?: string | boolean;
  unused?: string;
}

/**
 * Validate one comma-separated enum list. An unknown value throws and names the
 * whole valid set — a silent ignore would let `--policy hodl` quietly return
 * every bundle, which reads as "nothing matches that" and is worse than an error.
 * Values are lowercased, matching `parsePolicyOpt`'s handling of policy names.
 */
export function parseEnumList<T extends string>(
  raw: string,
  flag: string,
  valid: readonly T[],
): T[] {
  const parts = parseCommaSeparatedList(raw).map((s) => s.toLowerCase());
  if (parts.length === 0) {
    throw new Error(`${flag} requires at least one value. Valid values: ${valid.join(', ')}`);
  }
  for (const p of parts) {
    if (!valid.includes(p as T)) {
      throw new Error(`Invalid value "${p}" for ${flag}. Valid values: ${valid.join(', ')}`);
    }
  }
  // De-dup so `--policy hold,hold` behaves like `--policy hold`.
  return [...new Set(parts)] as T[];
}

/** Parse `--expiring` — a bare flag means the default window, a value means N days. */
function parseExpiringDays(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true || raw === '') return DEFAULT_EXPIRING_DAYS;
  const n = Number(raw);
  // 0 is rejected rather than accepted as a no-op: the window is `0 <= d < N`,
  // so `--expiring 0` can never match anything, not even a key expiring today.
  // A flag that silently returns nothing is worse than one that says why.
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid --expiring '${raw}'. Use a whole number of days >= 1, e.g. --expiring 7. ` +
      'For keys that have already lapsed, use --expired.',
    );
  }
  return n;
}

/** Build a validated filter from commander's option bag. Throws on bad input. */
export function parseListFilters(opts: SecretsListFilterOpts, query?: string): SecretsListFilter {
  if (opts.held && opts.notHeld) {
    throw new Error('--held and --not-held are mutually exclusive');
  }
  const filter: SecretsListFilter = {};
  const trimmedQuery = query?.trim();
  if (trimmedQuery) filter.query = trimmedQuery.toLowerCase();
  if (opts.policy) filter.policy = parseEnumList(opts.policy, '--policy', POLICIES);
  if (opts.backend) filter.backend = parseEnumList(opts.backend, '--backend', BACKENDS);
  if (opts.type) filter.type = parseEnumList(opts.type, '--type', SECRET_TYPES);
  if (opts.kind) filter.kind = parseEnumList(opts.kind, '--kind', REF_KINDS);
  if (opts.held) filter.held = true;
  if (opts.notHeld) filter.held = false;
  if (opts.expired) filter.expired = true;
  const expiringDays = parseExpiringDays(opts.expiring);
  if (expiringDays !== undefined) filter.expiringDays = expiringDays;
  if (opts.unused) {
    // parseTimeFilter turns '90d' into "the epoch-ms 90 days ago"; a bundle is
    // unused when its last_used predates that instant.
    const cutoff = parseTimeFilter(opts.unused);
    if (!cutoff) {
      throw new Error(`Invalid --unused '${opts.unused}'. Use e.g. 30d, 4w, 3mo, or an ISO date.`);
    }
    filter.unusedBefore = cutoff;
  }
  return filter;
}

/** True when any axis is set — used to decide whether the empty state should
 * explain itself rather than claim there are no bundles at all. */
export function filterIsActive(f: SecretsListFilter): boolean {
  return Object.keys(f).length > 0;
}

/** Whole days from now until end-of-day UTC of an ISO date. Negative once past.
 * Mirrors the `daysUntil` used by the human render so the filter and the column
 * can never disagree about whether something has expired. */
function daysUntil(iso: string, now: number): number {
  const target = new Date(`${iso}T23:59:59Z`).getTime();
  return Math.floor((target - now) / (24 * 60 * 60 * 1000));
}

/** Expiry tallies for one bundle: how many vars are already past, and how many
 * fall due within `withinDays`. */
export function bundleExpiry(
  b: SecretsBundle,
  now: number,
  withinDays = DEFAULT_EXPIRING_DAYS,
): { expired: number; soon: number } {
  let expired = 0;
  let soon = 0;
  for (const m of Object.values(b.meta ?? {})) {
    if (!m.expires) continue;
    const d = daysUntil(m.expires, now);
    if (d < 0) expired++;
    else if (d < withinDays) soon++;
  }
  return { expired, soon };
}

/** Ambient facts a bundle can't answer about itself. */
export interface FilterContext {
  /** Bundle name → hold expiry epoch-ms, from the broker. Empty off macOS. */
  held: Map<string, number>;
  now: number;
}

/** Does this bundle satisfy every set axis? Pure. */
export function bundleMatchesFilter(
  b: SecretsBundle,
  f: SecretsListFilter,
  ctx: FilterContext,
): boolean {
  if (f.query) {
    const haystack = `${b.name} ${b.description ?? ''}`.toLowerCase();
    if (!haystack.includes(f.query)) return false;
  }
  if (f.policy && !f.policy.includes(bundlePolicy(b))) return false;
  if (f.backend && !f.backend.includes(b.backend ?? 'keychain')) return false;
  if (f.held !== undefined) {
    // A lapsed entry is not held — same liveness rule the POLICY column uses.
    const exp = ctx.held.get(b.name);
    const isHeld = exp !== undefined && exp > ctx.now;
    if (isHeld !== f.held) return false;
  }
  if (f.type) {
    const types = Object.values(b.meta ?? {}).map((m) => m.type).filter(Boolean) as SecretType[];
    if (!types.some((t) => f.type!.includes(t))) return false;
  }
  if (f.kind) {
    const kinds = describeBundle(b).map((e) => e.kind);
    if (!kinds.some((k) => f.kind!.includes(k))) return false;
  }
  if (f.expired || f.expiringDays !== undefined) {
    const { expired, soon } = bundleExpiry(b, ctx.now, f.expiringDays ?? DEFAULT_EXPIRING_DAYS);
    if (f.expired && expired === 0) return false;
    if (f.expiringDays !== undefined && soon === 0) return false;
  }
  if (f.unusedBefore !== undefined) {
    // Never used counts as unused — it is the strongest form of the answer.
    if (b.last_used && new Date(b.last_used).getTime() >= f.unusedBefore) return false;
  }
  return true;
}

/** Sort fields for `--sort`. `name` is the default and matches `listBundles()`.
 * `used` is most-recently-used first and `uses` is most-frequently-accessed
 * first; both read the value-free usage read-model (lib/secrets/usage-db.ts). */
export const SORT_FIELDS = ['name', 'used', 'uses', 'created', 'updated', 'expiry'] as const;
export type SortField = typeof SORT_FIELDS[number];

/**
 * The two value-free usage facts `--sort used|uses` needs, keyed by bundle name.
 * Kept as a minimal shape (not the full BundleUsageSummary) so this module stays
 * pure and unit-testable without opening the SQLite read-model.
 */
export interface BundleUsageHint {
  /** Most recent recorded event across all kinds, ISO 8601, or null. */
  lastUsedAt: string | null;
  /** Recorded `access` (read/inject) count — what `--sort uses` ranks on. */
  uses: number;
}

export function parseSortField(raw: string | undefined): SortField {
  if (!raw) return 'name';
  const v = raw.toLowerCase();
  if (!(SORT_FIELDS as readonly string[]).includes(v)) {
    throw new Error(`Invalid --sort '${raw}'. Valid values: ${SORT_FIELDS.join(', ')}`);
  }
  return v as SortField;
}

/** Epoch-ms of a bundle's soonest expiry, or Infinity when nothing expires — so
 * `--sort expiry` puts the most urgent first and never-expiring bundles last. */
function soonestExpiry(b: SecretsBundle): number {
  let soonest = Infinity;
  for (const m of Object.values(b.meta ?? {})) {
    if (!m.expires) continue;
    const t = new Date(`${m.expires}T23:59:59Z`).getTime();
    if (t < soonest) soonest = t;
  }
  return soonest;
}

/** Sort a copy. Time fields are most-recent-first (the useful direction for
 * "what did I touch lately"); `uses` is most-frequently-accessed first; `expiry`
 * is soonest-first; ties fall back to name so the order is stable. `usage`
 * carries the value-free read-model facts `used`/`uses` rank on — when omitted,
 * `used` falls back to the throttled `last_used` stamp and `uses` sees zero. */
export function sortBundles(
  bundles: SecretsBundle[],
  field: SortField,
  usage?: Map<string, BundleUsageHint>,
): SecretsBundle[] {
  const stamp = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : 0);
  const byName = (a: SecretsBundle, z: SecretsBundle) => a.name.localeCompare(z.name);
  // `used` combines the throttled keychain stamp with the exact usage-DB recency
  // so a just-recorded access ranks a bundle even before its stamp catches up.
  const usedMs = (b: SecretsBundle): number => Math.max(stamp(b.last_used), stamp(usage?.get(b.name)?.lastUsedAt));
  const usesOf = (b: SecretsBundle): number => usage?.get(b.name)?.uses ?? 0;
  const out = [...bundles];
  if (field === 'name') return out.sort(byName);
  out.sort((a, z) => {
    if (field === 'expiry') {
      const d = soonestExpiry(a) - soonestExpiry(z);
      return d !== 0 ? d : byName(a, z);
    }
    if (field === 'used') {
      const d = usedMs(z) - usedMs(a);
      return d !== 0 ? d : byName(a, z);
    }
    if (field === 'uses') {
      const d = usesOf(z) - usesOf(a);
      return d !== 0 ? d : byName(a, z);
    }
    const key = field === 'created' ? 'created_at' : 'updated_at';
    const d = stamp(z[key]) - stamp(a[key]);
    return d !== 0 ? d : byName(a, z);
  });
  return out;
}

/** Human summary of the active filters, for the empty state. `sessions` only
 * echoes --project/--all on a miss, which leaves you guessing which flag emptied
 * the list; naming every active axis is the difference between "nothing matched"
 * and knowing what to relax. */
export function describeFilter(f: SecretsListFilter): string {
  const parts: string[] = [];
  if (f.query) parts.push(`matching "${f.query}"`);
  if (f.policy) parts.push(`policy ${f.policy.join('/')}`);
  if (f.backend) parts.push(`backend ${f.backend.join('/')}`);
  if (f.type) parts.push(`type ${f.type.join('/')}`);
  if (f.kind) parts.push(`kind ${f.kind.join('/')}`);
  if (f.held === true) parts.push('currently held');
  if (f.held === false) parts.push('not currently held');
  if (f.expired) parts.push('with an expired key');
  if (f.expiringDays !== undefined) parts.push(`expiring within ${f.expiringDays}d`);
  if (f.unusedBefore !== undefined) parts.push('unused since the given cutoff');
  return parts.join(', ');
}
