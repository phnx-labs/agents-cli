/**
 * Subagents staleness — one directory per subagent (must contain AGENT.md),
 * first-wins across project > user > system > extras.
 *
 * Bug-fixed from v1: the old manifest derived its name list from
 * `listInstalledSubagents()` which only walks user + system. With project
 * subagents in `available.subagents`, the name-set diff always flipped to
 * "stale". This checker walks all four layers consistently.
 */

import * as fs from 'fs';
import * as path from 'path';
import { firstWinsLayers, listAcrossLayers, resolveByName } from '../layers.js';
import { fingerprintDir, isDirStale } from '../fingerprint.js';
import type { DirEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

function isSubagentDir(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'AGENT.md'));
  } catch { return false; }
}

export const subagentsChecker: TypedResourceChecker<DirEntry> = {
  type: 'subagents',

  listNames(cwd) {
    return listAcrossLayers(firstWinsLayers(cwd), 'subagents', (_, full) => isSubagentDir(full));
  },

  build(name, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('subagents', name),
      isSubagentDir
    );
    if (!resolved) return null;
    return { dirPath: resolved.path, files: fingerprintDir(resolved.path) };
  },

  isFresh(name, stored, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('subagents', name),
      isSubagentDir
    );
    if (!resolved) return false;
    return !isDirStale(stored.dirPath, stored.files, resolved.path);
  },
};
