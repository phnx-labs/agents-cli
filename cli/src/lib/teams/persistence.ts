/**
 * Teams data-directory resolution.
 *
 * Resolves the base directory for teammate metadata + the per-team agents
 * dir, with temp-dir fallbacks for unwritable homedirs. The teams subsystem
 * does NOT carry its own agent-registry config — `agents teams` discovers
 * agents through the same machinery as `agents view` (installed versions
 * via `listInstalledVersions`) and invokes them through `agents run`.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { constants as fsConstants } from 'fs';
import { getTeamsDir, getTeamsAgentsDir } from '../state.js';

const TEAMS_DIR = getTeamsDir();
const TMP_FALLBACK_DIR = path.join(tmpdir(), 'agents');

async function ensureWritableDir(p: string): Promise<boolean> {
  try {
    await fs.mkdir(p, { recursive: true });
    await fs.access(p, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the base data directory for teams, preferring ~/.agents/teams/ with a temp fallback. */
export async function resolveBaseDir(): Promise<string> {
  if (await ensureWritableDir(TEAMS_DIR)) {
    return TEAMS_DIR;
  }

  if (await ensureWritableDir(TMP_FALLBACK_DIR)) {
    console.warn(`[agents teams] Falling back to temp data dir at ${TMP_FALLBACK_DIR}`);
    return TMP_FALLBACK_DIR;
  }

  throw new Error('Unable to determine a writable data directory for teams');
}

async function resolveAgentsPath(): Promise<string> {
  const historyAgents = getTeamsAgentsDir();
  if (await ensureWritableDir(historyAgents)) {
    return historyAgents;
  }
  // Last-resort temp fallback so dispatch keeps working when ~/.agents is unwritable.
  const tmpAgents = path.join(TMP_FALLBACK_DIR, 'agents');
  if (await ensureWritableDir(tmpAgents)) {
    console.warn(`[agents teams] Falling back to temp agents dir at ${tmpAgents}`);
    return tmpAgents;
  }
  throw new Error('Unable to determine a writable agents directory');
}

let AGENTS_DIR: string | null = null;

/** Resolve and ensure the agents subdirectory exists under the teams base dir. */
export async function resolveAgentsDir(): Promise<string> {
  if (!AGENTS_DIR) {
    AGENTS_DIR = await resolveAgentsPath();
  }
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  return AGENTS_DIR;
}
