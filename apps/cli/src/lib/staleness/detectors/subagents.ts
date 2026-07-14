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

function buildFlatMdAgentsDetector(agent: AgentId, agentsRoot: string): ResourceDetector {
  return {
    kind: 'subagents',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      const agentsDir = path.join(versionHome, agentsRoot, 'agents');
      if (!fs.existsSync(agentsDir)) return [];
      return fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
    },
  };
}

function buildClaudeDetector(): ResourceDetector {
  return buildFlatMdAgentsDetector('claude', '.claude');
}

function buildGrokDetector(): ResourceDetector {
  return buildFlatMdAgentsDetector('grok', '.grok');
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

function buildCopilotDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'copilot',
    list({ versionHome }: DetectArgs): string[] {
      const agentsDir = path.join(versionHome, '.copilot', 'agents');
      if (!fs.existsSync(agentsDir)) return [];
      return fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.agent.md'))
        .map(f => f.replace('.agent.md', ''));
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

function buildKimiDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'kimi',
    list({ versionHome }: DetectArgs): string[] {
      const agentsDir = path.join(versionHome, '.kimi-code', 'agents');
      if (!fs.existsSync(agentsDir)) return [];
      // Parent is `_agents-cli.yaml` (underscore-prefixed reserved name).
      return fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.yaml') && !f.startsWith('_'))
        .map(f => f.replace(/\.yaml$/, ''));
    },
  };
}

function buildKiroDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'kiro',
    list({ versionHome }: DetectArgs): string[] {
      const agentsDir = path.join(versionHome, '.kiro', 'agents');
      if (!fs.existsSync(agentsDir)) return [];
      return fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
    },
  };
}

function buildOpenCodeDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'opencode',
    list({ versionHome }: DetectArgs): string[] {
      const agentsDir = path.join(versionHome, '.config', 'opencode', 'agents');
      if (!fs.existsSync(agentsDir)) return [];
      return fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace(/\.md$/, ''));
    },
  };
}

function buildAntigravityDetector(): ResourceDetector {
  return {
    kind: 'subagents',
    agent: 'antigravity',
    list({ versionHome }: DetectArgs): string[] {
      const agentsDir = path.join(versionHome, '.gemini', 'config', 'agents');
      if (!fs.existsSync(agentsDir)) return [];
      return fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(agentsDir, d.name, 'agent.md')))
        .map(d => d.name);
    },
  };
}

const handlers: Partial<Record<AgentId, () => ResourceDetector>> = {
  claude: buildClaudeDetector,
  copilot: buildCopilotDetector,
  grok: buildGrokDetector,
  codex: buildCodexDetector,
  kimi: buildKimiDetector,
  opencode: buildOpenCodeDetector,
  antigravity: buildAntigravityDetector,
  droid: buildDroidDetector,
  openclaw: buildOpenclawDetector,
  kiro: buildKiroDetector,
};

export const subagentsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('subagents')) {
    const f = handlers[agent];
    if (f) m[agent] = f();
  }
  return m;
});
