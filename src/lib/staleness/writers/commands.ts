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

      // Writers fire only after supports() OR commands-as-skills says yes —
      // both paths produce a usable result here.
      if (!commandsAsSkills && !supportsCommands) {
        throw new Error(`commands writer reached for ${agent}@${version} with no path (cmd=false, asSkill=false)`);
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
// (openclaw → Gateway-based commands) are NOT registered. The signal is an
// empty `commandsSubdir`: there's no directory to write to AND the agent
// doesn't want commands-as-skills either (it has its own runtime command
// resolver).
export const commandsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const id of Object.keys(AGENTS) as AgentId[]) {
    const cfg = AGENTS[id];
    if (cfg.capabilities.commands === false && (!cfg.skillsDir || cfg.skillsDir === '')) continue;
    // Native non-file slash-command runtime — no version-home write.
    if (cfg.capabilities.commands === false && (!cfg.commandsSubdir || cfg.commandsSubdir === '')) {
      // Grok has empty commandsSubdir AND wants commands-as-skills.
      // Distinguish: grok has skillsDir set; openclaw also has skillsDir, so we
      // can't use that. The cleanest signal is the agent's `cliCommand` set —
      // openclaw flags `commands: false` AND has its Gateway runtime, while
      // grok flags `commands: false` because grok's slash commands are skills.
      // We opt in explicitly: only grok takes commands-as-skills today.
      if (id !== 'grok') continue;
    }
    const hasCommands = cfg.capabilities.commands !== false;
    const hasSkills = cfg.capabilities.skills !== false;
    if (hasCommands || hasSkills) {
      m[id] = buildCommandsWriter(id);
    }
  }
  return m;
});
