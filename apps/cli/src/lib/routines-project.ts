/**
 * Project-level routine opt-in, source tracking, and user-layer sync.
 *
 * Project YAML under `<project>/.agents/routines/*.yml` is inspection-only by
 * default (a cloned public repo must never auto-fire agent prompts). After an
 * explicit opt-in, routines are materialised into `~/.agents/routines/` with
 * `source:` provenance so the daemon — which only loads user + system layers —
 * can fire them. `syncProjectRoutines` refreshes the user-layer copies when
 * project YAML changes (also invoked on daemon SIGHUP).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { execFileSync } from 'child_process';
import {
  getProjectAgentsDir,
  getProjectRoutinesDir,
  readMeta,
  updateMeta,
  ensureAgentsDir,
} from './state.js';
import {
  type JobConfig,
  type JobSource,
  readJob,
  writeJob,
  deleteJob,
  listJobs,
  validateJob,
  resolveHostStrategy,
  placementRequiresFiringPin,
} from './routines.js';
import { parseOwnerRepoFromRemote } from './registry.js';
import { machineId } from './machine-id.js';
import { isSafeSegmentName } from './paths.js';

/** Expand `~/…` and resolve to an absolute path. */
export function expandProjectPath(p: string): string {
  const trimmed = p.trim();
  if (trimmed.startsWith('~/') || trimmed === '~') {
    return path.resolve(trimmed.replace(/^~(?=$|[/\\])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

/** Store paths home-relative when under $HOME so they travel across machines. */
export function displayProjectPath(abs: string): string {
  const home = os.homedir();
  const resolved = path.resolve(abs);
  if (resolved === home) return '~';
  if (resolved.startsWith(home + path.sep)) {
    return '~' + resolved.slice(home.length);
  }
  return resolved;
}

/** Project roots currently opted into daemon firing (absolute paths). */
export function listEnabledProjectRoots(): string[] {
  const meta = readMeta();
  const raw = meta.routines?.projects ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (typeof p !== 'string' || p.trim() === '') continue;
    const abs = expandProjectPath(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** True when this project root is on the opt-in allowlist. */
export function isProjectRoutinesEnabled(projectRoot: string): boolean {
  const abs = expandProjectPath(projectRoot);
  return listEnabledProjectRoots().some((p) => p === abs);
}

/**
 * True when the project's own `agents.yaml` opts into project routines:
 * `routines: { enable: true }`. This is an additional source of opt-in that
 * still requires the project to be present on disk; it does not auto-enable
 * every clone — the project must declare it, and `sync` / `enable-project`
 * still materialises consent into the user layer.
 */
export function projectAgentsYamlEnablesRoutines(projectRoot: string): boolean {
  const agentsYaml = path.join(expandProjectPath(projectRoot), 'agents.yaml');
  if (!fs.existsSync(agentsYaml)) return false;
  try {
    const parsed = yaml.parse(fs.readFileSync(agentsYaml, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return false;
    const routines = (parsed as Record<string, unknown>).routines;
    if (!routines || typeof routines !== 'object') return false;
    return (routines as Record<string, unknown>).enable === true;
  } catch {
    return false;
  }
}

/** Resolve the project root (parent of `.agents/`) from a cwd, or null. */
export function resolveProjectRoot(cwd: string = process.cwd()): string | null {
  const agentsDir = getProjectAgentsDir(cwd);
  if (!agentsDir) return null;
  return path.dirname(agentsDir);
}

/**
 * Opt a project root into daemon firing. Returns true when newly added,
 * false when it was already enabled.
 */
export function enableProjectRoutines(projectRoot: string): boolean {
  const abs = expandProjectPath(projectRoot);
  const stored = displayProjectPath(abs);
  let added = false;
  updateMeta((meta) => {
    const projects = [...(meta.routines?.projects ?? [])];
    const already = projects.some((p) => expandProjectPath(p) === abs);
    if (already) return meta;
    projects.push(stored);
    added = true;
    return {
      ...meta,
      routines: {
        ...(meta.routines ?? {}),
        projects,
      },
    };
  });
  return added;
}

/**
 * Remove a project root from the opt-in allowlist. Optionally deletes the
 * user-layer copies that were materialised from it.
 */
export function disableProjectRoutines(
  projectRoot: string,
  opts: { removeSynced?: boolean } = {},
): { removed: boolean; deletedJobs: string[] } {
  const abs = expandProjectPath(projectRoot);
  let removed = false;
  updateMeta((meta) => {
    const projects = meta.routines?.projects ?? [];
    const next = projects.filter((p) => expandProjectPath(p) !== abs);
    if (next.length === projects.length) return meta;
    removed = true;
    return {
      ...meta,
      routines: {
        ...(meta.routines ?? {}),
        projects: next,
      },
    };
  });

  const deletedJobs: string[] = [];
  if (opts.removeSynced) {
    for (const job of listJobs()) {
      if (job.source?.kind === 'project' && expandProjectPath(job.source.projectPath) === abs) {
        if (deleteJob(job.name)) deletedJobs.push(job.name);
      }
    }
  }
  return { removed, deletedJobs };
}

/** Git provenance for a project root (best-effort; never throws). */
export function readProjectGitSource(projectRoot: string): Pick<JobSource, 'repo' | 'branch' | 'commit'> {
  const abs = expandProjectPath(projectRoot);
  const out: Pick<JobSource, 'repo' | 'branch' | 'commit'> = {};
  try {
    const remote = execFileSync('git', ['-C', abs, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    const repo = parseOwnerRepoFromRemote(remote);
    if (repo) out.repo = repo;
  } catch { /* no origin */ }
  try {
    out.branch = execFileSync('git', ['-C', abs, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    if (out.branch === 'HEAD') delete out.branch; // detached
  } catch { /* not a git repo */ }
  try {
    out.commit = execFileSync('git', ['-C', abs, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch { /* ignore */ }
  return out;
}

/** List project routine YAML files (name + absolute path). */
export function listProjectRoutineFiles(projectRoot: string): Array<{ name: string; path: string }> {
  const routinesDir = getProjectRoutinesDir(expandProjectPath(projectRoot));
  if (!routinesDir || !fs.existsSync(routinesDir)) return [];
  return fs.readdirSync(routinesDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({
      name: f.replace(/\.ya?ml$/, ''),
      path: path.join(routinesDir, f),
    }))
    .filter((e) => isSafeSegmentName(e.name));
}

function readProjectJobFile(filePath: string): JobConfig | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(parsed, 'device')) return null;
    return {
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
    } as JobConfig;
  } catch {
    return null;
  }
}

export interface SyncProjectResult {
  projectRoot: string;
  synced: string[];
  skipped: Array<{ name: string; reason: string }>;
  removed: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Materialise one project's routines into the user layer.
 * - Overwrites user copies that already carry matching `source.projectPath`
 * - Never clobbers a hand-authored user routine (no source / different source)
 * - Removes user copies from this project whose YAML disappeared
 * - Auto-pins `devices` for host/fleet/cloud placement when unset
 */
export function syncProjectRoutines(projectRoot: string): SyncProjectResult {
  ensureAgentsDir();
  const abs = expandProjectPath(projectRoot);
  const git = readProjectGitSource(abs);
  const source: JobSource = {
    kind: 'project',
    projectPath: abs,
    ...(git.repo ? { repo: git.repo } : {}),
    ...(git.branch ? { branch: git.branch } : {}),
    ...(git.commit ? { commit: git.commit } : {}),
  };

  const result: SyncProjectResult = {
    projectRoot: abs,
    synced: [],
    skipped: [],
    removed: [],
    errors: [],
  };

  const files = listProjectRoutineFiles(abs);
  const seenNames = new Set<string>();

  for (const file of files) {
    seenNames.add(file.name);
    const job = readProjectJobFile(file.path);
    if (!job) {
      result.errors.push({ name: file.name, error: 'unreadable or invalid YAML' });
      continue;
    }

    const existing = readJob(file.name);
    if (existing) {
      const existingSource = existing.source;
      const fromThisProject = existingSource?.kind === 'project'
        && expandProjectPath(existingSource.projectPath) === abs;
      if (!fromThisProject) {
        result.skipped.push({
          name: file.name,
          reason: existingSource
            ? `user-layer routine already exists from another source (${existingSource.projectPath})`
            : 'user-layer routine already exists (hand-authored); not overwriting without source match',
        });
        continue;
      }
      // Preserve user-layer devices pin when project YAML omits it (same overlay
      // semantics as listJobs project discovery).
      if (job.devices === undefined && existing.devices && existing.devices.length > 0) {
        job.devices = existing.devices;
      }
    }

    // Placement that leaves the firing machine must pin devices to avoid
    // every fleet daemon dispatching once.
    const strategy = resolveHostStrategy(job);
    if (placementRequiresFiringPin(strategy) && (!job.devices || job.devices.length === 0)) {
      job.devices = [machineId()];
    }

    // Surface repo for list/display when project has a GitHub origin.
    if (git.repo && !job.repo) job.repo = git.repo;
    job.source = source;
    job.name = file.name;

    const errors = validateJob(job);
    if (errors.length > 0) {
      result.errors.push({ name: file.name, error: errors.join('; ') });
      continue;
    }

    try {
      writeJob(job);
      result.synced.push(file.name);
    } catch (err) {
      result.errors.push({ name: file.name, error: (err as Error).message });
    }
  }

  // Drop user-layer copies from this project that no longer exist in project YAML.
  for (const job of listJobs()) {
    if (job.source?.kind !== 'project') continue;
    if (expandProjectPath(job.source.projectPath) !== abs) continue;
    if (seenNames.has(job.name)) continue;
    if (deleteJob(job.name)) result.removed.push(job.name);
  }

  return result;
}

export interface SyncAllResult {
  projects: SyncProjectResult[];
  /** Project roots that were listed but missing on disk. */
  missing: string[];
}

/**
 * Sync every project root on the user allowlist (`meta.routines.projects`),
 * plus any explicit `extraRoots`. Project `agents.yaml` `routines.enable`
 * alone never opts a path in — enable-project is required.
 */
export function syncAllProjectRoutines(opts: { extraRoots?: string[] } = {}): SyncAllResult {
  const roots = new Set<string>(listEnabledProjectRoots());
  for (const r of opts.extraRoots ?? []) roots.add(expandProjectPath(r));

  const projects: SyncProjectResult[] = [];
  const missing: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      missing.push(root);
      continue;
    }
    projects.push(syncProjectRoutines(root));
  }
  return { projects, missing };
}

/**
 * Discover project routines at cwd for the setup UX. Returns null when no
 * project `.agents/routines` dir exists.
 */
export function discoverProjectRoutinesAt(
  cwd: string = process.cwd(),
): { projectRoot: string; files: Array<{ name: string; path: string }>; enabled: boolean } | null {
  const projectRoot = resolveProjectRoot(cwd);
  if (!projectRoot) return null;
  const routinesDir = getProjectRoutinesDir(projectRoot);
  if (!routinesDir || !fs.existsSync(routinesDir)) return null;
  const files = listProjectRoutineFiles(projectRoot);
  if (files.length === 0) return null;
  return {
    projectRoot,
    files,
    enabled: isProjectRoutinesEnabled(projectRoot) || projectAgentsYamlEnablesRoutines(projectRoot),
  };
}

