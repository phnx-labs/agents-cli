// Curated project store — AGI EXT is a thin shell over `agents projects`.
//
// Reads, saves, and deletes go ONLY through the CLI:
//   agents projects list --json
//   agents projects save --json   (one complete ProjectDef on stdin)
//   agents projects rm <name> --json
//
// Never read or write ~/.agents/projects/*.yaml directly. Never read or migrate
// ~/.agents/factory/projects.json — that legacy registry stays unread and
// untouched. Errors propagate so the VS Code host can show them inline.

import { homedir } from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { resolveAgentsBin, bootstrapPath, runAgents, AgentsBinNotFoundError } from './agentsBin';

/**
 * A curated project. The webview mirrors this shape field-for-field in
 * ui/settings/components/mission-control/floorModel.ts — keep them in sync.
 */
export interface ManagedProject {
  id: string;                                 // stable local id (= the project YAML slug)
  name: string;                               // label in sidebar + dispatch
  path: string;                               // absolute local folder (root/defaultPath — the FIRST bound directory)
  repoSlug?: string;                          // "owner/repo" (repos[0].slug — the FIRST bound directory's repo)
  dirs: ManagedProjectDir[];                  // every directory bound to this project, root/defaultPath first
  linearProjectId?: string;
  linearProjectName?: string;                 // for the Linear pill
  autoDispatch?: boolean;                     // opt-in: auto-pick delegated Todo tickets (default off)
  maxAgents?: number;                         // cap on concurrent auto-dispatched agents for this project
  confidence: 'high' | 'medium' | 'low';
  source: 'detected' | 'manual';
}

/** One directory bound to a project — a repo's checkout, optionally pinned to a monorepo subpath. */
export interface ManagedProjectDir {
  slug?: string;                              // "owner/repo", when this dir has a bound repo
  path: string;                               // absolute local folder for this dir (subpath already joined in)
}

/** Mirror of cli/src/lib/projects.ts isSafeProjectName — no path separators or dot-escapes. */
function isSafeId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(id) &&
    id !== '.' &&
    id !== '..'
  );
}

/** Basename of a path, with any trailing slash ignored. Used by settings.vscode.ts. */
export function projectNameFromPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Map a ProjectDef JSON shape (from `agents projects list --json`) to a ManagedProject. */
export function defToManaged(def: Record<string, unknown>): ManagedProject {
  const name = typeof def.name === 'string' ? def.name : '';
  const rootRaw =
    typeof def.root === 'string' ? def.root : typeof def.defaultPath === 'string' ? def.defaultPath : '';
  const expandedPath = rootRaw.startsWith('~/')
    ? path.join(homedir(), rootRaw.slice(2))
    : rootRaw;
  const linear =
    def.linear && typeof def.linear === 'object' && !Array.isArray(def.linear)
      ? (def.linear as Record<string, unknown>)
      : undefined;
  const dispatch =
    def.dispatch && typeof def.dispatch === 'object' && !Array.isArray(def.dispatch)
      ? (def.dispatch as Record<string, unknown>)
      : undefined;
  const repos = Array.isArray(def.repos) ? (def.repos as Array<Record<string, unknown>>) : [];
  const repoSlug =
    typeof def.repo === 'string'
      ? def.repo
      : typeof repos[0]?.slug === 'string'
        ? repos[0].slug
        : undefined;
  // Every directory bound to this project: the primary root/defaultPath first
  // (unchanged single-dir behavior for a project with no `repos[].path`), then
  // one row per repo that opted into its own local checkout via `path` (see
  // ProjectRepo.path in cli/src/lib/projects.ts) — `subpath` joined in so the
  // row is the exact folder an agent would cd into.
  const primaryDir = expandedPath ? { slug: repoSlug, path: expandedPath } : undefined;
  const extraDirs = repos
    .filter((r): r is Record<string, unknown> & { path: string } => typeof r.path === 'string' && r.path.length > 0)
    .map((r) => {
      const base = r.path.startsWith('~/') ? path.join(homedir(), r.path.slice(2)) : r.path;
      const abs = typeof r.subpath === 'string' && r.subpath ? path.join(base, r.subpath) : base;
      return { slug: typeof r.slug === 'string' ? r.slug : undefined, path: abs };
    })
    .filter((d) => d.path !== primaryDir?.path);
  const dirs = primaryDir ? [primaryDir, ...extraDirs] : extraDirs;
  return {
    id: name,
    name,
    path: expandedPath,
    repoSlug,
    dirs,
    linearProjectId: typeof linear?.projectId === 'string' ? linear.projectId : undefined,
    linearProjectName: typeof linear?.name === 'string' ? linear.name : undefined,
    autoDispatch: dispatch?.enabled === true,
    maxAgents: typeof dispatch?.maxAgents === 'number' ? dispatch.maxAgents : undefined,
    confidence: 'high',
    source: 'manual',
  };
}

/**
 * Build a complete ProjectDef JSON object for `agents projects save --json`.
 * Merges AGI EXT-managed fields onto any prior definition so unmanaged fields
 * (goals, contexts, integrations, docs, …) survive an edit from the Floor.
 */
export function managedToProjectDef(
  project: ManagedProject,
  prior?: Record<string, unknown>,
): Record<string, unknown> {
  const def: Record<string, unknown> = prior ? { ...prior } : {};
  def.name = project.id;

  const h = homedir();
  const homeRelPath =
    project.path && project.path.startsWith(h + '/')
      ? `~/${project.path.slice(h.length + 1)}`
      : project.path;
  if (homeRelPath) def.root = homeRelPath;
  else delete def.root;

  if (project.repoSlug) def.repo = project.repoSlug;
  else delete def.repo;

  const prevLinear =
    def.linear && typeof def.linear === 'object' && !Array.isArray(def.linear)
      ? { ...(def.linear as Record<string, unknown>) }
      : {};
  if (project.linearProjectId) prevLinear.projectId = project.linearProjectId;
  else delete prevLinear.projectId;
  if (project.linearProjectName) prevLinear.name = project.linearProjectName;
  else delete prevLinear.name;
  if (Object.keys(prevLinear).length > 0) def.linear = prevLinear;
  else delete def.linear;

  const prevDispatch =
    def.dispatch && typeof def.dispatch === 'object' && !Array.isArray(def.dispatch)
      ? { ...(def.dispatch as Record<string, unknown>) }
      : {};
  if (project.autoDispatch === true) prevDispatch.enabled = true;
  else if (project.autoDispatch === false) delete prevDispatch.enabled;
  if (project.maxAgents !== undefined) prevDispatch.maxAgents = project.maxAgents;
  if (Object.keys(prevDispatch).length > 0) def.dispatch = prevDispatch;
  else delete def.dispatch;

  // list --json may stamp a local `agents` count; never write it back into the def.
  delete def.agents;

  return def;
}

/** Run `agents <argv…>` with optional stdin. Surfaces CLI stderr on non-zero exit. */
async function runAgentsArgv(
  argv: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveAgentsBin();
  const augmented = bootstrapPath(bin);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, {
      env: { ...process.env, PATH: `${augmented}:${process.env.PATH ?? ''}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr || stdout || `exit ${code}`).trim();
      reject(new Error(detail || `agents ${argv.join(' ')} failed`));
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/**
 * Read the project list by shelling out to `agents projects list --json`.
 * Throws when the CLI is unavailable or returns unparseable output — callers
 * surface the message for inline UI display. Never reads YAML or the legacy
 * factory projects.json.
 */
export async function readManagedProjects(): Promise<ManagedProject[]> {
  const { stdout } = await runAgents('projects list --json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `agents projects list --json returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('agents projects list --json: expected a JSON array of ProjectDef objects');
  }
  return parsed
    .filter((d) => d && typeof d === 'object' && typeof (d as Record<string, unknown>).name === 'string')
    .map((d) => defToManaged(d as Record<string, unknown>));
}

/**
 * Resolve a local directory to its defined project slug via
 * `agents projects for-cwd <cwd> --json` — the CLI does the matching
 * (root and every repos[].path/subpath), never reimplemented here. Returns
 * undefined when nothing matches or the CLI call fails; a launch should fall
 * back to today's computed-cwd behavior rather than block on this.
 */
export async function resolveProjectForCwd(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await runAgentsArgv(['projects', 'for-cwd', cwd, '--json']);
    const parsed = JSON.parse(stdout) as { name?: string | null };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** Load raw ProjectDef objects from `agents projects list --json` (for merge-on-save). */
async function listRawDefs(): Promise<Record<string, unknown>[]> {
  const { stdout } = await runAgents('projects list --json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `agents projects list --json returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('agents projects list --json: expected a JSON array of ProjectDef objects');
  }
  return parsed.filter(
    (d): d is Record<string, unknown> =>
      !!d && typeof d === 'object' && !Array.isArray(d) && typeof (d as Record<string, unknown>).name === 'string',
  );
}

/**
 * Add a new project or update an existing one (matched by id) via
 * `agents projects save --json`. Returns the refreshed list.
 */
export async function upsertManagedProject(project: ManagedProject): Promise<ManagedProject[]> {
  if (!isSafeId(project.id)) throw new Error(`Unsafe project id: ${JSON.stringify(project.id)}`);
  const existing = await listRawDefs();
  const prior = existing.find((d) => d.name === project.id);
  const def = managedToProjectDef(project, prior);
  await runAgentsArgv(['projects', 'save', '--json'], JSON.stringify(def));
  return readManagedProjects();
}

/**
 * Remove a project by id via `agents projects rm <id> --json`. Returns the
 * refreshed list. Throws when the CLI reports failure.
 */
export async function deleteManagedProject(id: string): Promise<ManagedProject[]> {
  if (!isSafeId(id)) throw new Error(`Unsafe project id: ${JSON.stringify(id)}`);
  await runAgentsArgv(['projects', 'rm', id, '--json']);
  return readManagedProjects();
}

export { AgentsBinNotFoundError };
