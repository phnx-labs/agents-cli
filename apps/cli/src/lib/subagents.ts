/**
 * Subagent management -- discovery, installation, and format conversion.
 *
 * Subagents are named agent definitions in ~/.agents/subagents/, each a directory
 * with an agent.md file (frontmatter + instructions). This module discovers them,
 * transforms them into agent-native formats (Claude .mdc, OpenClaw YAML),
 * and syncs them into version homes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { capableAgents } from './capabilities.js';
import { getSubagentsDir, getUserSubagentsDir, getTrashSubagentsDir } from './state.js';
import { listInstalledVersions, getVersionHomePath } from './versions.js';
import { safeJoin } from './paths.js';
import type { AgentId, DiscoveredSubagent, InstalledSubagent, SubagentFrontmatter } from './types.js';

/**
 * Parse AGENT.md frontmatter to extract subagent metadata
 */
export function parseSubagentFrontmatter(filePath: string): SubagentFrontmatter | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for YAML frontmatter
    if (lines[0] === '---') {
      const endIndex = lines.slice(1).findIndex((l) => l === '---');
      if (endIndex > 0) {
        const frontmatter = lines.slice(1, endIndex + 1).join('\n');
        const parsed = yaml.parse(frontmatter);
        return {
          name: parsed.name || '',
          description: parsed.description || '',
          model: parsed.model,
          color: parsed.color,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the body content of AGENT.md (everything after frontmatter)
 */
export function getSubagentBody(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Skip YAML frontmatter
  if (lines[0] === '---') {
    const endIndex = lines.slice(1).findIndex((l) => l === '---');
    if (endIndex > 0) {
      return lines.slice(endIndex + 2).join('\n').trim();
    }
  }

  return content;
}

/**
 * Discover subagents from a repository
 * Looks for subagents/{name}/AGENT.md
 */
export function discoverSubagentsFromRepo(repoPath: string): DiscoveredSubagent[] {
  const subagents: DiscoveredSubagent[] = [];
  const subagentsDir = path.join(repoPath, 'subagents');

  if (!fs.existsSync(subagentsDir)) {
    return subagents;
  }

  for (const dir of fs.readdirSync(subagentsDir)) {
    const dirPath = path.join(subagentsDir, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const agentMd = path.join(dirPath, 'AGENT.md');
    if (!fs.existsSync(agentMd)) {
      // Skip directories without AGENT.md
      continue;
    }

    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) {
      console.warn(`Warning: ${agentMd} has invalid frontmatter, skipping`);
      continue;
    }

    // Collect all .md files in the directory
    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .sort();

    subagents.push({
      name: dir, // Use directory name as canonical name
      path: dirPath,
      files,
      agentMd,
      frontmatter,
    });
  }

  return subagents;
}

/**
 * List installed subagents from ~/.agents/subagents/
 */
export function listInstalledSubagents(): InstalledSubagent[] {
  const seen = new Set<string>();
  const subagents: InstalledSubagent[] = [];

  // User dir first (wins on name collision), then system
  for (const subagentsDir of [getUserSubagentsDir(), getSubagentsDir()]) {
    if (!fs.existsSync(subagentsDir)) continue;

  for (const dir of fs.readdirSync(subagentsDir)) {
    const dirPath = path.join(subagentsDir, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const agentMd = path.join(dirPath, 'AGENT.md');
    if (!fs.existsSync(agentMd)) continue;

    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) continue;

    if (seen.has(dir)) continue;
    seen.add(dir);

    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .sort();

    subagents.push({
      name: dir,
      path: dirPath,
      files,
      frontmatter,
    });
  }
  }

  return subagents;
}

/**
 * Get a specific installed subagent
 */
export function getInstalledSubagent(name: string): InstalledSubagent | null {
  // Check user dir first, then system
  for (const subagentsDir of [getUserSubagentsDir(), getSubagentsDir()]) {
    const dirPath = path.join(subagentsDir, name);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;
    const agentMd = path.join(dirPath, 'AGENT.md');
    if (!fs.existsSync(agentMd)) continue;
    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) continue;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md')).sort();
    return { name, path: dirPath, files, frontmatter };
  }
  return null;
}

/**
 * Install a subagent centrally to ~/.agents/subagents/{name}/
 */
export function installSubagentCentrally(
  sourcePath: string,
  name: string
): { success: boolean; error?: string } {
  const subagentsDir = getUserSubagentsDir();
  const targetDir = safeJoin(subagentsDir, name);

  try {
    // Ensure subagents directory exists
    if (!fs.existsSync(subagentsDir)) {
      fs.mkdirSync(subagentsDir, { recursive: true });
    }

    // Remove existing if present
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true });
    }

    // Copy entire directory
    fs.cpSync(sourcePath, targetDir, { recursive: true });

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Remove an installed subagent
 */
export function removeSubagent(name: string): { success: boolean; error?: string } {
  for (const subagentsDir of [getUserSubagentsDir(), getSubagentsDir()]) {
    const candidate = safeJoin(subagentsDir, name);
    if (fs.existsSync(candidate)) {
      try {
        fs.rmSync(candidate, { recursive: true });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  }
  return { success: false, error: `Subagent '${name}' not found` };
}

/**
 * Transform a subagent directory into a single .md file for Claude
 * Combines AGENT.md frontmatter + body with other files as sections
 */
export function transformSubagentForClaude(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  // Build the frontmatter section
  const frontmatterYaml = yaml.stringify({
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.model && { model: frontmatter.model }),
    ...(frontmatter.color && { color: frontmatter.color }),
  }).trim();

  let result = `---\n${frontmatterYaml}\n---\n\n${body}`;

  // Append other .md files as sections
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();

  for (const file of files) {
    const filePath = path.join(subagentDir, file);
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    // Convert filename to title case (SOUL.md -> Soul)
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    result += `\n\n## ${title}\n\n${content}`;
  }

  return result;
}

/**
 * Transform a subagent into a Factory AI Droid "custom droid" .md file.
 *
 * Mirrors transformSubagentForClaude (flatten frontmatter + body + appended
 * .md sections), but emits only frontmatter keys Factory recognizes
 * (name, description, model). Factory has no `color` field, so it is dropped.
 * See https://docs.factory.ai/cli/configuration/custom-droids.
 */
export function transformSubagentForDroid(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const frontmatterYaml = yaml.stringify({
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.model && { model: frontmatter.model }),
  }).trim();

  let result = `---\n${frontmatterYaml}\n---\n\n${body}`;

  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();

  for (const file of files) {
    const filePath = path.join(subagentDir, file);
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    result += `\n\n## ${title}\n\n${content}`;
  }

  return result;
}

/**
 * Sync a subagent to an OpenClaw workspace
 * Copies full directory, renames AGENT.md to AGENTS.md
 */
export function syncSubagentToOpenclaw(
  subagentDir: string,
  targetDir: string
): { success: boolean; error?: string } {
  try {
    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Copy all files
    for (const file of fs.readdirSync(subagentDir)) {
      const sourcePath = path.join(subagentDir, file);
      const targetFile = file === 'AGENT.md' ? 'AGENTS.md' : file;
      const targetPath = path.join(targetDir, targetFile);

      if (fs.statSync(sourcePath).isFile()) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Install a subagent to a specific agent's home
 */
export function installSubagentToAgent(
  subagentDir: string,
  subagentName: string,
  agent: AgentId,
  agentHome: string
): { success: boolean; error?: string } {
  if (agent === 'claude') {
    // Claude: flatten to single .md file
    const agentsDir = path.join(agentHome, '.claude', 'agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }

    try {
      const transformed = transformSubagentForClaude(subagentDir);
      fs.writeFileSync(safeJoin(agentsDir, `${subagentName}.md`), transformed);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  } else if (agent === 'openclaw') {
    // OpenClaw: copy full directory
    const targetDir = safeJoin(path.join(agentHome, '.openclaw'), subagentName);
    return syncSubagentToOpenclaw(subagentDir, targetDir);
  } else {
    // Other agents don't support subagents yet
    return { success: false, error: `Agent '${agent}' does not support subagents` };
  }
}

/**
 * Remove a subagent from a specific agent's home
 */
export function removeSubagentFromAgent(
  subagentName: string,
  agent: AgentId,
  agentHome: string
): { success: boolean; error?: string } {
  try {
    if (agent === 'claude') {
      const targetPath = safeJoin(path.join(agentHome, '.claude', 'agents'), `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      return { success: true };
    } else if (agent === 'openclaw') {
      const targetDir = safeJoin(path.join(agentHome, '.openclaw'), subagentName);
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true });
      }
      return { success: true };
    } else {
      return { success: true }; // No-op for unsupported agents
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Check if subagent content matches between source and installed
 */
export function subagentContentMatches(installedDir: string, sourceDir: string): boolean {
  if (!fs.existsSync(installedDir) || !fs.existsSync(sourceDir)) {
    return false;
  }

  const installedFiles = fs.readdirSync(installedDir).filter(f => f.endsWith('.md')).sort();
  const sourceFiles = fs.readdirSync(sourceDir).filter(f => f.endsWith('.md')).sort();

  if (installedFiles.length !== sourceFiles.length) {
    return false;
  }

  for (let i = 0; i < installedFiles.length; i++) {
    if (installedFiles[i] !== sourceFiles[i]) {
      return false;
    }

    const installedContent = fs.readFileSync(path.join(installedDir, installedFiles[i]), 'utf-8');
    const sourceContent = fs.readFileSync(path.join(sourceDir, sourceFiles[i]), 'utf-8');

    if (installedContent !== sourceContent) {
      return false;
    }
  }

  return true;
}

// SUBAGENT_CAPABLE_AGENTS removed — use `capableAgents('subagents')` from
// lib/capabilities.ts. The capability matrix on AgentConfig is the single
// source of truth.

/**
 * List subagents installed to a specific agent's home
 * Claude: scans ~/.claude/agents/{name}.md
 * OpenClaw: scans ~/.openclaw/{name}/AGENTS.md
 */
export function listSubagentsForAgent(
  agentId: AgentId,
  home: string
): InstalledSubagent[] {
  const subagents: InstalledSubagent[] = [];

  if (agentId === 'claude') {
    // Claude: flat .md files in agents/
    const agentsDir = path.join(home, '.claude', 'agents');
    if (!fs.existsSync(agentsDir)) return subagents;

    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(agentsDir, file);
      if (!fs.statSync(filePath).isFile()) continue;

      const frontmatter = parseSubagentFrontmatter(filePath);
      if (!frontmatter) continue;

      const name = file.replace('.md', '');
      subagents.push({
        name,
        path: filePath,
        files: [file],
        frontmatter,
      });
    }
  } else if (agentId === 'openclaw') {
    // OpenClaw: directories with AGENTS.md
    const openclawDir = path.join(home, '.openclaw');
    if (!fs.existsSync(openclawDir)) return subagents;

    for (const dir of fs.readdirSync(openclawDir)) {
      const dirPath = path.join(openclawDir, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;

      // OpenClaw uses AGENTS.md (not AGENT.md)
      const agentsMd = path.join(dirPath, 'AGENTS.md');
      if (!fs.existsSync(agentsMd)) continue;

      // Parse frontmatter - OpenClaw may not have standard frontmatter
      // Try to extract name/description from content
      const content = fs.readFileSync(agentsMd, 'utf-8');
      let frontmatter: SubagentFrontmatter = {
        name: dir,
        description: '',
      };

      // Try to parse frontmatter if present
      const parsed = parseSubagentFrontmatter(agentsMd);
      if (parsed) {
        frontmatter = parsed;
      } else {
        // Extract first non-empty line as description
        const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
        frontmatter.description = firstLine?.slice(0, 80) || `OpenClaw agent: ${dir}`;
      }

      const files = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.md'))
        .sort();

      subagents.push({
        name: dir,
        path: dirPath,
        files,
        frontmatter,
      });
    }
  }

  return subagents;
}

export interface VersionSubagentDiff {
  agent: AgentId;
  version: string;
  orphans: string[];
}

/**
 * Compare a version home's subagents against discovered subagents.
 * Returns orphan subagent names.
 */
export function diffVersionSubagents(agent: AgentId, version: string): VersionSubagentDiff {
  const versionHome = getVersionHomePath(agent, version);
  const orphans: string[] = [];

  // Get all discovered subagent names
  const discovered = new Set<string>();
  for (const dir of [getSubagentsDir(), getUserSubagentsDir()]) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          discovered.add(entry.name);
        }
      }
    }
  }

  // Check what's installed
  if (agent === 'claude') {
    const agentsDir = path.join(versionHome, '.claude', 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.md')) continue;
        const name = path.basename(file, '.md');
        if (!discovered.has(name)) {
          orphans.push(name);
        }
      }
    }
  } else if (agent === 'openclaw') {
    const openclawDir = path.join(versionHome, '.openclaw');
    if (fs.existsSync(openclawDir)) {
      for (const entry of fs.readdirSync(openclawDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!discovered.has(entry.name)) {
          orphans.push(entry.name);
        }
      }
    }
  }

  return { agent, version, orphans: orphans.sort() };
}

/**
 * Iterate all (agent, version) pairs that support subagents and are installed.
 */
export function iterSubagentsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const agents = filter?.agent ? [filter.agent] : capableAgents('subagents');
  for (const agent of agents) {
    if (!capableAgents('subagents').includes(agent)) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

/**
 * Remove a single subagent from a specific version home.
 * Soft-deletes to ~/.agents/.trash/subagents/.
 */
export function removeSubagentFromVersion(
  agent: AgentId,
  version: string,
  subagentName: string
): { success: boolean; error?: string } {
  const versionHome = getVersionHomePath(agent, version);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = path.join(getTrashSubagentsDir(), agent, version, subagentName);

  try {
    if (agent === 'claude') {
      const targetPath = path.join(versionHome, '.claude', 'agents', `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetPath, path.join(trashDir, `${subagentName}.md.${stamp}`));
      }
    } else if (agent === 'openclaw') {
      const targetDir = path.join(versionHome, '.openclaw', subagentName);
      if (fs.existsSync(targetDir)) {
        const trashDest = path.join(trashDir, stamp);
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetDir, trashDest);
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
