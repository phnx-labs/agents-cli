/**
 * Named project definitions — the layer above the `--project <slug>` convention.
 *
 * `agents run --project <slug>` already resolves a bare name to a working
 * directory by pure convention (`<projectRoot>/<slug>`, see `project-root.ts`).
 * This module adds editable definitions on top: one YAML file per project under
 * `~/.agents/projects/<name>.yaml`, sitting beside the existing `routines/`,
 * `monitors/`, and `teams/` dirs in the user repo.
 *
 * That location makes definitions SYNCABLE, not automatically synced: they ride
 * the user repo only once they are committed to it, via `agents repo push user`
 * (`agents push` was removed). Until then the directory is untracked, and a
 * reconcile that cleans the working tree deletes it — observed twice on one
 * machine, taking four definitions with it each time. The recovery is an
 * orphaned `chore(local): save …-sync drift` commit, which is not a guarantee:
 * unreachable objects are collected. Say "commit them" rather than "for free".
 *
 * A defined project can name itself
 * independently of its folder, bind more than one repo, pin a monorepo subpath,
 * describe context subdirectories an agent should start from, carry a Linear
 * link and external integrations, and set an explicit default path.
 *
 * Portable by construction: `root`/`defaultPath` are stored home-relative
 * (`~/…`) via `toHomeRelative`, so the same definition re-roots on any machine
 * whose home differs — the exact mechanism `project-root.ts` already relies on.
 *
 * Resolution stays additive: an undefined slug still resolves exactly as today
 * (see `resolveProjectRef`), a defined one overrides it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getProjectsDir } from './state.js';
import { safeJoin } from './paths.js';
import { toHomeRelative, expandLocalHome } from './project-root.js';
import { resolveProjectKey } from './project-key.js';
import { atomicWriteFileSync } from './fs-atomic.js';

/** A git repo bound to a project, with an optional monorepo subpath. */
export interface ProjectRepo {
  /** GitHub slug `owner/repo`. */
  slug: string;
  /** Optional path within the repo an agent working this project cares about. */
  subpath?: string;
  /**
   * Optional home-relative local checkout of this repo. The def's `root` only
   * knows the primary repo on disk; `path` opts an additional repo into
   * workspace probing (`projects status`).
   */
  path?: string;
}

/**
 * A described context anchor: a subdirectory plus what it is. Agents starting on
 * the project read `purpose` to know where to look — an indexed starting point,
 * not just a path. This is the richer form of the single monorepo-focus dir.
 */
export interface ProjectContext {
  /** Path relative to the project root (e.g. `apps/web`). */
  path: string;
  /** One line on how this subtree relates to the project. */
  purpose: string;
}

/**
 * A project goal — the OKR-shaped "why". A project serves one or more goals: a
 * qualitative `objective` ("Ship agents-cli 2.0") and an optional `measure`, the
 * key result that says whether it's landing ("fleet on 2.x", "p95 < 200ms"). The
 * goal is the outcome the work is chasing; milestones (dated checkpoints, pulled
 * from Linear) and live work (agents / PRs / artifacts) are how far along it is.
 */
export interface ProjectGoal {
  /** The outcome, in a line. */
  objective: string;
  /** Optional key result — how success is measured. */
  measure?: string;
}

/** An external context source hung off the project (surfaced in `projects show`). */
export interface ProjectIntegration {
  /** e.g. `gdrive`, `notion`, `figma`, `url`. */
  kind: string;
  url: string;
  label?: string;
}

/** The parsed `~/.agents/projects/<name>.yaml`. */
export interface ProjectDef {
  /** Stable id; matches the filename; what `--project` takes. */
  name: string;
  description?: string;
  /** Repo / monorepo root, home-relative for portability. */
  root?: string;
  /** Where an agent's cwd lands. Defaults to `root` when unset. */
  defaultPath?: string;
  /** Primary GitHub slug (`owner/repo`) — for PR / CI / status roll-up. */
  repo?: string;
  /** All bound repos, each with an optional monorepo subpath. */
  repos?: ProjectRepo[];
  /** Described starting points inside the project. */
  contexts?: ProjectContext[];
  /** The outcomes this project serves (OKR-shaped); a project may have several. */
  goals?: ProjectGoal[];
  /** External context sources (Drive, docs, …). */
  integrations?: ProjectIntegration[];
  /** Linear project link — reuses the existing GraphQL path. */
  linear?: { projectId?: string; url?: string; name?: string };
  /** Free-form doc links surfaced in `projects show`. */
  docs?: string[];
  /**
   * Auto-dispatch settings. When `enabled` is true and `maxAgents > 0` and the
   * project has a `linear.projectId`, the daemon polls Linear for delegated-Todo
   * tickets and dispatches them up to the concurrency cap.
   */
  dispatch?: {
    /** Opt-in: enable auto-dispatch for this project (default: off). */
    enabled?: boolean;
    /** Per-project concurrency cap for auto-dispatched agents. */
    maxAgents?: number;
    /** Optional provider pin: 'rush' | 'codex' | 'factory' | 'host' | … */
    provider?: string;
    /** For provider='host': which machine to dispatch onto (name/device/cap tag). */
    host?: string;
  };
}

/** A project name safe to use as a filename: no separators, `..`, or leading dot. */
export function isSafeProjectName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

/** Absolute path to a project's YAML definition. Throws on an unsafe name. */
export function projectDefPath(name: string): string {
  if (!isSafeProjectName(name)) {
    throw new Error(`Invalid project name: "${name}" (letters, digits, ., _, - only)`);
  }
  return safeJoin(getProjectsDir(), `${name}.yaml`);
}

/**
 * Validate a raw parsed object into a `ProjectDef`, throwing an actionable error
 * on the first problem. A malformed document or identity (bad/mismatched name)
 * throws; malformed entries inside the optional lists (`repos`/`contexts`/
 * `integrations`) are dropped so one bad row can't sink an otherwise good def.
 */
export function validateProjectDef(raw: unknown, sourceName?: string): ProjectDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Project ${sourceName ?? ''} is not a YAML mapping`.trim());
  }
  const o = raw as Record<string, unknown>;
  // The filename is the identity; a `name:` field is optional but, when present,
  // must be a valid slug — a malformed one is a loud error, not a silent fallback.
  const hasNameField = 'name' in o && o.name !== undefined && o.name !== null;
  let name: string | undefined;
  if (hasNameField) {
    if (typeof o.name !== 'string' || !isSafeProjectName(o.name)) {
      throw new Error(`Project ${sourceName ?? ''}: "name" must be a valid slug (got ${JSON.stringify(o.name)})`);
    }
    name = o.name;
  } else {
    name = sourceName;
  }
  if (!name || !isSafeProjectName(name)) {
    throw new Error('Project definition is missing a valid "name"');
  }
  // The filename IS the stable id — a def whose `name:` disagrees with its
  // filename would resolve under one name and list under another.
  if (hasNameField && sourceName && name !== sourceName) {
    throw new Error(`Project ${sourceName}: "name" (${JSON.stringify(name)}) must match the filename — the filename is the stable id`);
  }

  const def: ProjectDef = { name };
  if (typeof o.description === 'string') def.description = o.description;
  if (typeof o.root === 'string') def.root = o.root;
  if (typeof o.defaultPath === 'string') def.defaultPath = o.defaultPath;
  if (typeof o.repo === 'string') def.repo = o.repo;

  if (Array.isArray(o.repos)) {
    def.repos = o.repos.flatMap((r) => {
      if (r && typeof r === 'object' && typeof (r as Record<string, unknown>).slug === 'string') {
        const rr = r as Record<string, unknown>;
        // A malformed `path` sinks the whole entry, like any other malformed
        // list row — a half-valid repo must not probe a surprising location.
        if (rr.path !== undefined && typeof rr.path !== 'string') return [];
        const repo: ProjectRepo = { slug: rr.slug as string };
        if (typeof rr.subpath === 'string') repo.subpath = rr.subpath;
        if (typeof rr.path === 'string') repo.path = rr.path;
        return [repo];
      }
      return [];
    });
  }
  if (Array.isArray(o.contexts)) {
    def.contexts = o.contexts.flatMap((c) => {
      if (
        c &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).path === 'string' &&
        typeof (c as Record<string, unknown>).purpose === 'string'
      ) {
        const cc = c as Record<string, unknown>;
        return [{ path: cc.path as string, purpose: cc.purpose as string }];
      }
      return [];
    });
  }
  if (Array.isArray(o.goals)) {
    def.goals = o.goals.flatMap((g) => {
      if (g && typeof g === 'object' && typeof (g as Record<string, unknown>).objective === 'string') {
        const gg = g as Record<string, unknown>;
        const goal: ProjectGoal = { objective: gg.objective as string };
        if (typeof gg.measure === 'string') goal.measure = gg.measure;
        return [goal];
      }
      return [];
    });
  }
  if (Array.isArray(o.integrations)) {
    def.integrations = o.integrations.flatMap((i) => {
      if (
        i &&
        typeof i === 'object' &&
        typeof (i as Record<string, unknown>).kind === 'string' &&
        typeof (i as Record<string, unknown>).url === 'string'
      ) {
        const ii = i as Record<string, unknown>;
        const integ: ProjectIntegration = { kind: ii.kind as string, url: ii.url as string };
        if (typeof ii.label === 'string') integ.label = ii.label;
        return [integ];
      }
      return [];
    });
  }
  if (o.linear && typeof o.linear === 'object' && !Array.isArray(o.linear)) {
    const l = o.linear as Record<string, unknown>;
    def.linear = {};
    if (typeof l.projectId === 'string') def.linear.projectId = l.projectId;
    if (typeof l.url === 'string') def.linear.url = l.url;
    if (typeof l.name === 'string') def.linear.name = l.name;
  }
  if (Array.isArray(o.docs)) def.docs = o.docs.filter((d): d is string => typeof d === 'string');

  if (o.dispatch && typeof o.dispatch === 'object' && !Array.isArray(o.dispatch)) {
    const d = o.dispatch as Record<string, unknown>;
    def.dispatch = {};
    if (d.enabled === true || d.enabled === false) def.dispatch.enabled = d.enabled;
    if (typeof d.maxAgents === 'number' && Number.isFinite(d.maxAgents)) def.dispatch.maxAgents = d.maxAgents;
    if (typeof d.provider === 'string') def.dispatch.provider = d.provider;
    if (typeof d.host === 'string') def.dispatch.host = d.host;
  }

  return def;
}

/**
 * Load a single project definition by name. Returns undefined when the file is
 * absent (the common "not a defined project, fall back to convention" case) but
 * throws when a file EXISTS and is malformed — a broken definition is loud.
 */
export function loadProjectDef(name: string): ProjectDef | undefined {
  if (!isSafeProjectName(name)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(projectDefPath(name), 'utf8');
  } catch {
    return undefined; // absent — not a defined project
  }
  return validateProjectDef(yaml.parse(raw), name);
}

/**
 * List every defined project, sorted by name. Skips (does not throw on) a
 * malformed file so one bad definition can't break `projects list`; the loader
 * for a single named project stays strict.
 */
export function listProjectDefs(): ProjectDef[] {
  let files: string[];
  try {
    // Definitions are `<name>.yaml` (what projectDefPath/loadProjectDef read). We
    // deliberately do NOT list `.yml` here — accepting it would then ENOENT in the
    // loader and silently drop the project. One extension, one code path.
    files = fs.readdirSync(getProjectsDir()).filter((f) => f.endsWith('.yaml'));
  } catch {
    return [];
  }
  const out: ProjectDef[] = [];
  for (const f of files) {
    const name = f.replace(/\.yaml$/, '');
    try {
      const def = loadProjectDef(name);
      if (def) out.push(def);
    } catch {
      /* malformed — skip in the listing */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Persist a project definition, normalizing `root`/`defaultPath` to home-relative
 * so it stays portable across machines. Creates the projects dir on first write.
 * Writes via temp+rename so readers never see a partial file.
 */
export function writeProjectDef(def: ProjectDef): string {
  const validated = validateProjectDef(def, def.name);
  const normalized: ProjectDef = {
    ...validated,
    root: validated.root ? toHomeRelative(expandLocalHome(validated.root)) : undefined,
    defaultPath: validated.defaultPath
      ? toHomeRelative(expandLocalHome(validated.defaultPath))
      : undefined,
    repos: validated.repos?.map((r) => {
      const repo: ProjectRepo = { ...r };
      if (r.path) repo.path = toHomeRelative(expandLocalHome(r.path));
      return repo;
    }),
  };
  // Drop undefined keys so the YAML stays clean.
  const clean = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== undefined),
  );
  const target = projectDefPath(def.name);
  fs.mkdirSync(getProjectsDir(), { recursive: true });
  atomicWriteFileSync(target, yaml.stringify(clean), 'utf8');
  return target;
}

/** Delete a project definition. Returns true if a file was removed. Never touches the repo. */
export function removeProjectDef(name: string): boolean {
  try {
    fs.unlinkSync(projectDefPath(name));
    return true;
  } catch {
    return false;
  }
}

/**
 * The cwd an agent lands in for a defined project: `defaultPath` when set, else
 * `root`. Home-relative when `forRemote` (the remote shell expands `~`), else
 * expanded against the local home. Returns undefined when neither is set.
 */
export function projectBasePath(def: ProjectDef, forRemote: boolean): string | undefined {
  const base = def.defaultPath ?? def.root;
  if (!base) return undefined;
  return forRemote ? base : expandLocalHome(base);
}

/** A project plus its repo root as an absolute local path, for cwd matching. */
interface ProjectRootAbs {
  name: string;
  /**
   * One absolute, normalized path this project claims. A project contributes
   * SEVERAL — its root, its monorepo subdir, and each bound repo's checkout and
   * subpath — so the most specific claim can win over a broader one.
   */
  abs: string;
  /**
   * A fallback claim, used only when no ordinary claim matches. The root of a
   * project that narrowed itself with `defaultPath` is weak: it should lose the
   * shared monorepo root to an umbrella project, yet still cover its own repo
   * when no other project claims it.
   */
  weak?: boolean;
}

function projectRootsAbs(defs: ProjectDef[]): ProjectRootAbs[] {
  const out: ProjectRootAbs[] = [];
  const push = (name: string, raw: string | undefined) => {
    if (!raw) return;
    out.push({ name, abs: path.resolve(expandLocalHome(raw)) });
  };
  for (const def of defs) {
    // `root` says where the CHECKOUT is; `defaultPath` says which work is this
    // project's. For a monorepo subproject those differ, and only the narrower
    // one is a membership claim — a project scoped to `rush/apps/cli` does not
    // own `rush/apps/web`.
    //
    // The old `root ?? defaultPath` collapsed such a subproject onto the
    // monorepo root, the same path its umbrella anchors at, so the longest-match
    // tiebreak below had nothing to separate them and a session in
    // `rush/apps/cli` counted toward whichever definition was listed first.
    const rootAbs = def.root ? path.resolve(expandLocalHome(def.root)) : undefined;
    const defaultAbs = def.defaultPath ? path.resolve(expandLocalHome(def.defaultPath)) : undefined;
    const narrowed = !!(rootAbs && defaultAbs && defaultAbs !== rootAbs && isUnder(defaultAbs, rootAbs));
    // A narrowed project's root is a WEAK claim: it still covers the rest of the
    // checkout when nobody else wants it, but yields to any project that claims
    // a path outright. Dropping it entirely regressed the single-project case —
    // `add foo --root ~/src/foo --path apps/web` stopped attributing work
    // anywhere else in its own repo, and `--path` means where agents START, not
    // which work counts.
    if (rootAbs) out.push({ name: def.name, abs: rootAbs, weak: narrowed });
    if (defaultAbs && defaultAbs !== rootAbs) out.push({ name: def.name, abs: defaultAbs });
    for (const r of def.repos ?? []) {
      push(def.name, r.path);
      // A repo pinned to a monorepo subpath anchors at that subpath too.
      if (r.path && r.subpath) push(def.name, path.join(expandLocalHome(r.path), r.subpath));
    }
  }
  return out;
}

/** True when `child` is `parent` or nested under it (path-segment aware). */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/**
 * Which defined project a session belongs to, derived from its working
 * directory. A session whose `cwd` sits inside a project's repo root (or a
 * worktree under it) is a member; the LONGEST matching root wins so a nested
 * project beats its parent. Returns undefined when no definition contains the
 * path.
 *
 * The comparison is against the LOCAL home: roots and the cwd are both expanded
 * with `expandLocalHome` and resolved, so this matches sessions whose cwd shares
 * this machine's home layout. A session recorded on a different-home machine
 * (`/Users/x/…` vs `/home/x/…`) will not match until the fleet-wide,
 * home-relative variant lands (see the deferred item in docs/11-projects.md).
 */
export function projectNameForCwd(cwd: string | undefined, defs: ProjectDef[]): string | undefined {
  if (!cwd) return undefined;
  const abs = path.resolve(expandLocalHome(cwd));
  let best: string | undefined;
  let bestLen = -1;
  let weakBest: string | undefined;
  let weakLen = -1;
  for (const { name, abs: root, weak } of projectRootsAbs(defs)) {
    if (!isUnder(abs, root)) continue;
    if (weak) {
      if (root.length > weakLen) {
        weakBest = name;
        weakLen = root.length;
      }
    } else if (root.length > bestLen) {
      best = name;
      bestLen = root.length;
    }
  }
  return best ?? weakBest;
}

/**
 * The canonical project label for a cwd, for every surface that buckets work by
 * project (the activity timeline, feed posts, the sessions overview): the
 * DEFINED project whose root contains the cwd (longest root wins, so a
 * multi-repo project reads as one bucket), else the repository-level key from
 * {@link resolveProjectKey}. `defs` comes from {@link listProjectDefs}, which is
 * fail-open — with no definitions this degrades to exactly today's behavior.
 */
export function resolveProjectNameForCwd(cwd: string | undefined | null, defs: ProjectDef[]): string | undefined {
  if (!cwd) return undefined;
  return projectNameForCwd(cwd, defs) ?? resolveProjectKey(cwd);
}

/**
 * Resolve a defined project's ref to a working directory, mirroring
 * `buildProjectPath`'s `forRemote` contract (a home-relative `~/…` for the
 * remote shell to expand, an absolute local path otherwise). A `@worktree`
 * lands under the repo ROOT's `.agents/worktrees/`, not the `defaultPath`
 * subdir — worktrees are per-repo, not per-focus. Returns undefined when the
 * definition carries no `root`/`defaultPath` (caller falls back to convention).
 */
export function resolveDefinedProjectPath(
  def: ProjectDef,
  worktree: string | undefined,
  forRemote: boolean,
): string | undefined {
  if (worktree) {
    const rootRaw = def.root ?? def.defaultPath;
    if (!rootRaw) return undefined;
    const wt = `${rootRaw}/.agents/worktrees/${worktree}`;
    return forRemote ? wt : path.resolve(expandLocalHome(wt));
  }
  const base = projectBasePath(def, forRemote);
  if (!base) return undefined;
  return forRemote ? base : path.resolve(base);
}
