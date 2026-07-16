/**
 * Workflows detector — scans `{versionHome}/workflows/` for subdirectories
 * containing WORKFLOW.md. Mirrors versions.ts:551-558.
 */
import * as fs from 'fs';
import * as os from 'os';
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

      if (agent === 'antigravity') {
        // Antigravity user workflows are HOME-global and shared across versions,
        // not version-isolated — see workflows.ts:antigravityWorkflowsDir(). agy
        // scans the real ~/.gemini/config/global_workflows/, so the detector reads
        // the same shared dir the writer targets (versionHome is intentionally unused).
        const dir = path.join(process.env.HOME ?? os.homedir(), '.gemini', 'config', 'global_workflows');
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter(d => d.isFile() && d.name.endsWith('.md') && !d.name.startsWith('.'))
          .filter(d => {
            try {
              const content = fs.readFileSync(path.join(dir, d.name), 'utf-8');
              const lines = content.split('\n');
              if (lines[0] !== '---') return false;
              const endIndex = lines.slice(1).findIndex(l => l === '---');
              if (endIndex < 0) return false;
              const parsed = yaml.parse(lines.slice(1, endIndex + 1).join('\n')) as { agents_workflow?: unknown } | null;
              return parsed?.agents_workflow === d.name.slice(0, -'.md'.length);
            } catch { return false; }
          })
          .map(d => d.name.slice(0, -'.md'.length));
      }

      if (agent === 'goose') {
        const recipesDir = path.join(versionHome, '.config', 'goose', 'recipes');
        if (!fs.existsSync(recipesDir)) return [];
        return fs.readdirSync(recipesDir, { withFileTypes: true })
          .filter(d => d.isFile() && d.name.endsWith('.yaml') && !d.name.startsWith('.'))
          .map(d => d.name.slice(0, -'.yaml'.length));
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
