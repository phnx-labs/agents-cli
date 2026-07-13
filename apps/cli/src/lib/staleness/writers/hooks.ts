/**
 * Hooks writer — copies trusted hook script files into `{agentDir}/hooks/`.
 * Caller filters by `supports(agent, 'hooks', version)` before invoking.
 * Orphan sweep (delete hooks in version-home that aren't in `availableNames`)
 * stays in the orchestrator since it depends on the broader available set.
 */
import * as fs from 'fs';
import { agentConfigDirName } from '../../agents.js';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { safeJoin } from '../../paths.js';
import { registerHooksToSettings } from '../../hooks.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { resolveHookSource } from './sources.js';
import { lazyAgentMap } from './lazy-map.js';

function buildHooksWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'hooks',
    agent,
    write({ versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      const hooksTarget = path.join(agentDir, 'hooks');
      fs.mkdirSync(hooksTarget, { recursive: true });

      const synced: string[] = [];
      for (const hook of selection) {
        const srcFile = resolveHookSource(hook);
        if (!srcFile) continue;
        const destFile = safeJoin(hooksTarget, hook);
        fs.copyFileSync(srcFile, destFile);
        fs.chmodSync(destFile, 0o755);
        synced.push(hook);
      }

      // Native hook registration in settings.json/hooks.json. Grok auto-
      // discovers from ~/.grok/hooks/ so the file copy is sufficient. Copilot
      // loads every *.json under ~/.copilot/hooks/ — registerHooksForCopilot
      // writes the managed agents-cli-hooks.json there.
      if (agent === 'claude' || agent === 'codex' || agent === 'gemini' || agent === 'antigravity' || agent === 'kimi' || agent === 'droid' || agent === 'copilot' || agent === 'kiro') {
        registerHooksToSettings(agent, versionHome);
      }
      return { synced };
    },
  };
}

export const hooksWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('hooks')) m[agent] = buildHooksWriter(agent);
  return m;
});
