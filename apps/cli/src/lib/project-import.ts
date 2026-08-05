/**
 * Pure builders behind `agents projects import`.
 *
 * Two sources feed the one `ProjectDef` schema: **Linear** (the preferred one —
 * a project someone deliberately created on the board) and the **Factory
 * registry** (`~/.agents/factory/projects.json`, an auto-detection that guesses
 * from checkouts on disk). Both funnel through `writeProjectDef`.
 *
 * The Factory registry stamps each row with a `confidence` — and importing every
 * row regardless is what buried the real projects under a dozen guesses
 * (`agents-cleaned-stale2`, a repo cloned from someone else's org, …). So the
 * import is gated on that field, `high` by default.
 *
 * Everything here is a pure function of its arguments — no fs, no shell, no
 * process env. The command layer reads the registry / shells out to `linear` and
 * hands the rows in; that's what makes these testable against plain fixtures
 * with no mocking. The one exception is `toHomeRelative`, a string rewrite
 * against `$HOME`.
 */

import { toHomeRelative } from './project-root.js';
import { isSafeProjectName, type ProjectDef } from './projects.js';
import { matchLocalCheckoutExact, type LinearProjectLite } from './linear-projects.js';

/** Factory's per-row detection confidence, weakest first. */
export type ImportConfidence = 'low' | 'medium' | 'high';

/**
 * The floor an import runs at. `any` is what `--all` means — it takes rows that
 * state no confidence at all, which rank below even `low`; without it "import
 * every row regardless of confidence" would quietly drop the unranked ones.
 */
export type ImportFloor = ImportConfidence | 'any';

const CONFIDENCE_RANK: Record<ImportFloor, number> = { any: 0, low: 1, medium: 2, high: 3 };

/** Rank a raw `confidence` value; anything absent or unrecognized ranks 0 (below every floor). */
function confidenceRank(raw: unknown): number {
  return typeof raw === 'string' ? (CONFIDENCE_RANK[raw as ImportConfidence] ?? 0) : 0;
}

/** A row the import declined to write, with the reason to print. */
export interface ImportSkip {
  name: string;
  reason: string;
}

/** What an import would write, and what it declined. */
export interface ImportPlan {
  defs: ProjectDef[];
  skipped: ImportSkip[];
}

/** The validated shape of the `import` flags. */
export interface ImportOptions {
  source: 'factory' | 'linear';
  /** Factory only: the lowest confidence that still imports. */
  minConfidence: ImportFloor;
  force: boolean;
}

/** The raw commander flags, before validation. */
export interface RawImportFlags {
  fromFactory?: boolean;
  fromLinear?: boolean;
  minConfidence?: string;
  all?: boolean;
  force?: boolean;
}

/**
 * Validate the flag combination, throwing a user-facing message on the first
 * problem. Every rejection is loud: an unrecognized `--min-confidence` is an
 * error, never a silent fall back to the default floor.
 */
export function validateImportOpts(flags: RawImportFlags): ImportOptions {
  const sources = [flags.fromFactory && 'factory', flags.fromLinear && 'linear'].filter(Boolean) as ('factory' | 'linear')[];
  if (sources.length === 0) throw new Error('Pick an import source: --from-linear or --from-factory.');
  if (sources.length > 1) throw new Error('--from-linear and --from-factory are mutually exclusive — pick one.');
  const source = sources[0];
  if (source === 'linear' && (flags.all || flags.minConfidence !== undefined)) {
    throw new Error('--all and --min-confidence apply to --from-factory only (Linear rows carry no confidence).');
  }
  if (flags.all && flags.minConfidence !== undefined) {
    throw new Error('--all and --min-confidence are mutually exclusive (--all means --min-confidence low).');
  }
  let minConfidence: ImportFloor = 'high';
  if (flags.all) minConfidence = 'any';
  else if (flags.minConfidence !== undefined) {
    const v = flags.minConfidence.trim().toLowerCase();
    if (v !== 'low' && v !== 'medium' && v !== 'high') {
      throw new Error(`Invalid --min-confidence "${flags.minConfidence}" (expected low, medium, or high).`);
    }
    minConfidence = v;
  }
  return { source, minConfidence, force: flags.force === true };
}

/**
 * Plan the Factory import: same field mapping as before (`path`→`root`,
 * `repoSlug`→`repo`, `linearProjectId`→`linear.projectId`), now gated on the
 * row's `confidence`. A row with no confidence field is a guess with no stated
 * strength, so it ranks below every floor and only `--all` takes it.
 *
 * `resolveRemote` reads the checkout's actual `origin` and OVERRIDES the row's
 * `repoSlug`. Factory derives that slug from the checkout path's last two
 * segments (`apps/factory/src/core/projectIndex.ts:19-26`), which is only right
 * when the directory tree happens to mirror the GitHub org. It commonly does
 * not: a checkout at `~/src/github.com/<you>/agents-cli` whose remote is
 * `phnx-labs/agents-cli` imported as `<you>/agents-cli` — a real, different
 * repo — so the card's merged-PR and release lines silently reported a
 * stranger's repository instead of failing. The remote is the only authority on
 * which repo a checkout is; the path is a guess about it.
 */
export function buildFactoryImportCandidates(
  rows: unknown[],
  existing: Map<string, ProjectDef>,
  opts: Pick<ImportOptions, 'minConfidence' | 'force'>,
  resolveRemote: (root: string) => string | undefined = () => undefined,
): ImportPlan {
  const floor = CONFIDENCE_RANK[opts.minConfidence];
  const defs: ProjectDef[] = [];
  const skipped: ImportSkip[] = [];
  // The registry keys rows by `owner/repo` but names them by basename, so two
  // repos with the same basename in different orgs (grinich/inflow, me/inflow)
  // arrive as two rows called `inflow`. Without this the second silently
  // overwrote the first on disk and the run still reported both as imported.
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : undefined;
    if (!name || !isSafeProjectName(name)) {
      skipped.push({ name: name || '(unnamed)', reason: 'not a usable project name' });
      continue;
    }
    const rank = confidenceRank(o.confidence);
    if (rank < floor) {
      const stated = typeof o.confidence === 'string' && o.confidence ? `confidence "${o.confidence}"` : 'no confidence field';
      skipped.push({ name, reason: `${stated} is below the "${opts.minConfidence}" floor` });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, reason: 'another row in this registry already claimed the name' });
      continue;
    }
    if (existing.has(name) && !opts.force) {
      skipped.push({ name, reason: 'already defined — pass --force to overwrite' });
      continue;
    }
    seen.add(name);
    const def: ProjectDef = { name };
    if (typeof o.path === 'string') def.root = toHomeRelative(o.path);
    // The checkout's own remote wins over the registry's path-derived guess;
    // the guess is the fallback for a path with no git remote to ask.
    const fromRemote = typeof o.path === 'string' ? resolveRemote(o.path) : undefined;
    const repo = fromRemote ?? (typeof o.repoSlug === 'string' ? o.repoSlug : undefined);
    if (repo) def.repo = repo;
    if (typeof o.linearProjectId === 'string') def.linear = { projectId: o.linearProjectId };
    defs.push(def);
  }
  return { defs, skipped };
}

/**
 * Turn a Linear project name into a definition slug: lowercase, every run of
 * unusable characters collapsed to one `-`, trimmed of leading/trailing
 * punctuation, capped at the 64 chars `isSafeProjectName` allows. Returns `''`
 * when nothing usable survives — the caller skips those loudly.
 */
export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64)
    .replace(/[-._]+$/g, '');
  return isSafeProjectName(slug) ? slug : '';
}

/** The local-checkout lookups the Linear builder needs, injected so it stays pure. */
export interface LinearImportDeps {
  /** Directory names directly under the configured projects root. */
  localDirs: string[];
  /** Home-relative root path for one of `localDirs`. */
  resolveRoot: (dir: string) => string | undefined;
  /** `owner/repo` from that checkout's origin remote, when it has one. */
  resolveOrigin: (dir: string) => string | undefined;
}

/**
 * Plan the Linear import. Every project becomes a def carrying its `linear`
 * link; the local checkout is bound **only on an exact normalized-name match**
 * (`matchLocalCheckoutExact`). The containment fallback that powers the `link`
 * suggestion is deliberately not used here — "Agents CLI" containing
 * "agents-cli-web" is a fine hint for a human to confirm, and a silently wrong
 * `root` on a write path.
 *
 * An existing def is preserved field-for-field; only `name` and `linear` are
 * overwritten, so a hand-set `description`/`contexts`/`integrations` survives a
 * re-import.
 */
export function buildLinearImportCandidates(
  projects: LinearProjectLite[],
  existing: Map<string, ProjectDef>,
  deps: LinearImportDeps,
  opts: Pick<ImportOptions, 'force'>,
): ImportPlan {
  const defs: ProjectDef[] = [];
  const skipped: ImportSkip[] = [];
  const seen = new Set<string>();
  for (const p of projects) {
    const name = slugifyProjectName(p.name);
    if (!name) {
      skipped.push({ name: p.name, reason: 'no usable project name (letters, digits, ., _, - only)' });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name: p.name, reason: `another Linear project already claimed the name "${name}"` });
      continue;
    }
    const prior = existing.get(name);
    if (prior && (prior.root || prior.repo) && !opts.force) {
      skipped.push({ name, reason: 'existing def already has root/repo — pass --force to relink' });
      continue;
    }
    seen.add(name);
    const def: ProjectDef = { ...prior, name, linear: { projectId: p.id } };
    if (p.url) def.linear!.url = p.url;
    const dir = matchLocalCheckoutExact(p.name, deps.localDirs);
    if (dir) {
      const root = deps.resolveRoot(dir);
      if (root) def.root = root;
      const repo = deps.resolveOrigin(dir);
      if (repo) def.repo = repo;
    }
    defs.push(def);
  }
  return { defs, skipped };
}
