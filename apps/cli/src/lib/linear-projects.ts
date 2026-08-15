// Linear project matching for `agents projects link --linear`.
//
// A project's identity shows up three ways — a Linear project name ("Agents CLI"),
// a GitHub repo slug ("phnx-labs/agents-cli"), and a filesystem folder
// (".../agents-cli"). normalizeProjectKey() collapses all three to one comparison
// key so they compare equal, and matchLinearProject() binds a repo/folder to the
// Linear project the user most likely means.
//
// Ported from apps/ext/src/core/linearProjects.ts (no cross-package imports —
// repo rule); keep the two in sync. The matcher half is PURE so it unit-tests
// without a live `linear` binary; the `linear projects --json` shell-out lives at
// the bottom (listLinearProjects) and fails LOUD — it's behind an explicit user
// command, not a best-effort card enrichment.

import { execFileSync } from 'child_process';

/** The minimal Linear project shape the link flow needs (id + name + url). */
export interface LinearProjectLite {
  id: string;
  name: string;
  /** Project URL, when the `linear` CLI JSON carries one. Never fabricated. */
  url?: string;
}

/**
 * Collapse a Linear name / repo slug / folder path to one comparison key:
 * lowercase, keep only the last path segment, strip separators.
 *   "Agents CLI"            -> "agentscli"
 *   "phnx-labs/agents-cli"  -> "agentscli"
 *   "~/src/.../agents-cli"  -> "agentscli"
 */
export function normalizeProjectKey(s: string): string {
  const last = s.toLowerCase().split('/').filter(Boolean).pop() ?? '';
  return last.replace(/[-_\s.]/g, '');
}

/**
 * Find the Linear project that best matches a repo slug or folder name.
 * Exact normalized match first, then a containment fallback (either direction),
 * so "agents-cli-web" still suggests "Agents CLI" when no exact peer exists.
 *
 * Kept for parity with the Factory original — the `link` command uses
 * {@link pickLinearProject} instead: this one returns the FIRST match (silent
 * on duplicate names), which is fine for a UI suggestion but never for a write
 * path.
 */
export function matchLinearProject(
  slugOrName: string,
  projects: LinearProjectLite[],
): LinearProjectLite | undefined {
  const key = normalizeProjectKey(slugOrName);
  if (!key) return undefined;
  const exact = projects.find((p) => normalizeProjectKey(p.name) === key);
  if (exact) return exact;
  return projects.find((p) => {
    const pk = normalizeProjectKey(p.name);
    return pk.length > 0 && (pk.includes(key) || key.includes(pk));
  });
}

/**
 * Collapse a Linear **display name** or a directory basename to one comparison
 * key. Deliberately NOT `normalizeProjectKey`: that one keeps only the segment
 * after the last `/`, which is right for an `owner/repo` slug or a filesystem
 * path and wrong for a display name, where `/` is ordinary punctuation. Keying
 * "Rush / Web" the path way yields `web`, which exact-matches an unrelated
 * `web/` checkout — the precise silent mis-binding this whole match path exists
 * to prevent.
 */
function checkoutMatchKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Find the local checkout directory a Linear project name refers to, on EXACT
 * key equality only — never containment. `matchLinearProject`'s containment
 * fallback is right for suggesting a link a human then confirms; this backs
 * `projects import --from-linear`, which writes `root`/`repo` with nobody
 * looking, and "Agents CLI" must not silently bind `agents-cli-web`.
 *
 * Returns `undefined` when nothing matches, and also when SEVERAL dirs key to
 * the same value (`agents-cli` and `agents_cli`) — an ambiguous match is not a
 * match.
 */
export function matchLocalCheckoutExact(name: string, dirNames: string[]): string | undefined {
  const key = checkoutMatchKey(name);
  if (!key) return undefined;
  const hits = dirNames.filter((d) => checkoutMatchKey(d) === key);
  return hits.length === 1 ? hits[0] : undefined;
}

/** The outcome of picking one Linear project out of the workspace list. */
export type LinearPick =
  | { kind: 'match'; project: LinearProjectLite }
  | { kind: 'candidates'; projects: LinearProjectLite[] }
  | { kind: 'none' };

/**
 * Pick the Linear project a query refers to. An exact id or exact normalized
 * name match is confident enough to write; anything weaker (several exact-name
 * peers, or only containment matches) comes back as a candidate LIST for the
 * user to disambiguate — the link command never guesses on a weak signal.
 */
export function pickLinearProject(query: string, projects: LinearProjectLite[]): LinearPick {
  const q = query.trim();
  if (!q) return { kind: 'none' };
  const byId = projects.find((p) => p.id === q);
  if (byId) return { kind: 'match', project: byId };
  const key = normalizeProjectKey(q);
  if (!key) return { kind: 'none' };
  const exact = projects.filter((p) => normalizeProjectKey(p.name) === key);
  if (exact.length === 1) return { kind: 'match', project: exact[0] };
  if (exact.length > 1) return { kind: 'candidates', projects: exact };
  const containment = projects.filter((p) => {
    const pk = normalizeProjectKey(p.name);
    return pk.length > 0 && (pk.includes(key) || key.includes(pk));
  });
  return containment.length > 0 ? { kind: 'candidates', projects: containment } : { kind: 'none' };
}

/**
 * List the workspace's Linear projects via the `linear` CLI on PATH. Throws a
 * clear error when the binary is missing, errors, or returns a shape we can't
 * use — this backs an explicit user command, so a silent empty list would send
 * the user down a wrong "no matches" path.
 */
export function listLinearProjects(): LinearProjectLite[] {
  let out: string;
  try {
    out = execFileSync('linear', ['projects', '--json'], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(
      'Could not list Linear projects — is the `linear` CLI installed and logged in? (`brew install linear-cli`, `linear auth login`)',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error('`linear projects --json` returned invalid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('`linear projects --json` did not return a list');
  return parsed.flatMap((x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.name === 'string') {
        const p: LinearProjectLite = { id: o.id, name: o.name };
        if (typeof o.url === 'string') p.url = o.url;
        return [p];
      }
    }
    return [];
  });
}

/**
 * The `linear` block a def should carry after binding it to `project`.
 *
 * Pure so the write rule is testable without a `linear` CLI or a filesystem —
 * `agents projects link` is the only caller and does nothing else to the field.
 *
 * Two rules, both learned from real drift:
 *
 * - `name` is REFRESHED, never merely preserved. It used to be written by
 *   spreading `prior`, so a project renamed on the board kept its old label in
 *   the YAML forever — and that label is what the status card, the AGI EXT
 *   Fleet panel (`linearProjectName`), and agents naming the work all read.
 * - `url` is dropped when the projectId CHANGES and the incoming row has none.
 *   Carrying it over would leave a def pointing at the previous project's page
 *   beside the new project's name, and the status card prefers `url` over the
 *   id — so the one field a reader clicks would go to the wrong project.
 *   Re-linking the SAME id keeps a previously stored url, since the CLI's list
 *   row omitting `url` says nothing about whether the project has one.
 */
export function nextLinearLink(
  prior: { projectId?: string; url?: string; name?: string } | undefined,
  project: LinearProjectLite,
): { projectId: string; url?: string; name: string } {
  const next: { projectId: string; url?: string; name: string } = { projectId: project.id, name: project.name };
  const relinked = Boolean(prior?.projectId) && prior?.projectId !== project.id;
  const url = project.url ?? (relinked ? undefined : prior?.url);
  if (url) next.url = url;
  return next;
}
