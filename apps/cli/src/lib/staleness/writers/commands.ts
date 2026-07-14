/**
 * Commands writer.
 *
 * Two physical formats, picked per-(agent, version) at write time:
 *
 *  - command-as-skill — fires when `shouldInstallCommandAsSkill(agent, version)`
 *    is true. Used for grok (no native commands, but skills/) and Codex
 *    >= 0.117.0 (commands capability ends, skills capability remains).
 *    Writes `{agentDir}/skills/<name>/SKILL.md` with the `agents_command`
 *    marker; the agent picks it up as a slash-command equivalent.
 *
 *  - native command file — `{agentDir}/<commandsSubdir>/<name>.md` (or .toml
 *    when the agent's format is toml). Standard path for Claude, Codex
 *    < 0.117.0, Gemini, Cursor, OpenCode, Copilot, Amp, Kiro, Roo,
 *    Antigravity.
 *
 * Source resolution is `resolveCommandSource` (user → system → extras —
 * project layer intentionally excluded).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, agentConfigDirName } from '../../agents.js';
import { supports } from '../../capabilities.js';
import { safeJoin } from '../../paths.js';
import { markdownToToml } from '../../convert.js';
import { commandAppliesTo, parseCommandMetadata } from '../../commands.js';
import { installCommandSkillToVersion, shouldInstallCommandAsSkill } from '../../command-skills.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { resolveCommandSource, trustedSkillRoots } from './sources.js';
import { lazyAgentMap } from './lazy-map.js';

function buildCommandsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'commands',
    agent,
    write({ version, versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const agentConfig = AGENTS[agent];
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      const commandsAsSkills = shouldInstallCommandAsSkill(agent, version);
      const supportsCommands = supports(agent, 'commands', version).ok;

      // Version-gated agents (e.g. goose skills >= 1.25.0) are registered but
      // may be called at a version too old for both paths — skip gracefully.
      if (!commandsAsSkills && !supportsCommands) {
        return { synced: [] };
      }

      const skillRoots = trustedSkillRoots();
      const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);
      if (!commandsAsSkills) {
        fs.mkdirSync(commandsTarget, { recursive: true });
      }

      const synced: string[] = [];
      for (const cmd of selection) {
        const srcFile = resolveCommandSource(cmd);
        if (!srcFile) continue;

        const metadata = parseCommandMetadata(srcFile);
        if (!commandAppliesTo(agent, version, metadata).ok) continue;

        if (commandsAsSkills) {
          const installed = installCommandSkillToVersion(agentDir, cmd, srcFile, skillRoots);
          if (!installed.success) continue;
        } else if (agentConfig.format === 'toml') {
          const content = fs.readFileSync(srcFile, 'utf-8');
          const tomlContent = markdownToToml(cmd, content);
          fs.writeFileSync(safeJoin(commandsTarget, `${cmd}.toml`), tomlContent);
        } else {
          fs.copyFileSync(srcFile, safeJoin(commandsTarget, `${cmd}.md`));
        }
        synced.push(cmd);
      }
      return { synced };
    },
  };
}

// Built lazily on first access — see lazy-map.ts for the cycle rationale.
//
// Registration covers two cases:
//   - native commands (claude, codex < 0.117.0, gemini, etc.) — `commands` cap
//   - commands-as-skills (grok, codex >= 0.117.0)
//
// Agents that have skills but use a NATIVE non-file slash-command system
// (openclaw → Gateway-based commands) are NOT registered. They declare
// `nativeCommandRuntime: true` to opt out — their own runtime resolves slash
// commands, so there's nothing to write and nothing to convert.
export const commandsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const id of Object.keys(AGENTS) as AgentId[]) {
    const cfg = AGENTS[id];
    if (cfg.capabilities.commands === false && (!cfg.skillsDir || cfg.skillsDir === '')) continue;
    // Skills-capable agent with no native command-file dir: convert commands to
    // skills by default (grok, kimi, …). Opt out only agents with their own
    // slash-command runtime (openclaw).
    if (cfg.capabilities.commands === false && (!cfg.commandsSubdir || cfg.commandsSubdir === '')) {
      if (cfg.nativeCommandRuntime) continue;
    }
    const hasCommands = cfg.capabilities.commands !== false;
    const hasSkills = cfg.capabilities.skills !== false;
    if (hasCommands || hasSkills) {
      m[id] = buildCommandsWriter(id);
    }
  }
  return m;
});
