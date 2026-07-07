/**
 * Hooks detector — names of hook scripts materialized in the version home
 * whose contents match the central source. Mirrors versions.ts:391-421.
 */
import * as fs from 'fs';
import { agentConfigDirName } from '../../agents.js';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { resolveHookSource } from '../writers/sources.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildHooksDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'hooks',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      const hooksDir = path.join(versionHome, agentConfigDirName(agent), 'hooks');
      if (!fs.existsSync(hooksDir)) return [];
      const installed = fs.readdirSync(hooksDir).filter(f => !f.startsWith('.'));

      const synced: string[] = [];
      for (const hook of installed) {
        const src = resolveHookSource(hook);
        if (!src) {
          // True orphan — count as accounted for.
          synced.push(hook);
          continue;
        }
        try {
          if (fs.readFileSync(src, 'utf-8') === fs.readFileSync(path.join(hooksDir, hook), 'utf-8')) {
            synced.push(hook);
          }
        } catch { /* read failure → not synced */ }
      }
      return synced;
    },
  };
}

export const hooksDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('hooks')) m[agent] = buildHooksDetector(agent);
  return m;
});
