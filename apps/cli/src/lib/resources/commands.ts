/**
 * Commands resource handler.
 *
 * Commands are slash-command definitions stored as .md files (Claude/Codex/Cursor/OpenCode)
 * or .toml files (Gemini). This handler resolves commands across layers (project > user > system),
 * handles format conversion during sync, and provides consistent list/resolve/sync behavior.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, Layer, ResolvedItem, ResourceHandler, ResourceKind } from './types.js';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getSystemAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';
import { AGENTS, agentConfigDirName } from '../agents.js';
import { markdownToToml } from '../convert.js';

/** Command item metadata. */
export interface CommandItem {
  name: string;
  description: string;
  content: string;
  format: 'md' | 'toml';
}

/**
 * Get the commands directory for a given layer root.
 */
function getCommandsDirForRoot(root: string): string {
  return path.join(root, 'commands');
}

/**
 * Parse a command file and extract metadata.
 */
function parseCommandFile(filePath: string): CommandItem | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const format = filePath.endsWith('.toml') ? 'toml' : 'md';
    const name = path.basename(filePath).replace(/\.(md|toml)$/, '');

    let description = '';

    if (format === 'md') {
      // Parse YAML frontmatter for description
      const lines = content.split('\n');
      if (lines[0] === '---') {
        const endIndex = lines.slice(1).findIndex((l) => l === '---');
        if (endIndex > 0) {
          const frontmatter = lines.slice(1, endIndex + 1).join('\n');
          const descMatch = frontmatter.match(/description:\s*(.+)/i);
          if (descMatch) description = descMatch[1].trim();
        }
      }
    } else {
      // Parse TOML for description
      const descMatch = content.match(/description\s*=\s*"([^"]+)"/);
      if (descMatch) description = descMatch[1];
    }

    return { name, description, content, format };
  } catch {
    return null;
  }
}

/**
 * List command files in a directory.
 */
function listCommandsInDir(dir: string): Array<{ name: string; path: string; format: 'md' | 'toml' }> {
  if (!fs.existsSync(dir)) return [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const commands: Array<{ name: string; path: string; format: 'md' | 'toml' }> = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        if (entry.name.endsWith('.md')) {
          commands.push({
            name: entry.name.replace('.md', ''),
            path: path.join(dir, entry.name),
            format: 'md',
          });
        } else if (entry.name.endsWith('.toml')) {
          commands.push({
            name: entry.name.replace('.toml', ''),
            path: path.join(dir, entry.name),
            format: 'toml',
          });
        }
      }
    }

    return commands;
  } catch {
    return [];
  }
}

/**
 * Commands resource handler implementing ResourceHandler<CommandItem>.
 */
export class CommandsHandler implements ResourceHandler<CommandItem> {
  readonly kind: ResourceKind = 'command';

  /**
   * List all commands across layers, with higher layer winning on name conflict.
   * Returns a union of all commands, deduplicated by name.
   */
  listAll(agent: AgentId, cwd?: string): ResolvedItem<CommandItem>[] {
    const seen = new Set<string>();
    const results: ResolvedItem<CommandItem>[] = [];
    const projectDir = getProjectAgentsDir(cwd);
    const extraRepos = getEnabledExtraRepos();

    // Build layer roots in precedence order: project > user > system > extras
    const roots: Array<{ dir: string; layer: Layer }> = [];

    if (projectDir) {
      roots.push({ dir: getCommandsDirForRoot(projectDir), layer: 'project' });
    }
    roots.push({ dir: getCommandsDirForRoot(getUserAgentsDir()), layer: 'user' });
    roots.push({ dir: getCommandsDirForRoot(getSystemAgentsDir()), layer: 'system' });

    for (const extra of extraRepos) {
      roots.push({ dir: getCommandsDirForRoot(extra.dir), layer: 'system' });
    }

    for (const { dir, layer } of roots) {
      const commands = listCommandsInDir(dir);

      for (const cmd of commands) {
        if (seen.has(cmd.name)) continue;
        seen.add(cmd.name);

        const item = parseCommandFile(cmd.path);
        if (item) {
          results.push({
            name: cmd.name,
            item,
            layer,
            path: cmd.path,
          });
        }
      }
    }

    return results;
  }

  /**
   * Resolve a single command by name.
   * Returns the winning layer's version, or null if not found.
   */
  resolve(agent: AgentId, name: string, cwd?: string): ResolvedItem<CommandItem> | null {
    const projectDir = getProjectAgentsDir(cwd);
    const extraRepos = getEnabledExtraRepos();

    // Build candidate paths in precedence order
    const candidates: Array<{ dir: string; layer: Layer }> = [];

    if (projectDir) {
      candidates.push({ dir: getCommandsDirForRoot(projectDir), layer: 'project' });
    }
    candidates.push({ dir: getCommandsDirForRoot(getUserAgentsDir()), layer: 'user' });
    candidates.push({ dir: getCommandsDirForRoot(getSystemAgentsDir()), layer: 'system' });

    for (const extra of extraRepos) {
      candidates.push({ dir: getCommandsDirForRoot(extra.dir), layer: 'system' });
    }

    for (const { dir, layer } of candidates) {
      // Try .md first, then .toml
      for (const ext of ['.md', '.toml']) {
        const filePath = path.join(dir, `${name}${ext}`);
        const item = parseCommandFile(filePath);
        if (item) {
          return { name, item, layer, path: filePath };
        }
      }
    }

    return null;
  }

  /**
   * Sync resolved commands to the agent's version home directory.
   * Copies/transforms commands as needed for the agent's expected format.
   */
  sync(agent: AgentId, versionHome: string, cwd?: string): void {
    const agentConfig = AGENTS[agent];
    const targetFormat = this.format(agent);
    const targetDir = path.join(versionHome, agentConfigDirName(agent), this.targetDir(agent));

    // Ensure target directory exists
    fs.mkdirSync(targetDir, { recursive: true });

    // Get all resolved commands
    const commands = this.listAll(agent, cwd);

    for (const resolved of commands) {
      const ext = targetFormat === 'toml' ? '.toml' : '.md';
      const targetPath = path.join(targetDir, `${resolved.name}${ext}`);

      // Convert format if needed
      if (targetFormat === 'toml' && resolved.item.format === 'md') {
        // Convert markdown to TOML
        const tomlContent = markdownToToml(resolved.name, resolved.item.content);
        fs.writeFileSync(targetPath, tomlContent, 'utf-8');
      } else if (targetFormat === 'md' && resolved.item.format === 'toml') {
        // For now, copy TOML as-is if target expects md (edge case)
        // In practice, source commands are always .md
        fs.copyFileSync(resolved.path, targetPath);
      } else {
        // Same format, copy directly
        fs.copyFileSync(resolved.path, targetPath);
      }
    }
  }

  /**
   * Get the file format this resource uses for a given agent.
   */
  format(agent: AgentId): 'md' | 'toml' {
    const agentConfig = AGENTS[agent];
    return agentConfig.format === 'toml' ? 'toml' : 'md';
  }

  /**
   * Get the target directory name in the agent's version home.
   */
  targetDir(agent: AgentId): string {
    const agentConfig = AGENTS[agent];
    return agentConfig.commandsSubdir || 'commands';
  }
}

/** Singleton instance of the commands handler. */
export const commandsHandler = new CommandsHandler();
