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
 * Transform a subagent into a GitHub Copilot CLI custom agent `.agent.md` file.
 *
 * Copilot custom agents are Markdown profiles with YAML frontmatter stored in
 * `~/.copilot/agents/` (user) or `.github/agents/` (project). The file name
 * ends in `.agent.md` and the frontmatter carries `name`, `description`, and
 * optionally `model` and `tools`. The emitted body is identical to Factory
 * Droid's custom-droid format (flatten frontmatter + body + appended .md
 * sections, `color` dropped), so this is an alias of transformSubagentForDroid.
 * See GitHub docs for custom agents.
 */
export const transformSubagentForCopilot = transformSubagentForDroid;

/**
 * Transform a subagent into a Cursor CLI custom subagent `.md` file.
 *
 * Cursor loads subagents from `.cursor/agents/*.md` (project) or
 * `~/.cursor/agents/*.md` (user) — Markdown with YAML frontmatter
 * (name, description, model; also readonly/is_background, which our
 * frontmatter schema doesn't carry). Cursor has no `color` field, so this is
 * an alias of transformSubagentForDroid, same as Copilot.
 * See https://cursor.com/docs/subagents.
 */
export const transformSubagentForCursor = transformSubagentForDroid;

/**
 * Transform a subagent into a ForgeCode custom subagent `.md` file.
 *
 * ForgeCode loads named agents from `.forge/agents/*.md` (project) or
 * `~/.forge/agents/*.md` (user) — Markdown with YAML frontmatter (id, title,
 * description, tools, model, temperature) + a system-prompt body. ForgeCode has
 * no `color` field, so this is an alias of transformSubagentForDroid, same as
 * Copilot/Cursor. See https://forgecode.dev/docs/agent-definition-guide/.
 */
export const transformSubagentForForge = transformSubagentForDroid;

/**
 * Transform a subagent into Antigravity's custom-agent markdown shape.
 *
 * Antigravity exposes custom agents as Markdown files with YAML frontmatter,
 * close to Gemini CLI subagents. Keep portable frontmatter fields and flatten
 * sibling markdown files into the prompt body like the other markdown-backed
 * agents.
 */
export function transformSubagentForAntigravity(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const frontmatterYaml = yaml.stringify({
    name: frontmatter.name,
    description: frontmatter.description,
    kind: 'local',
    ...(frontmatter.model && { model: frontmatter.model }),
  }).trim();

  let result = `---\n${frontmatterYaml}\n---\n\n${body}`;
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();

  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    result += `\n\n## ${title}\n\n${content}`;
  }

  return `${result.trim()}\n`;
}

/**
 * Transform a subagent into an OpenCode agent markdown file.
 *
 * OpenCode loads agents from ~/.config/opencode/agents/*.md (global) with
 * YAML frontmatter (description required; mode: subagent for invocable
 * subagents) and a prompt body. File stem becomes the agent name.
 * https://opencode.ai/docs/agents/
 */
export function transformSubagentForOpenCode(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const fm: Record<string, unknown> = {
    description: frontmatter.description,
    mode: 'subagent',
  };
  if (frontmatter.model) fm.model = frontmatter.model;

  let systemPrompt = body.trim();
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();
  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    systemPrompt += `\n\n## ${title}\n\n${content}`;
  }

  return `---\n${yaml.stringify(fm).trim()}\n---\n\n${systemPrompt}\n`;
}

/** Managed parent agent file for Kimi (underscore prefix avoids clobbering a user subagent named agents-cli). */
export const KIMI_SUBAGENTS_PARENT_FILE = '_agents-cli.yaml';

export interface KimiSubagentFiles {
  /** Agent YAML content (uses system_prompt_path, not inline system_prompt). */
  yaml: string;
  /** Markdown body written next to the YAML and referenced by system_prompt_path. */
  systemPrompt: string;
  /** Sibling prompt filename, e.g. `reviewer.system.md`. */
  systemPromptFileName: string;
}

/**
 * Transform a subagent into Kimi Code agent files.
 *
 * Kimi's schema (agentspec) only accepts `system_prompt_path` (path relative to
 * the agent YAML) — there is no inline `system_prompt` key. We write:
 *   ~/.kimi-code/agents/<name>.yaml          — agent YAML
 *   ~/.kimi-code/agents/<name>.system.md     — system prompt body
 * plus a managed parent `_agents-cli.yaml` that lists them under agent.subagents
 * for `kimi --agent-file …/_agents-cli.yaml`.
 * https://moonshotai.github.io/kimi-cli/en/customization/agents.html
 */
export function transformSubagentForKimi(subagentDir: string, fileBaseName: string): KimiSubagentFiles {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  let systemPrompt = body.trim();
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();
  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    systemPrompt += `\n\n## ${title}\n\n${content}`;
  }

  const systemPromptFileName = `${fileBaseName}.system.md`;
  const doc: Record<string, unknown> = {
    version: 1,
    agent: {
      extend: 'default',
      name: frontmatter.name,
      description: frontmatter.description,
      system_prompt_path: `./${systemPromptFileName}`,
    },
  };
  if (frontmatter.model) {
    (doc.agent as Record<string, unknown>).model = frontmatter.model;
  }
  return {
    yaml: yaml.stringify(doc),
    systemPrompt,
    systemPromptFileName,
  };
}

/**
 * Build the managed parent agent YAML that declares all installed subagents
 * so `kimi --agent-file ~/.kimi-code/agents/_agents-cli.yaml` can launch them.
 */
export function buildKimiSubagentsParentYaml(
  entries: Array<{ name: string; description: string; relativePath: string }>
): string {
  const subagents: Record<string, { path: string; description: string }> = {};
  for (const e of entries) {
    subagents[e.name] = { path: e.relativePath, description: e.description };
  }
  return yaml.stringify({
    version: 1,
    agent: {
      extend: 'default',
      name: 'agents-cli',
      description: 'Managed parent agent listing agents-cli synced subagents',
      subagents,
    },
  });
}

/** Write a Kimi subagent YAML + sibling system-prompt md into agentsDir. */
export function writeKimiSubagentFiles(agentsDir: string, subagentDir: string, name: string): void {
  const { yaml: yml, systemPrompt, systemPromptFileName } = transformSubagentForKimi(subagentDir, name);
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(safeJoin(agentsDir, `${name}.yaml`), yml);
  fs.writeFileSync(safeJoin(agentsDir, systemPromptFileName), systemPrompt);
}

/**
 * Transform a subagent into a Codex custom-agent TOML file.
 *
 * Codex loads standalone TOML under ~/.codex/agents/*.toml. Required fields:
 * name, description, developer_instructions. Optional model maps from our
 * frontmatter when present.
 * https://developers.openai.com/codex/subagents (custom agents section)
 */
export function transformSubagentForCodex(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const instructions = flattenSubagentInstructions(subagentDir);

  // Escape TOML multi-line string (""") content — only """ needs escaping.
  const safeInstructions = instructions.replace(/"""/g, '\\"""');
  const safeName = frontmatter.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeDesc = frontmatter.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  let toml = `name = "${safeName}"\n`;
  toml += `description = "${safeDesc}"\n`;
  if (frontmatter.model) {
    const safeModel = String(frontmatter.model).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    toml += `model = "${safeModel}"\n`;
  }
  toml += `developer_instructions = """\n${safeInstructions}\n"""\n`;
  return toml;
}

function flattenSubagentInstructions(subagentDir: string): string {
  let instructions = getSubagentBody(path.join(subagentDir, 'AGENT.md')).trim();
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();
  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    instructions += `\n\n## ${title}\n\n${content}`;
  }

  return instructions;
}

/**
 * Transform a subagent into a Kiro CLI custom-agent JSON file.
 *
 * Kiro custom agents live in `~/.kiro/agents/<name>.json` (or `.kiro/agents/`
 * workspace-local) and declare name, description, prompt, tools, and optional
 * model. We flatten the AGENT.md frontmatter + body plus any sibling .md files
 * as sections into a single `prompt`, and expose the standard built-in tool
 * set so the subagent can actually run.
 */
export function transformSubagentForKiro(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();

  let prompt = body;
  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    prompt += `\n\n## ${title}\n\n${content}`;
  }

  const config: Record<string, unknown> = {
    name: frontmatter.name,
    description: frontmatter.description,
    prompt,
    tools: ['read', 'write', 'shell', 'web_search', 'web_fetch'],
  };
  if (frontmatter.model) {
    config.model = frontmatter.model;
  }

  return JSON.stringify(config, null, 2);
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
  if (agent === 'claude' || agent === 'gemini' || agent === 'grok') {
    // Claude / Gemini / Grok: flatten to single .md under the native agents dir.
    const agentsRoot = agent === 'grok' ? '.grok' : agent === 'gemini' ? '.gemini' : '.claude';
    const agentsDir = path.join(agentHome, agentsRoot, 'agents');
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
  } else if (agent === 'codex') {
    // Codex: standalone TOML under ~/.codex/agents/<name>.toml
    const agentsDir = path.join(agentHome, '.codex', 'agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    try {
      const toml = transformSubagentForCodex(subagentDir);
      fs.writeFileSync(safeJoin(agentsDir, `${subagentName}.toml`), toml);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  } else if (agent === 'kimi') {
    // Kimi: YAML + sibling system-prompt md under ~/.kimi-code/agents/
    try {
      writeKimiSubagentFiles(path.join(agentHome, '.kimi-code', 'agents'), subagentDir, subagentName);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  } else if (agent === 'opencode') {
    // OpenCode: markdown agents under ~/.config/opencode/agents/
    const agentsDir = path.join(agentHome, '.config', 'opencode', 'agents');
    if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
    try {
      fs.writeFileSync(safeJoin(agentsDir, `${subagentName}.md`), transformSubagentForOpenCode(subagentDir));
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  } else if (agent === 'antigravity') {
    // Antigravity: custom-agent markdown under ~/.gemini/config/agents/<name>/agent.md.
    const agentDir = safeJoin(path.join(agentHome, '.gemini', 'config', 'agents'), subagentName);
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
    try {
      fs.writeFileSync(safeJoin(agentDir, 'agent.md'), transformSubagentForAntigravity(subagentDir));
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  } else if (agent === 'openclaw') {
    // OpenClaw: copy full directory
    const targetDir = safeJoin(path.join(agentHome, '.openclaw'), subagentName);
    return syncSubagentToOpenclaw(subagentDir, targetDir);
  } else if (agent === 'kiro') {
    // Kiro: JSON custom-agent file under ~/.kiro/agents/
    const agentsDir = path.join(agentHome, '.kiro', 'agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    try {
      const transformed = transformSubagentForKiro(subagentDir);
      fs.writeFileSync(safeJoin(agentsDir, `${subagentName}.json`), transformed);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  } else if (agent === 'cursor') {
    // Cursor: flattened .md custom subagent under ~/.cursor/agents/
    const agentsDir = path.join(agentHome, '.cursor', 'agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    try {
      const transformed = transformSubagentForCursor(subagentDir);
      fs.writeFileSync(safeJoin(agentsDir, `${subagentName}.md`), transformed);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  } else if (agent === 'forge') {
    // ForgeCode: flattened .md custom subagent under ~/.forge/agents/
    const agentsDir = path.join(agentHome, '.forge', 'agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    try {
      const transformed = transformSubagentForForge(subagentDir);
      fs.writeFileSync(safeJoin(agentsDir, `${subagentName}.md`), transformed);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
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
    if (agent === 'claude' || agent === 'gemini' || agent === 'grok') {
      const agentsRoot = agent === 'grok' ? '.grok' : agent === 'gemini' ? '.gemini' : '.claude';
      const targetPath = safeJoin(path.join(agentHome, agentsRoot, 'agents'), `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      return { success: true };
    } else if (agent === 'codex') {
      const targetPath = safeJoin(path.join(agentHome, '.codex', 'agents'), `${subagentName}.toml`);
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      return { success: true };
    } else if (agent === 'kimi') {
      const agentsDir = path.join(agentHome, '.kimi-code', 'agents');
      const targetPath = safeJoin(agentsDir, `${subagentName}.yaml`);
      const promptPath = safeJoin(agentsDir, `${subagentName}.system.md`);
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
      return { success: true };
    } else if (agent === 'opencode') {
      const targetPath = safeJoin(path.join(agentHome, '.config', 'opencode', 'agents'), `${subagentName}.md`);
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      return { success: true };
    } else if (agent === 'antigravity') {
      const targetDir = safeJoin(path.join(agentHome, '.gemini', 'config', 'agents'), subagentName);
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      return { success: true };
    } else if (agent === 'openclaw') {
      const targetDir = safeJoin(path.join(agentHome, '.openclaw'), subagentName);
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true });
      }
      return { success: true };
    } else if (agent === 'kiro') {
      const targetPath = safeJoin(path.join(agentHome, '.kiro', 'agents'), `${subagentName}.json`);
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      return { success: true };
    } else if (agent === 'cursor') {
      const targetPath = safeJoin(path.join(agentHome, '.cursor', 'agents'), `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      return { success: true };
    } else if (agent === 'forge') {
      const targetPath = safeJoin(path.join(agentHome, '.forge', 'agents'), `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
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
 * Claude/Gemini/Grok: scans ~/.{agent}/agents/{name}.md
 * Kimi: scans ~/.kimi-code/agents/{name}.yaml (+ sibling .system.md)
 * Kiro: scans ~/.kiro/agents/{name}.json
 * OpenClaw: scans ~/.openclaw/{name}/AGENTS.md
 */
export function listSubagentsForAgent(
  agentId: AgentId,
  home: string
): InstalledSubagent[] {
  const subagents: InstalledSubagent[] = [];

  if (agentId === 'claude' || agentId === 'gemini' || agentId === 'grok') {
    // Claude / Gemini / Grok: flat .md files in agents/
    const agentsRoot = agentId === 'grok' ? '.grok' : agentId === 'gemini' ? '.gemini' : '.claude';
    const agentsDir = path.join(home, agentsRoot, 'agents');
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
  } else if (agentId === 'kimi') {
    // Kimi: flat YAML under .kimi-code/agents/ (exclude managed parent _*.yaml)
    const agentsDir = path.join(home, '.kimi-code', 'agents');
    if (!fs.existsSync(agentsDir)) return subagents;

    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.yaml') || file.startsWith('_')) continue;
      const filePath = path.join(agentsDir, file);
      if (!fs.statSync(filePath).isFile()) continue;

      const name = file.replace(/\.yaml$/, '');
      let description = '';
      try {
        const parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8')) as {
          agent?: { description?: string; name?: string };
        } | null;
        description = parsed?.agent?.description ?? '';
      } catch { /* leave description empty */ }

      const files = [file];
      const promptFile = `${name}.system.md`;
      if (fs.existsSync(path.join(agentsDir, promptFile))) files.push(promptFile);

      subagents.push({
        name,
        path: filePath,
        files,
        frontmatter: { name, description },
      });
    }
  } else if (agentId === 'opencode') {
    const agentsDir = path.join(home, '.config', 'opencode', 'agents');
    if (!fs.existsSync(agentsDir)) return subagents;
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(agentsDir, file);
      if (!fs.statSync(filePath).isFile()) continue;
      const name = file.replace(/\.md$/, '');
      const frontmatter = parseSubagentFrontmatter(filePath) ?? { name, description: '' };
      subagents.push({ name, path: filePath, files: [file], frontmatter });
    }
  } else if (agentId === 'antigravity') {
    const agentsDir = path.join(home, '.gemini', 'config', 'agents');
    if (!fs.existsSync(agentsDir)) return subagents;
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(agentsDir, entry.name, 'agent.md');
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const frontmatter = parseSubagentFrontmatter(filePath) ?? { name: entry.name, description: '' };
      subagents.push({ name: entry.name, path: filePath, files: ['agent.md'], frontmatter });
    }
  } else if (agentId === 'copilot') {
    // Copilot: flat `<name>.agent.md` files under ~/.copilot/agents/
    const agentsDir = path.join(home, '.copilot', 'agents');
    if (!fs.existsSync(agentsDir)) return subagents;
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.agent.md')) continue;
      const filePath = path.join(agentsDir, file);
      if (!fs.statSync(filePath).isFile()) continue;
      const name = file.replace(/\.agent\.md$/, '');
      const frontmatter = parseSubagentFrontmatter(filePath) ?? { name, description: '' };
      subagents.push({ name, path: filePath, files: [file], frontmatter });
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
  } else if (agentId === 'kiro') {
    // Kiro: JSON files under ~/.kiro/agents/
    const agentsDir = path.join(home, '.kiro', 'agents');
    if (!fs.existsSync(agentsDir)) return subagents;

    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(agentsDir, file);
      if (!fs.statSync(filePath).isFile()) continue;

      let frontmatter: SubagentFrontmatter;
      try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { name?: string; description?: string; model?: string };
        frontmatter = {
          name: config.name || file.replace('.json', ''),
          description: config.description || '',
          model: config.model,
        };
      } catch {
        continue;
      }

      const name = file.replace('.json', '');
      subagents.push({
        name,
        path: filePath,
        files: [file],
        frontmatter,
      });
    }
  } else if (agentId === 'cursor') {
    // Cursor: flat `<name>.md` files under ~/.cursor/agents/
    const agentsDir = path.join(home, '.cursor', 'agents');
    if (!fs.existsSync(agentsDir)) return subagents;
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(agentsDir, file);
      if (!fs.statSync(filePath).isFile()) continue;
      const name = file.replace(/\.md$/, '');
      const frontmatter = parseSubagentFrontmatter(filePath) ?? { name, description: '' };
      subagents.push({ name, path: filePath, files: [file], frontmatter });
    }
  } else if (agentId === 'forge') {
    // ForgeCode: flat `<name>.md` files under ~/.forge/agents/
    const agentsDir = path.join(home, '.forge', 'agents');
    if (!fs.existsSync(agentsDir)) return subagents;
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(agentsDir, file);
      if (!fs.statSync(filePath).isFile()) continue;
      const name = file.replace(/\.md$/, '');
      const frontmatter = parseSubagentFrontmatter(filePath) ?? { name, description: '' };
      subagents.push({ name, path: filePath, files: [file], frontmatter });
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
  if (agent === 'claude' || agent === 'gemini' || agent === 'grok') {
    const agentsRoot = agent === 'grok' ? '.grok' : agent === 'gemini' ? '.gemini' : '.claude';
    const agentsDir = path.join(versionHome, agentsRoot, 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.md')) continue;
        const name = path.basename(file, '.md');
        if (!discovered.has(name)) {
          orphans.push(name);
        }
      }
    }
  } else if (agent === 'kimi') {
    const agentsDir = path.join(versionHome, '.kimi-code', 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.yaml') || file.startsWith('_')) continue;
        const name = path.basename(file, '.yaml');
        if (!discovered.has(name)) {
          orphans.push(name);
        }
      }
    }
  } else if (agent === 'opencode') {
    const agentsDir = path.join(versionHome, '.config', 'opencode', 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.md')) continue;
        const name = path.basename(file, '.md');
        if (!discovered.has(name)) orphans.push(name);
      }
    }
  } else if (agent === 'antigravity') {
    const agentsDir = path.join(versionHome, '.gemini', 'config', 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!fs.existsSync(path.join(agentsDir, entry.name, 'agent.md'))) continue;
        if (!discovered.has(entry.name)) orphans.push(entry.name);
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
  } else if (agent === 'kiro') {
    const agentsDir = path.join(versionHome, '.kiro', 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.json')) continue;
        const name = path.basename(file, '.json');
        if (!discovered.has(name)) {
          orphans.push(name);
        }
      }
    }
  } else if (agent === 'cursor') {
    const agentsDir = path.join(versionHome, '.cursor', 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.md')) continue;
        const name = path.basename(file, '.md');
        if (!discovered.has(name)) orphans.push(name);
      }
    }
  } else if (agent === 'forge') {
    const agentsDir = path.join(versionHome, '.forge', 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.md')) continue;
        const name = path.basename(file, '.md');
        if (!discovered.has(name)) orphans.push(name);
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
    if (agent === 'claude' || agent === 'gemini' || agent === 'grok') {
      const agentsRoot = agent === 'grok' ? '.grok' : agent === 'gemini' ? '.gemini' : '.claude';
      const targetPath = path.join(versionHome, agentsRoot, 'agents', `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetPath, path.join(trashDir, `${subagentName}.md.${stamp}`));
      }
    } else if (agent === 'kimi') {
      const agentsDir = path.join(versionHome, '.kimi-code', 'agents');
      const yamlPath = path.join(agentsDir, `${subagentName}.yaml`);
      const promptPath = path.join(agentsDir, `${subagentName}.system.md`);
      if (fs.existsSync(yamlPath) || fs.existsSync(promptPath)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        if (fs.existsSync(yamlPath)) {
          fs.renameSync(yamlPath, path.join(trashDir, `${subagentName}.yaml.${stamp}`));
        }
        if (fs.existsSync(promptPath)) {
          fs.renameSync(promptPath, path.join(trashDir, `${subagentName}.system.md.${stamp}`));
        }
      }
    } else if (agent === 'opencode') {
      const targetPath = path.join(versionHome, '.config', 'opencode', 'agents', `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetPath, path.join(trashDir, `${subagentName}.md.${stamp}`));
      }
    } else if (agent === 'antigravity') {
      const targetDir = path.join(versionHome, '.gemini', 'config', 'agents', subagentName);
      if (fs.existsSync(targetDir)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetDir, path.join(trashDir, stamp));
      }
    } else if (agent === 'copilot') {
      const targetPath = path.join(versionHome, '.copilot', 'agents', `${subagentName}.agent.md`);
      if (fs.existsSync(targetPath)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetPath, path.join(trashDir, `${subagentName}.agent.md.${stamp}`));
      }
    } else if (agent === 'openclaw') {
      const targetDir = path.join(versionHome, '.openclaw', subagentName);
      if (fs.existsSync(targetDir)) {
        const trashDest = path.join(trashDir, stamp);
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetDir, trashDest);
      }
    } else if (agent === 'kiro') {
      const targetPath = path.join(versionHome, '.kiro', 'agents', `${subagentName}.json`);
      if (fs.existsSync(targetPath)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetPath, path.join(trashDir, `${subagentName}.json.${stamp}`));
      }
    } else if (agent === 'cursor') {
      const targetPath = path.join(versionHome, '.cursor', 'agents', `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetPath, path.join(trashDir, `${subagentName}.md.${stamp}`));
      }
    } else if (agent === 'forge') {
      const targetPath = path.join(versionHome, '.forge', 'agents', `${subagentName}.md`);
      if (fs.existsSync(targetPath)) {
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(targetPath, path.join(trashDir, `${subagentName}.md.${stamp}`));
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
