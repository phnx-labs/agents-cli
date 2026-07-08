/**
 * Shared layer-source resolution for writers.
 *
 * Layer precedence matches getResourceBases() in versions.ts. Project layer
 * is intentionally EXCLUDED for commands/skills/hooks/subagents/permissions
 * — those bodies become agent context, and a cloned public repo could ship
 * one that coerces the agent on the next launch. Trusted layers only:
 * user → system → extras.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getUserAgentsDir, getAgentsDir, getEnabledExtraRepos, getCommandsDir, getSkillsDir, getHooksDir } from '../../state.js';
import { safeJoin } from '../../paths.js';

export type EnabledExtra = { alias: string; dir: string };

/** Trusted source bases for content-like kinds. Project layer excluded. */
export function trustedSourceBases(): { dir: string }[] {
  return [
    { dir: getUserAgentsDir() },
    { dir: getAgentsDir() },
    ...getEnabledExtraRepos().map((e) => ({ dir: e.dir })),
  ];
}

function isLiveFile(p: string): boolean {
  try {
    return fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isLiveDir(p: string): boolean {
  try {
    return fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink() && fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Find the trusted source for a command markdown by name. */
export function resolveCommandSource(name: string): string | null {
  const candidates = [
    safeJoin(path.join(getUserAgentsDir(), 'commands'), `${name}.md`),
    safeJoin(getCommandsDir(), `${name}.md`),
    ...getEnabledExtraRepos().map((e) => safeJoin(path.join(e.dir, 'commands'), `${name}.md`)),
  ];
  return candidates.find(isLiveFile) ?? null;
}

/** Find the trusted source directory for a skill by name. */
export function resolveSkillSource(name: string): string | null {
  const candidates = [
    safeJoin(path.join(getUserAgentsDir(), 'skills'), name),
    safeJoin(getSkillsDir(), name),
    ...getEnabledExtraRepos().map((e) => safeJoin(path.join(e.dir, 'skills'), name)),
  ];
  return candidates.find(isLiveDir) ?? null;
}

/** Find the trusted source file for a hook by name. */
export function resolveHookSource(name: string): string | null {
  const candidates = [
    safeJoin(path.join(getUserAgentsDir(), 'hooks'), name),
    safeJoin(getHooksDir(), name),
    ...getEnabledExtraRepos().map((e) => safeJoin(path.join(e.dir, 'hooks'), name)),
  ];
  return candidates.find(isLiveFile) ?? null;
}

/** All trusted command-skill source roots, used to dedup name collisions for commands-as-skills writes. */
export function trustedSkillRoots(): string[] {
  return [
    path.join(getUserAgentsDir(), 'skills'),
    getSkillsDir(),
    ...getEnabledExtraRepos().map((e) => path.join(e.dir, 'skills')),
  ];
}
