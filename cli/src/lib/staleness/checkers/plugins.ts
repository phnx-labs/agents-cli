/**
 * Plugins staleness — one directory per plugin, marker file is
 * `.claude-plugin/plugin.json`. First-wins across project > user > system
 * > extras. Fingerprints the entire plugin root (skills, commands, hooks,
 * etc. live INSIDE the plugin dir, so a content fingerprint covers them).
 *
 * Not tracked in v1 manifests; same one-time re-sync trade-off as workflows.
 */

import * as fs from 'fs';
import * as path from 'path';
import { firstWinsLayers, listAcrossLayers, resolveByName } from '../layers.js';
import { fingerprintDir, isDirStale } from '../fingerprint.js';
import type { PluginEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

function isPluginDir(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory()
      && fs.existsSync(path.join(full, '.claude-plugin', 'plugin.json'));
  } catch { return false; }
}

export const pluginsChecker: TypedResourceChecker<PluginEntry> = {
  type: 'plugins',

  listNames(cwd) {
    return listAcrossLayers(firstWinsLayers(cwd), 'plugins', (_, full) => isPluginDir(full));
  },

  build(name, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('plugins', name),
      isPluginDir
    );
    if (!resolved) return null;
    return { dirPath: resolved.path, files: fingerprintDir(resolved.path) };
  },

  isFresh(name, stored, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('plugins', name),
      isPluginDir
    );
    if (!resolved) return false;
    return !isDirStale(stored.dirPath, stored.files, resolved.path);
  },
};
