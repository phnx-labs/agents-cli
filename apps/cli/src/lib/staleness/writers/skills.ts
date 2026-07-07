/**
 * Skills writer — copies each selected skill directory into
 * `{agentDir}/skills/<name>/`. Agents flagged `nativeAgentsSkillsDir` (Gemini)
 * read directly from `~/.agents/skills/` and have no writer registered; the
 * sync orchestrator clears their version-home skills dir.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../../types.js';
import { AGENTS, agentConfigDirName } from '../../agents.js';
import { capableAgents } from '../../capabilities.js';
import { safeJoin } from '../../paths.js';
import type { ResourceWriter, WriteArgs, WriteResult } from './types.js';
import { resolveSkillSource } from './sources.js';
import { lazyAgentMap } from './lazy-map.js';

const SKILL_COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (SKILL_COPY_IGNORE.has(entry.name)) continue;
    const s = safeJoin(src, entry.name);
    const d = safeJoin(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function removePath(p: string): void {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(p);
    else if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  } catch { /* already gone */ }
}

function buildSkillsWriter(agent: AgentId): ResourceWriter<string[]> {
  return {
    kind: 'skills',
    agent,
    write({ versionHome, selection }: WriteArgs<string[]>): WriteResult {
      const agentDir = path.join(versionHome, agentConfigDirName(agent));
      const skillsTarget = path.join(agentDir, 'skills');
      try {
        if (fs.lstatSync(skillsTarget).isSymbolicLink()) {
          removePath(skillsTarget);
        }
      } catch { /* does not exist yet */ }
      fs.mkdirSync(skillsTarget, { recursive: true });

      const synced: string[] = [];
      for (const skill of selection) {
        const srcDir = resolveSkillSource(skill);
        if (!srcDir) continue;
        const destDir = safeJoin(skillsTarget, skill);
        removePath(destDir);
        copyDir(srcDir, destDir);
        synced.push(skill);
      }
      return { synced };
    },
  };
}

export const skillsWriters = lazyAgentMap<ResourceWriter<string[]>>(() => {
  const m: Partial<Record<AgentId, ResourceWriter<string[]>>> = {};
  for (const agent of capableAgents('skills')) {
    // Agents that natively read ~/.agents/skills/ don't get a version-home
    // write — the orchestrator clears the dir for them.
    if (AGENTS[agent].nativeAgentsSkillsDir) continue;
    m[agent] = buildSkillsWriter(agent);
  }
  return m;
});
