/**
 * Commands writer.
 *
 * Two physical formats, selected per-(agent, version) at write time. Most
 * agents receive one format; dual-write registry targets receive both:
 *
 *  - command-as-skill — fires when `shouldInstallCommandAsSkill(agent, version)`
 *    is true. Used for Codex >= 0.117.0 (commands capability ends, skills
 *    capability remains) and agents with skills but no native command-file dir
 *    such as Kimi. Cursor also receives this format in addition to its IDE
 *    command file. Writes `{agentDir}/skills/<name>/SKILL.md` with the
 *    `agents_command` marker; the agent picks it up as a slash-command equivalent.
 *
 *  - native command file — `{agentDir}/<commandsSubdir>/<name>.md` (or .toml
 *    when the agent's format is toml). Standard path for Claude, Codex
 *    < 0.117.0, Cursor, OpenCode, Copilot, Amp, Kiro, Roo, Antigravity.
 *
 * Source resolution is `resolveCommandSource` (user → system → extras —
 * project layer intentionally excluded).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, MANAGED_AGENT_IDS, agentConfigDirName } from '../../agents.js';
import { supports } from '../../capabilities.js';
import { safeJoin } from '../../paths.js';
import { markdownToToml } from '../../convert.js';
import { commandAppliesTo, parseCommandMetadata } from '../../commands.js';
import {
  commandSkillName,
  installCommandSkillToVersion,
  listCommandSkillsInVersion,
  removeCommandSkillFromVersion,
  shouldAlsoInstallCommandAsSkill,
  shouldInstallCommandAsSkill,
} from '../../command-skills.js';
import {
  installGooseCommandToVersion,
  listGooseCommandsInVersion,
  removeGooseCommandFromVersion,
} from '../../goose-commands.js';
import type { ResourceWriter, WriteArgs, WriteResult, RemoveArgs, RemoveResult } from './types.js';
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
      const commandsAlsoAsSkills = shouldAlsoInstallCommandAsSkill(agent, version);
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
      const paths: string[] = [];
      for (const cmd of selection) {
        const srcFile = resolveCommandSource(cmd);
        if (!srcFile) continue;

        const metadata = parseCommandMetadata(srcFile);
        if (!commandAppliesTo(agent, version, metadata).ok) continue;

        if (commandsAsSkills || commandsAlsoAsSkills) {
          const installed = installCommandSkillToVersion(agentDir, cmd, srcFile, skillRoots);
          // installed.skipped means a real skill source already owns this name,
          // which is a deliberate no-op, not a failure — the native file is still written.
          if (!installed.success) continue;
          if (!installed.skipped) {
            paths.push(safeJoin(path.join(agentDir, 'skills'), commandSkillName(cmd)));
          }
        }

        if (supportsCommands && agent === 'goose') {
          // Goose: recipe YAML + config.yaml slash_commands entry, not a file copy.
          // No artifact path recorded — the recipe layout lives in goose-commands.ts.
          const installed = installGooseCommandToVersion(versionHome, cmd, srcFile);
          if (!installed.success) continue;
        } else if (supportsCommands && agentConfig.format === 'toml') {
          const content = fs.readFileSync(srcFile, 'utf-8');
          const tomlContent = markdownToToml(cmd, content);
          const dest = safeJoin(commandsTarget, `${cmd}.toml`);
          fs.writeFileSync(dest, tomlContent);
          paths.push(dest);
        } else if (supportsCommands) {
          const dest = safeJoin(commandsTarget, `${cmd}.md`);
          fs.copyFileSync(srcFile, dest);
          paths.push(dest);
        }
        synced.push(cmd);
      }
      return { synced, paths };
    },
    remove({ versionHome, name }: RemoveArgs): RemoveResult {
      const agentConfig = AGENTS[agent];
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      let removed = false;

      // Native command file (Claude, Codex <0.117, Grok, Cursor, …). The
      // extension follows the agent's format, mirroring the write path above.
      if (agentConfig.commandsSubdir) {
        const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
        const nativeFile = safeJoin(path.join(agentDir, agentConfig.commandsSubdir), `${name}${ext}`);
        try {
          if (fs.existsSync(nativeFile) && fs.lstatSync(nativeFile).isFile()) {
            fs.unlinkSync(nativeFile);
            removed = true;
          }
        } catch { /* already gone / inaccessible */ }
      }

      // Command-as-skill dir (Codex >=0.117, Kimi; Cursor dual-write). Gated on
      // it currently being a command-skill, and removeCommandSkillFromVersion
      // re-checks the `agents_command` marker before deleting — so a real skill
      // of the same name is never destroyed by a command prune.
      if (listCommandSkillsInVersion(agentDir).includes(name)) {
        if (removeCommandSkillFromVersion(agentDir, name).success) removed = true;
      }

      // Goose recipe YAML + its slash_commands registry entry.
      if (agent === 'goose' && listGooseCommandsInVersion(versionHome).includes(name)) {
        if (removeGooseCommandFromVersion(versionHome, name).success) removed = true;
      }

      return { removed };
    },
  };
}

// Built lazily on first access — see lazy-map.ts for the cycle rationale.
//
// Registration covers two cases:
//   - native commands (claude, codex < 0.117.0, grok, etc.) — `commands` cap
//   - commands-as-skills (kimi, codex >= 0.117.0)
//   - dual-write commands plus command-skills (cursor)
//
// Agents that have skills but use a NATIVE non-file slash-command system
// (openclaw → Gateway-based commands) are NOT registered. They declare
// `nativeCommandRuntime: true` to opt out — their own runtime resolves slash
// commands, so there's nothing to write and nothing to convert.
export const commandsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const id of MANAGED_AGENT_IDS) {
    const cfg = AGENTS[id];
    if (cfg.capabilities.commands === false && (!cfg.skillsDir || cfg.skillsDir === '')) continue;
    // Skills-capable agent with no native command-file dir: convert commands to
    // skills by default (kimi, …). Opt out only agents with their own
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
