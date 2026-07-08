/**
 * Staleness library entrypoint. Aggregates per-resource checkers into the
 * two operations the rest of the codebase needs:
 *
 *   - `buildManifest(agent, version, cwd)` — snapshot current state.
 *   - `isStale(manifest, agent, version, cwd)` — true when any tracked
 *     resource has drifted from its stored fingerprint.
 *
 * `loadManifest` / `saveManifest` round-trip the on-disk JSON. The format
 * version stays at 1; new optional fields (workflows, plugins) on old files
 * read as empty maps which forces a single re-sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../types.js';
import { getVersionsDir } from '../state.js';

import { commandsChecker } from './checkers/commands.js';
import { skillsChecker }   from './checkers/skills.js';
import { hooksChecker }    from './checkers/hooks.js';
import { mcpChecker }      from './checkers/mcp.js';
import { subagentsChecker } from './checkers/subagents.js';
import { workflowsChecker } from './checkers/workflows.js';
import { pluginsChecker }   from './checkers/plugins.js';
import { buildPermissions, isPermissionsStale } from './checkers/permissions.js';
import { buildRules, isRulesStale }             from './checkers/rules.js';

import type { ResourceChecker } from './checkers/types.js';
import {
  MANIFEST_VERSION,
  type SyncManifest,
  type FileEntry,
  type DirEntry,
  type PluginEntry,
  type RulesEntry,
} from './types.js';
import { nameSetDiffers } from './fingerprint.js';

export type { SyncManifest } from './types.js';
export { MANIFEST_VERSION } from './types.js';

/**
 * Standard checkers — uniform contract. Rules and permissions have extra
 * context (agent/version, preset env) so they're wired explicitly below.
 */
const STANDARD_CHECKERS: ReadonlyArray<{
  checker: ResourceChecker;
  field: keyof Pick<SyncManifest, 'commands' | 'skills' | 'hooks' | 'mcp' | 'subagents' | 'workflows' | 'plugins'>;
}> = [
  { checker: commandsChecker,  field: 'commands'  },
  { checker: skillsChecker,    field: 'skills'    },
  { checker: hooksChecker,     field: 'hooks'     },
  { checker: mcpChecker,       field: 'mcp'       },
  { checker: subagentsChecker, field: 'subagents' },
  { checker: workflowsChecker, field: 'workflows' },
  { checker: pluginsChecker,   field: 'plugins'   },
];

// ─── Public API ──────────────────────────────────────────────────────────────

function manifestPath(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version, 'home', '.sync-manifest.json');
}

export function loadManifest(agent: AgentId, version: string): SyncManifest | null {
  const p = manifestPath(agent, version);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SyncManifest;
    if (raw.v !== MANIFEST_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveManifest(agent: AgentId, version: string, manifest: SyncManifest): void {
  const p = manifestPath(agent, version);
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function buildManifest(agent: AgentId, version: string, cwd: string): SyncManifest {
  const manifest: SyncManifest = {
    v: MANIFEST_VERSION,
    syncedAt: new Date().toISOString(),
    commands:  {},
    skills:    {},
    hooks:     {},
    rules:     { files: {} },
    mcp:       {},
    permissions: { groups: {}, permissionPreset: null },
    subagents: {},
    workflows: {},
    plugins:   {},
  };

  for (const { checker, field } of STANDARD_CHECKERS) {
    const target = manifest[field] as Record<string, unknown>;
    for (const name of checker.listNames(cwd)) {
      const entry = checker.build(name, cwd);
      if (entry !== null) target[name] = entry;
    }
  }

  manifest.rules       = buildRules(agent, version, cwd);
  manifest.permissions = buildPermissions();
  return manifest;
}

/**
 * True when any tracked resource has drifted from the stored manifest.
 * Walks every resource type in turn and returns true at the first miss —
 * sync detection should be cheap when nothing changed.
 */
export function isStale(
  manifest: SyncManifest,
  agent: AgentId,
  version: string,
  cwd: string
): boolean {
  for (const { checker, field } of STANDARD_CHECKERS) {
    const storedMap = (manifest[field] ?? {}) as Record<string, unknown>;
    const currentNames = checker.listNames(cwd);
    if (nameSetDiffers(Object.keys(storedMap), currentNames)) return true;
    for (const name of currentNames) {
      const entry = storedMap[name];
      if (entry === undefined) return true;
      if (!checker.isFresh(name, entry, cwd)) return true;
    }
  }
  if (isPermissionsStale(manifest.permissions)) return true;
  if (isRulesStale(manifest.rules, agent, version, cwd)) return true;
  return false;
}

// ─── Type re-exports for convenience ─────────────────────────────────────────
export type { FileEntry, DirEntry, PluginEntry, RulesEntry };
