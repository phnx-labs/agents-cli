/**
 * Subagents detector. Claude: flat .md files under `<agentDir>/agents/`.
 * Codex: flat .toml files under `<versionHome>/.codex/agents/`.
 * Droid: flat .md files under `<versionHome>/.factory/droids/`.
 * OpenClaw: subdirectories containing AGENTS.md under `<versionHome>/.openclaw/`.
 * Mirrors versions.ts:521-539.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildClaudeDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'claude',
    list({ versionHome }: DetectArgs): string[] {
      const agentsDir = path.join(versionHome, '.claude', 'agents');
      if (!fs.existsSync(agentsDir)) return [];
      return fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
    },
  };
}

function buildCodexDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'codex',
    list({ versionHome }: DetectArgs): string[] {
      const agentsDir = path.join(versionHome, '.codex', 'agents');
      if (!fs.existsSync(agentsDir)) return [];
      return fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.toml'))
        .map(f => f.replace(/\.toml$/, ''));
    },
  };
}

function buildDroidDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'droid',
    list({ versionHome }: DetectArgs): string[] {
      const droidsDir = path.join(versionHome, '.factory', 'droids');
      if (!fs.existsSync(droidsDir)) return [];
      return fs.readdirSync(droidsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
    },
  };
}

function buildOpenclawDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'openclaw',
    list({ versionHome }: DetectArgs): string[] {
      const openclawDir = path.join(versionHome, '.openclaw');
      if (!fs.existsSync(openclawDir)) return [];
      return fs.readdirSync(openclawDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(openclawDir, d.name, 'AGENTS.md')))
        .map(d => d.name);
    },
  };
}

const handlers: Partial<Record<AgentId, () => ResourceDetector>> = {
  claude: buildClaudeDetector,
  codex: buildCodexDetector,
  droid: buildDroidDetector,
  openclaw: buildOpenclawDetector,
};

export const subagentsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('subagents')) {
    const f = handlers[agent];
    if (f) m[agent] = f();
  }
  return m;
});
