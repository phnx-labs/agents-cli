/**
 * Commands detector — mirrors versions.ts:343-357. Inspects the version home,
 * returns command names. Honors the commands-as-skills marker for skills-only
 * agents (grok, kimi, Codex >= 0.117.0, …); falls back to scanning
 * `{agentDir}/<commandsSubdir>/` for the native path.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, agentConfigDirName } from '../../agents.js';
import { shouldInstallCommandAsSkill, listCommandSkillsInVersion } from '../../command-skills.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildCommandsDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'commands',
    agent,
    list({ version, versionHome }: DetectArgs): string[] {
      const agentConfig = AGENTS[agent];
      const agentDir = path.join(versionHome, agentConfigDirName(agent));

      if (shouldInstallCommandAsSkill(agent, version)) {
        return listCommandSkillsInVersion(agentDir);
      }
      const commandsDir = path.join(agentDir, agentConfig.commandsSubdir);
      if (!fs.existsSync(commandsDir)) return [];
      const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
      return fs.readdirSync(commandsDir)
        .filter(f => f.endsWith(ext))
        .map(f => f.replace(new RegExp(`\\${ext}$`), ''));
    },
  };
}

// Detector registration mirrors writers/commands.ts — skills-capable agents
// with no native command-file dir convert commands to skills by default; only
// agents with their own slash-command runtime (nativeCommandRuntime) opt out.
export const commandsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const id of Object.keys(AGENTS) as AgentId[]) {
    const cfg = AGENTS[id];
    if (cfg.capabilities.commands === false && (!cfg.commandsSubdir || cfg.commandsSubdir === '') && cfg.nativeCommandRuntime) continue;
    const hasCommands = cfg.capabilities.commands !== false;
    const hasSkills = cfg.capabilities.skills !== false;
    if (hasCommands || hasSkills) m[id] = buildCommandsDetector(id);
  }
  return m;
});
