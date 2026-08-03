/**
 * Rules preset auto-apply at `agents run` launch time.
 *
 * `agents rules switch <agent>@<version> --preset <name>` persists the active
 * preset (`state.ts:setActiveRulesPreset`) and immediately recompiles it into
 * the version home via `syncResourcesToVersion` → the rules writer
 * (`staleness/writers/rules.ts`). Same for `agents add`/`use`. But nothing
 * re-applies the preset on a LATER `agents run` — if `setActiveRulesPreset`
 * is ever called without a follow-up sync (or a subrule file changes after
 * the last sync), the harness launches against a stale rules file until the
 * next explicit `agents rules switch` / `agents sync`.
 *
 * This closes that gap the same way `runLaunchSync` (project-launch.ts)
 * recompiles PROJECT rules on every launch: idempotent, and skip-fast when
 * nothing changed. The skip-fast reuses the staleness checkers' mtime+size
 * fingerprint comparison (`staleness/checkers/rules.ts`,
 * `staleness/fingerprint.ts`) against a small per-(agent,version) sentinel —
 * the same "hash the cheap inputs, compare, skip the write on a match" shape
 * `installScope` (project-launch.ts) uses for plugin marketplaces. The common
 * case (no preset or subrule change since the last run) costs one JSON read
 * plus a handful of `stat()` calls — no recompose, no write.
 *
 * Version-level scope only — the active preset is keyed by (agent, version),
 * matching `getActiveRulesPreset`. Per-model preset scoping is a follow-up.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../types.js';
import { AGENTS } from '../agents.js';
import { getActiveRulesPreset, getCacheDir } from '../state.js';
import { getWriter } from '../staleness/registry.js';
import { buildRules, isRulesStale } from '../staleness/checkers/rules.js';
import type { RulesEntry } from '../staleness/types.js';

/**
 * Sentinel shape. Carries the resolved preset NAME alongside the source
 * fingerprints because `isRulesStale` alone isn't sufficient: user/extra
 * layers auto-append every subrule the preset didn't name (see
 * `rules/compose.ts` — "auto-append"), so two differently-named presets can
 * resolve to the IDENTICAL source-file set (same files, different order) —
 * a preset flip that `isRulesStale`'s file-set comparison would miss. The
 * preset-name check catches that case; the fingerprint check catches an
 * in-place subrule edit under an unchanged preset.
 */
interface RunSyncSentinel {
  preset: string;
  entry: RulesEntry;
}

/** ~/.agents/.cache/rules-run-sync/ — regenerable; a lost sentinel just costs one extra compose+write. */
function sentinelPath(agent: AgentId, version: string): string {
  const key = `${agent}@${version}`.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(getCacheDir(), 'rules-run-sync', `${key}.json`);
}

function loadSentinel(agent: AgentId, version: string): RunSyncSentinel | null {
  try {
    return JSON.parse(fs.readFileSync(sentinelPath(agent, version), 'utf-8')) as RunSyncSentinel;
  } catch {
    return null;
  }
}

function saveSentinel(agent: AgentId, version: string, sentinel: RunSyncSentinel): void {
  const p = sentinelPath(agent, version);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(sentinel));
  } catch {
    // Best-effort — a failed write just means the next run redoes the compose+write.
  }
}

/**
 * Re-apply the active rules preset for (agent, version) into its version
 * home when the composed source set has drifted since the last time this ran.
 * Returns true when the version-home rules file was (re)written.
 *
 * No-cwd fingerprint on purpose: the version-home rules file never includes
 * the project layer (see `staleness/writers/rules.ts` — project rules are
 * resolved separately, at launch, into the workspace `AGENTS.md` by
 * `compileRulesForProject`). Fingerprinting with a cwd would pull the project
 * layer's subrules into the comparison and trigger a pointless version-home
 * rewrite every time a project's own `.agents/rules/` changes.
 *
 * Silent on any failure (no rules.yaml, unknown preset, unsupported agent) —
 * mirrors `syncResourcesToVersion`'s own catch-and-skip for rules: a bad
 * preset must never block a launch, and this now also runs on the hot path.
 */
export function applyActiveRulesPresetAtRun(
  agent: AgentId,
  version: string,
  versionHome: string,
): boolean {
  const cap = AGENTS[agent].capabilities.rules;
  if (cap === false) return false;
  const rulesWriter = getWriter('rules', agent);
  if (!rulesWriter) return false;

  const preset = getActiveRulesPreset(agent, version);
  const current = buildRules(agent, version, '');

  const stored = loadSentinel(agent, version);
  if (stored && stored.preset === preset && !isRulesStale(stored.entry, agent, version, '')) {
    return false; // skip-fast: preset unchanged AND composed source set unchanged
  }

  try {
    rulesWriter.write({ version, versionHome, selection: { preset }, cwd: '' });
  } catch {
    return false;
  }

  saveSentinel(agent, version, { preset, entry: current });
  return true;
}
