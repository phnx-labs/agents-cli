/**
 * Workflows detector — scans `{versionHome}/workflows/` for subdirectories
 * containing WORKFLOW.md. Mirrors versions.ts:551-558.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildWorkflowsDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'workflows',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      const workflowsDir = path.join(versionHome, 'workflows');
      if (!fs.existsSync(workflowsDir)) return [];
      return fs.readdirSync(workflowsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(workflowsDir, d.name, 'WORKFLOW.md')))
        .map(d => d.name);
    },
  };
}

export const workflowsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('workflows')) m[agent] = buildWorkflowsDetector(agent);
  return m;
});
