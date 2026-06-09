/**
 * Rules writer — composes one instruction file per supported agent.
 *
 * Single-target per agent (RulesCapability is `{ file: string } | false`).
 * The composer in `lib/rules/compose.ts` handles all four layers
 * (project > user > extras > system). We never write the project layer into
 * the version home — it's resolved at agents-run time into the workspace
 * AGENTS.md by `compileRulesForProject`.
 *
 * Selection shape: `{ preset: string }`. Use `getActiveRulesPreset(agent,
 * version)` to derive the preset when the caller has no override.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, agentConfigDirName } from '../../agents.js';
import { capableAgents, supports } from '../../capabilities.js';
import { composeRulesFromState } from '../../rules/compose.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

export interface RulesSelection {
  /** Preset name to compose. Empty string falls through to `"default"` in the composer. */
  preset: string;
}

function buildRulesWriter(agent: AgentId): ResourceWriter<RulesSelection> {
  return {
    kind: 'rules',
    agent,
    write({ versionHome, selection }: WriteArgs<RulesSelection>): WriteResult {
      const cap = AGENTS[agent].capabilities.rules;
      if (cap === false) {
        throw new Error(`rules writer reached for ${agent} (rules: false)`);
      }
      const targetName = cap.file;
      const composed = composeRulesFromState({ preset: selection.preset || undefined });
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      // `cap.file` is a trusted constant from AGENTS table; openclaw ships a
      // nested path (`workspace/AGENTS.md`) so we use path.join rather than
      // safeJoin (which rejects path separators in `name`).
      const destFile = path.join(agentDir, targetName);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      // Remove any pre-existing symlink before writing — a stale symlink
      // could point at a deleted source and writeFileSync would chase it
      // to nothing.
      try {
        const st = fs.lstatSync(destFile);
        if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(destFile);
      } catch { /* destination did not exist */ }
      fs.writeFileSync(destFile, composed.content);
      return { synced: [targetName] };
    },
  };
}

export const rulesWriters = lazyAgentMap<ResourceWriter<RulesSelection>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<RulesSelection>>> = {};
  for (const agent of capableAgents('rules')) m[agent] = buildRulesWriter(agent);
  return m;
});
