/**
 * Commands detector — mirrors the command dispatch in versions.ts. Inspects the version home,
 * returns command names. Honors the commands-as-skills marker for skills-only
 * agents (Kimi, Codex >= 0.117.0, …), requires both copies for dual-write
 * targets, and scans `{agentDir}/<commandsSubdir>/` for native-only targets.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, MANAGED_AGENT_IDS, agentConfigDirName } from '../../agents.js';
import {
  listCommandSkillsInVersion,
  shouldAlsoInstallCommandAsSkill,
  shouldInstallCommandAsSkill,
} from '../../command-skills.js';
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
      const nativeCommands = fs.readdirSync(commandsDir)
        .filter(f => f.endsWith(ext))
        .map(f => f.replace(new RegExp(`\\${ext}$`), ''));
      if (!shouldAlsoInstallCommandAsSkill(agent, version)) return nativeCommands;

      const commandSkills = new Set(listCommandSkillsInVersion(agentDir));
      return nativeCommands.filter((name) => commandSkills.has(name));
    },
  };
}

// Detector registration mirrors writers/commands.ts — skills-capable agents
// with no native command-file dir convert commands to skills by default; only
// agents with their own slash-command runtime (nativeCommandRuntime) opt out.
export const commandsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const id of MANAGED_AGENT_IDS) {
    const cfg = AGENTS[id];
    if (cfg.capabilities.commands === false && (!cfg.commandsSubdir || cfg.commandsSubdir === '') && cfg.nativeCommandRuntime) continue;
    const hasCommands = cfg.capabilities.commands !== false;
    const hasSkills = cfg.capabilities.skills !== false;
    if (hasCommands || hasSkills) m[id] = buildCommandsDetector(id);
  }
  return m;
});
