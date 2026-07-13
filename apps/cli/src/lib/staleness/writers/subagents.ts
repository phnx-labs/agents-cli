/**
 * Subagents writer. Claude flattens each subagent into a single .md file
 * under `<agentDir>/agents/`. Codex writes TOML under `.codex/agents/`.
 * Droid (Factory AI) flattens each into a custom droid .md under
 * `<versionHome>/.factory/droids/`. OpenClaw copies the full subagent
 * directory (with AGENT.md renamed to AGENTS.md) into
 * `<versionHome>/.openclaw/<name>/`.
 *
 * Source-side discovery is `listInstalledSubagents` from lib/subagents.ts —
 * it reads user + system layers only (project layer excluded for the same
 * defense as commands/skills/hooks).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import {
  listInstalledSubagents,
  transformSubagentForClaude,
  transformSubagentForCodex,
  writeKimiSubagentFiles,
  buildKimiSubagentsParentYaml,
  KIMI_SUBAGENTS_PARENT_FILE,
  transformSubagentForDroid,
  syncSubagentToOpenclaw,
  parseSubagentFrontmatter,
} from '../../subagents.js';
import { safeJoin } from '../../paths.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildSubagentsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'subagents',
    agent,
    write({ versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const all = listInstalledSubagents();
      const map = new Map(all.map(s => [s.name, s]));
      const synced: string[] = [];

      for (const name of selection) {
        const sub = map.get(name);
        if (!sub) continue;
        try {
          if (agent === 'claude' || agent === 'grok') {
            const agentsDir = path.join(versionHome, agent === 'grok' ? '.grok' : '.claude', 'agents');
            fs.mkdirSync(agentsDir, { recursive: true });
            fs.writeFileSync(safeJoin(agentsDir, `${sub.name}.md`), transformSubagentForClaude(sub.path));
            synced.push(sub.name);
          } else if (agent === 'codex') {
            const agentsDir = path.join(versionHome, '.codex', 'agents');
            fs.mkdirSync(agentsDir, { recursive: true });
            fs.writeFileSync(safeJoin(agentsDir, `${sub.name}.toml`), transformSubagentForCodex(sub.path));
            synced.push(sub.name);
          } else if (agent === 'kimi') {
            writeKimiSubagentFiles(path.join(versionHome, '.kimi-code', 'agents'), sub.path, sub.name);
            synced.push(sub.name);
          } else if (agent === 'droid') {
            const droidsDir = path.join(versionHome, '.factory', 'droids');
            fs.mkdirSync(droidsDir, { recursive: true });
            fs.writeFileSync(safeJoin(droidsDir, `${sub.name}.md`), transformSubagentForDroid(sub.path));
            synced.push(sub.name);
          } else if (agent === 'openclaw') {
            const target = safeJoin(path.join(versionHome, '.openclaw'), sub.name);
            const r = syncSubagentToOpenclaw(sub.path, target);
            if (r.success) synced.push(sub.name);
          }
        } catch { /* per-item sync failure: skip */ }
      }

      // Kimi parent agent file listing all synced subagents for --agent-file.
      if (agent === 'kimi' && synced.length > 0) {
        const agentsDir = path.join(versionHome, '.kimi-code', 'agents');
        const entries = synced.map((name) => {
          const sub = map.get(name)!;
          const fm = parseSubagentFrontmatter(path.join(sub.path, 'AGENT.md'));
          return {
            name,
            description: fm?.description ?? name,
            relativePath: `./${name}.yaml`,
          };
        });
        fs.writeFileSync(
          safeJoin(agentsDir, KIMI_SUBAGENTS_PARENT_FILE),
          buildKimiSubagentsParentYaml(entries)
        );
      }

      return { synced };
    },
  };
}

export const subagentsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('subagents')) m[agent] = buildSubagentsWriter(agent);
  return m;
});
