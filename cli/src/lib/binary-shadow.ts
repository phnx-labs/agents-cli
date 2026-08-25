/**
 * Detect `agents` binaries that could shadow the currently running CLI.
 *
 * Scheduled command routines invoke the bare name `agents`. When an older install
 * appears earlier on PATH than the current binary, routines silently run stale
 * code (RUSH-2431). This module finds those shadows so `agents doctor` can warn.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAgentsBinPath } from './cli-entry.js';

export interface AgentsBinaryShadow {
  /** Path of the shadowing binary as it appears to the caller. */
  path: string;
  /** Its self-reported version, if we can run it. */
  version?: string;
}

/** Realpath of `p`, or `p` itself if it cannot be resolved. */
function safeRealpath(p: string): string {
  try { return fs.realpathSync(p); }
  catch { return p; }
}

/**
 * Whether two path spellings identify the same file.
 *
 * Two spellings of one file rarely compare equal on Windows: `realpathSync` does
 * not expand 8.3 short names, so a path rooted at `os.tmpdir()`
 * (`C:\Users\RUNNER~1\...` on a GitHub runner) never matches the long form
 * (`C:\Users\runneradmin\...`) that `where` reports. Compare by device+inode
 * first and fall back to case-insensitive resolved spellings.
 */
export function sameFile(a: string, b: string): boolean {
  try {
    const aStat = fs.statSync(a);
    const bStat = fs.statSync(b);
    if (aStat.dev === bStat.dev && aStat.ino === bStat.ino) return true;
  } catch { /* compare their resolved path spellings below */ }

  const aReal = safeRealpath(a);
  const bReal = safeRealpath(b);
  return process.platform === 'win32'
    ? aReal.toLowerCase() === bReal.toLowerCase()
    : aReal === bReal;
}

/**
 * Find `agents` installs that are NOT the currently running binary.
 *
 * Checks two sources:
 *   1. The current PATH: if `which agents` / `where agents` resolves to a
 *      different real binary than the one executing this code, it is an active
 *      shadow.
 *   2. Well-known install directories: any executable `agents` whose realpath
 *      differs from the current entry is a latent shadow — it may win under a
 *      different PATH (e.g. the daemon's service-managed PATH).
 */
export function detectAgentsBinaryShadows(
  currentBin: string = getAgentsBinPath(),
  extraDirs: readonly string[] = defaultWellKnownDirs(),
): AgentsBinaryShadow[] {
  const currentReal = safeRealpath(currentBin);

  const seen = new Set<string>();
  const shadows: AgentsBinaryShadow[] = [];

  function addIfShadow(candidate: string): void {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (sameFile(candidate, currentReal)) return;
    let version: string | undefined;
    try {
      version = execFileSync(candidate, ['--version'], { encoding: 'utf-8', env: process.env })
        .trim()
        .split('\n')[0];
    } catch { /* binary may be unreadable/unrunnable — still report it */ }
    shadows.push({ path: candidate, version });
  }

  // Active shadow under the current environment's PATH.
  try {
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    const pathAgents = execFileSync(resolver, ['agents'], { encoding: 'utf-8', env: process.env })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (pathAgents && !sameFile(pathAgents, currentReal)) {
      addIfShadow(pathAgents);
    }
  } catch { /* no `agents` resolved on PATH */ }

  // Latent shadows in well-known install locations.
  for (const dir of extraDirs) {
    for (const name of agentBinaryNames()) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        addIfShadow(candidate);
      } catch { /* ignore */ }
    }
  }

  return shadows;
}

function agentBinaryNames(): string[] {
  return process.platform === 'win32' ? ['agents.exe', 'agents.cmd', 'agents'] : ['agents'];
}

function defaultWellKnownDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(programFiles, 'nodejs'),
      path.dirname(process.execPath),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.dirname(process.execPath),
  ];
}
