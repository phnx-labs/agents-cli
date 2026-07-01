/**
 * Team registry.
 *
 * Manages the persistent registry of named teams stored at
 * ~/.agents/.history/teams/registry.json. This is per-machine runtime
 * state (timestamps + worktree paths that include absolute filesystem
 * paths) and intentionally lives under .history/ so it's NOT pulled in
 * by `agents repo push`.
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';
import { getTeamsRegistryPath } from '../state.js';
import { emit } from '../events.js';

/** Metadata for a registered team. */
export interface TeamMeta {
  created_at: string;
  description?: string;
  enable_worktrees?: boolean;
  /** Shared worktree path for all teammates (mutually exclusive with enable_worktrees). */
  use_worktree?: string;
}

/** Map of team name to team metadata. */
export type TeamRegistry = Record<string, TeamMeta>;

async function registryPath(): Promise<string> {
  return getTeamsRegistryPath();
}

/**
 * Atomic JSON write: writes to a unique sibling tmp file then renames over
 * the target. rename(2) is atomic on POSIX, so a crashed write leaves the
 * old file untouched instead of producing a half-written registry that
 * loadTeams() would reject.
 */
async function atomicWriteJson(p: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(data, null, 2);
  await fs.writeFile(tmp, body);
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Run `fn` while holding an exclusive cross-process lock on the registry
 * file. proper-lockfile requires the target to exist, so we touch it first.
 * Stale locks (from crashed callers) auto-expire after `stale` ms.
 */
async function withRegistryLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (!fsSync.existsSync(p)) {
    // Use 'wx' so a concurrent caller doesn't clobber data written between
    // our existsSync check and writeFile.
    try {
      await fs.writeFile(p, '{}', { flag: 'wx' });
    } catch (err: any) {
      if (err && err.code !== 'EEXIST') throw err;
    }
  }
  const release = await lockfile.lock(p, {
    retries: { retries: 60, minTimeout: 25, maxTimeout: 250, factor: 1.5 },
    stale: 10_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Load all teams from the registry file. Returns an empty object only when
 * the file does not exist. A malformed file is a hard error — silently
 * returning {} would let any caller wipe the user's registry on the next
 * write, which is exactly the data-loss path we are trying to close.
 */
export async function loadTeams(): Promise<TeamRegistry> {
  const p = await registryPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as TeamRegistry;
  } catch (err: any) {
    throw new Error(
      `Team registry corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`
    );
  }
}

async function saveTeams(reg: TeamRegistry): Promise<void> {
  const p = await registryPath();
  await atomicWriteJson(p, reg);
}

export interface CreateTeamOptions {
  description?: string;
  enableWorktrees?: boolean;
  /** Path to an existing worktree for all teammates to share. */
  useWorktree?: string;
}

/** Create a new team. Throws if a team with the same name already exists. */
export async function createTeam(name: string, options?: CreateTeamOptions): Promise<TeamMeta> {
  if (options?.enableWorktrees && options?.useWorktree) {
    throw new Error('Cannot use both --enable-worktrees and --use-worktree. Pick one.');
  }
  const p = await registryPath();
  const meta = await withRegistryLock(p, async () => {
    const reg = await loadTeams();
    if (reg[name]) {
      throw new Error(`Team '${name}' already exists`);
    }
    const m: TeamMeta = {
      created_at: new Date().toISOString(),
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.enableWorktrees ? { enable_worktrees: true } : {}),
      ...(options?.useWorktree ? { use_worktree: options.useWorktree } : {}),
    };
    reg[name] = m;
    await saveTeams(reg);
    return m;
  });
  // Audit the lifecycle boundary, not the CLI shell — captures every creation
  // path (create + ensure) with team metadata the generic command log lacks.
  emit('teams.create', { team: name, worktrees: Boolean(options?.enableWorktrees || options?.useWorktree) });
  return meta;
}

/** Return existing team metadata or create a new team if it does not exist. */
export async function ensureTeam(name: string): Promise<TeamMeta> {
  const p = await registryPath();
  let created = false;
  const meta = await withRegistryLock(p, async () => {
    const reg = await loadTeams();
    if (reg[name]) return reg[name];
    const m: TeamMeta = { created_at: new Date().toISOString() };
    reg[name] = m;
    await saveTeams(reg);
    created = true;
    return m;
  });
  // `teams add` auto-creates the team on first teammate — audit that creation
  // too, but only when it actually happened (not the get-existing path).
  if (created) emit('teams.create', { team: name, worktrees: false });
  return meta;
}

/** Remove a team from the registry. Returns false if the team did not exist. */
export async function removeTeam(name: string): Promise<boolean> {
  const p = await registryPath();
  const existed = await withRegistryLock(p, async () => {
    const reg = await loadTeams();
    if (!reg[name]) return false;
    delete reg[name];
    await saveTeams(reg);
    return true;
  });
  // "Disband" — only fires when a real team was removed, not a no-op.
  if (existed) emit('teams.disband', { team: name });
  return existed;
}

/** Check whether a team with the given name exists in the registry. */
export async function teamExists(name: string): Promise<boolean> {
  const reg = await loadTeams();
  return Boolean(reg[name]);
}

/** Get metadata for a specific team. Returns null if team does not exist. */
export async function getTeam(name: string): Promise<TeamMeta | null> {
  const reg = await loadTeams();
  return reg[name] ?? null;
}
