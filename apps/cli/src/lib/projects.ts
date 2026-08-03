/**
 * Named project definitions — the layer above the `--project <slug>` convention.
 *
 * `agents run --project <slug>` already resolves a bare name to a working
 * directory by pure convention (`<projectRoot>/<slug>`, see `project-root.ts`).
 * This module adds editable definitions on top: one YAML file per project under
 * `~/.agents/projects/<name>.yaml`, sitting beside the existing `routines/`,
 * `monitors/`, and `teams/` dirs in the user repo (so definitions sync across
 * machines for free via `agents push/pull`). A defined project can name itself
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
import * as yaml from 'yaml';
import { getProjectsDir } from './state.js';
import { safeJoin } from './paths.js';
import { toHomeRelative, expandLocalHome } from './project-root.js';

/** A git repo bound to a project, with an optional monorepo subpath. */
export interface ProjectRepo {
  /** GitHub slug `owner/repo`. */
  slug: string;
  /** Optional path within the repo an agent working this project cares about. */
  subpath?: string;
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
  /** External context sources (Drive, docs, …). */
  integrations?: ProjectIntegration[];
  /** Linear project link — reuses the existing GraphQL path. */
  linear?: { projectId?: string; url?: string };
  /** Free-form doc links surfaced in `projects show`. */
  docs?: string[];
  /** Preferred hosts for runs/routines (phase 2). */
  devices?: string[];
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
 * on the first problem. Fail loud at the boundary — a malformed definition is a
 * bug to surface, never a silent partial load.
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

  const def: ProjectDef = { name };
  if (typeof o.description === 'string') def.description = o.description;
  if (typeof o.root === 'string') def.root = o.root;
  if (typeof o.defaultPath === 'string') def.defaultPath = o.defaultPath;
  if (typeof o.repo === 'string') def.repo = o.repo;

  if (Array.isArray(o.repos)) {
    def.repos = o.repos.flatMap((r) => {
      if (r && typeof r === 'object' && typeof (r as Record<string, unknown>).slug === 'string') {
        const rr = r as Record<string, unknown>;
        const repo: ProjectRepo = { slug: rr.slug as string };
        if (typeof rr.subpath === 'string') repo.subpath = rr.subpath;
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
  }
  if (Array.isArray(o.docs)) def.docs = o.docs.filter((d): d is string => typeof d === 'string');
  if (Array.isArray(o.devices)) def.devices = o.devices.filter((d): d is string => typeof d === 'string');

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
    files = fs.readdirSync(getProjectsDir()).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    return [];
  }
  const out: ProjectDef[] = [];
  for (const f of files) {
    const name = f.replace(/\.ya?ml$/, '');
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
 */
export function writeProjectDef(def: ProjectDef): string {
  const validated = validateProjectDef(def, def.name);
  const normalized: ProjectDef = {
    ...validated,
    root: validated.root ? toHomeRelative(expandLocalHome(validated.root)) : undefined,
    defaultPath: validated.defaultPath
      ? toHomeRelative(expandLocalHome(validated.defaultPath))
      : undefined,
  };
  // Drop undefined keys so the YAML stays clean.
  const clean = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== undefined),
  );
  const target = projectDefPath(def.name);
  fs.mkdirSync(getProjectsDir(), { recursive: true });
  fs.writeFileSync(target, yaml.stringify(clean), 'utf8');
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
