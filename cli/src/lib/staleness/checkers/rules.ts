/**
 * Rules staleness — composed from a layered `rules.yaml` preset definition
 * plus per-layer `subrules/<name>.md` fragments. Fingerprints exactly the
 * source files that contribute to the active preset's composed output.
 *
 * Bug-fixed from v1: the old `resolveRuleFile` looked for `rules/<preset>.md`,
 * a path that never exists (presets live in `rules.yaml`, fragments live in
 * `subrules/`). That made the rules section always report stale. This module
 * uses `composeRulesFromState` to discover the actual source file set per
 * preset/cwd, so freshness reflects real source changes.
 *
 * Special-cased vs. the other checkers: agent + version are needed to read
 * the active preset, so this module doesn't conform to ResourceChecker. The
 * aggregator wires it up explicitly.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { fingerprintFile, isFileStale } from '../fingerprint.js';
import { composeRulesFromState } from '../../rules/compose.js';
import {
  getActiveRulesPreset,
  getUserRulesDir,
  getResolvedRulesDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../../state.js';
import type { RulesEntry, FileEntry } from '../types.js';
import type { LayerScope } from '../layers.js';

function rulesDirForLayer(scope: LayerScope, cwd: string): string | null {
  if (scope === 'project') {
    const proj = getProjectAgentsDir(cwd);
    return proj ? path.join(proj, 'rules') : null;
  }
  if (scope === 'user')   return getUserRulesDir();
  if (scope === 'system') return getResolvedRulesDir();
  // extra: first registered extra repo's rules dir. The composer doesn't
  // disambiguate multi-extra rules.yaml today, so we don't either.
  const extras = getEnabledExtraRepos();
  return extras.length > 0 ? path.join(extras[0].dir, 'rules') : null;
}

/**
 * Resolve the set of source files contributing to the active preset's output.
 * Keys are relative paths within the rules dir (stable across machines).
 * Values are absolute current paths.
 */
function activeSources(agent: AgentId, version: string, cwd: string): Record<string, string> {
  const result: Record<string, string> = {};
  let compose;
  try {
    const preset = getActiveRulesPreset(agent, version);
    compose = composeRulesFromState({ preset, cwd });
  } catch {
    return result;
  }

  const yamlDir = rulesDirForLayer(compose.presetLayer as LayerScope, cwd);
  if (yamlDir) {
    const yamlPath = path.join(yamlDir, 'rules.yaml');
    if (fs.existsSync(yamlPath)) result['rules.yaml'] = yamlPath;
  }
  for (const sub of compose.subrules) {
    // Key off the actual source path so dir-form subrules (subrules/<name>/rule.md)
    // and flat ones (subrules/<name>.md) both fingerprint the file that really
    // contributes to the output, not a hard-coded `.md` that may not exist.
    if (sub.subruleDir) {
      result[`subrules/${sub.name}/rule.md`] = sub.sourcePath;
      // Fingerprint hooks.yaml too so editing a hook re-syncs the rules section.
      const hooksFile = path.join(sub.subruleDir, 'hooks.yaml');
      if (fs.existsSync(hooksFile)) result[`subrules/${sub.name}/hooks.yaml`] = hooksFile;
    } else {
      result[`subrules/${sub.name}.md`] = sub.sourcePath;
    }
  }
  return result;
}

export function buildRules(agent: AgentId, version: string, cwd: string): RulesEntry {
  const files: Record<string, FileEntry> = {};
  for (const [key, srcPath] of Object.entries(activeSources(agent, version, cwd))) {
    const fp = fingerprintFile(srcPath);
    if (fp) files[key] = { source: fp };
  }
  return { files };
}

export function isRulesStale(
  stored: RulesEntry,
  agent: AgentId,
  version: string,
  cwd: string
): boolean {
  const current = activeSources(agent, version, cwd);
  const storedKeys = Object.keys(stored.files).sort();
  const currentKeys = Object.keys(current).sort();
  if (storedKeys.length !== currentKeys.length) return true;
  for (let i = 0; i < storedKeys.length; i++) {
    if (storedKeys[i] !== currentKeys[i]) return true;
  }
  for (const [key, srcPath] of Object.entries(current)) {
    const entry = stored.files[key];
    if (!entry || isFileStale(entry.source, srcPath)) return true;
  }
  return false;
}
