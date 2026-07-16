/**
 * Subagents writer. Every agent's on-disk layout (target dir, file/dir shape,
 * transform, and any post-sync finalize such as Kimi's parent index) is
 * declared once in the subagent registry; this writer is generic and iterates
 * the registry instead of a per-agent `else if` chain.
 *
 * Source-side discovery is `listInstalledSubagents` from lib/subagents.ts —
 * it reads user + system layers only (project layer excluded for the same
 * defense as commands/skills/hooks).
 */
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { listInstalledSubagents } from '../../subagents.js';
import { subagentTarget } from '../../subagents-registry.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { lazyAgentMap } from './lazy-map.js';

function buildSubagentsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'subagents',
    agent,
    write({ versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const target = subagentTarget(agent);
      if (!target) return { synced: [] };

      const all = listInstalledSubagents();
      const map = new Map(all.map(s => [s.name, s]));
      const dir = target.dir(versionHome);
      const synced: string[] = [];

      for (const name of selection) {
        const sub = map.get(name);
        if (!sub) continue;
        try {
          target.write(dir, sub);
          synced.push(sub.name);
        } catch { /* per-item sync failure: skip */ }
      }

      // Optional cross-item pass (e.g. Kimi's `_agents-cli.yaml` parent index).
      if (target.finalize && synced.length > 0) {
        target.finalize(dir, synced.map((name) => map.get(name)!));
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
