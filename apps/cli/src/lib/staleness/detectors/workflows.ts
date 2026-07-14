/**
 * Workflows detector — scans `{versionHome}/workflows/` for subdirectories
 * containing WORKFLOW.md. Mirrors versions.ts:551-558.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildWorkflowsDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'workflows',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      if (agent === 'kimi') {
        const skillsDir = path.join(versionHome, '.kimi-code', 'skills');
        if (!fs.existsSync(skillsDir)) return [];
        return fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
          .filter(d => {
            try {
              const skill = fs.readFileSync(path.join(skillsDir, d.name, 'SKILL.md'), 'utf-8');
              const lines = skill.split('\n');
              if (lines[0] !== '---') return false;
              const endIndex = lines.slice(1).findIndex(l => l === '---');
              if (endIndex < 0) return false;
              const parsed = yaml.parse(lines.slice(1, endIndex + 1).join('\n')) as { type?: unknown; agents_workflow?: unknown } | null;
              return parsed?.type === 'flow' && parsed.agents_workflow === d.name;
            } catch { return false; }
          })
          .map(d => d.name);
      }

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
