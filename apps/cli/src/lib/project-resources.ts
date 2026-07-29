import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, agentConfigDirName } from './agents.js';
import { supports } from './capabilities.js';
import { buildCommandSkillContent, commandSkillName, readSkillSourceCommandMarker, shouldInstallCommandAsSkill } from './command-skills.js';
import { commandAppliesTo, parseCommandMetadata } from './commands.js';
import { markdownToToml } from './convert.js';
import { safeJoin } from './paths.js';
import { subagentTarget } from './subagents-registry.js';
import { parseSubagentFrontmatter } from './subagents.js';
import type { AgentId, InstalledSubagent } from './types.js';
import { syncWorkflowToVersion } from './workflows.js';

const MANIFEST_FILE = '.agents-managed.json';
const MANIFEST_VERSION = 1;
const COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);

interface ProjectManagedManifest {
  v: typeof MANIFEST_VERSION;
  paths: string[];
}

export interface ProjectResourceSyncResult {
  synced: string[];
  skipped: string[];
}

type ProjectKind = 'commands' | 'skills' | 'subagents' | 'workflows';

export function projectAgentRoot(projectRoot: string, agent: AgentId): string {
  return path.join(projectRoot, agentConfigDirName(agent));
}

export function syncProjectResourcesToAgent(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
): ProjectResourceSyncResult {
  const projectRoot = path.dirname(projectAgentsDir);
  const agentRoot = projectAgentRoot(projectRoot, agent);
  const manifest = loadProjectManifest(agentRoot);
  const result: ProjectResourceSyncResult = { synced: [], skipped: [] };
  const next = new Set<string>();

  if (manifest) {
    for (const rel of manifest.paths) removeManagedPath(agentRoot, rel);
  }

  syncProjectCommands(agent, version, projectAgentsDir, agentRoot, result, next);
  syncProjectSkills(agent, version, projectAgentsDir, agentRoot, result, next);
  syncProjectSubagents(agent, version, projectAgentsDir, projectRoot, agentRoot, manifest, result, next);
  syncProjectWorkflows(agent, version, projectAgentsDir, projectRoot, agentRoot, result, next);

  if (next.size > 0 || manifest) {
    writeProjectManifest(agentRoot, Array.from(next).sort());
  }

  return result;
}

function loadProjectManifest(agentRoot: string): ProjectManagedManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(agentRoot, MANIFEST_FILE), 'utf-8')) as ProjectManagedManifest;
    if (raw.v !== MANIFEST_VERSION || !Array.isArray(raw.paths)) return null;
    if (!raw.paths.every((p) => typeof p === 'string' && p.length > 0)) return null;
    return { ...raw, paths: raw.paths.map(toPosixRel) };
  } catch {
    return null;
  }
}

function writeProjectManifest(agentRoot: string, paths: string[]): void {
  fs.mkdirSync(agentRoot, { recursive: true });
  const p = path.join(agentRoot, MANIFEST_FILE);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: MANIFEST_VERSION, paths }, null, 2));
  fs.renameSync(tmp, p);
}

function removeManagedPath(agentRoot: string, rel: string): void {
  if (path.isAbsolute(rel) || rel.includes('..')) return;
  const target = path.resolve(agentRoot, rel);
  const root = path.resolve(agentRoot);
  if (target !== root && !target.startsWith(root + path.sep)) return;
  removePath(target);
}

function removePath(p: string): void {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(p);
    else if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // already absent
  }
}

function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || COPY_IGNORE.has(entry.name)) continue;
    const s = safeJoin(src, entry.name);
    const d = safeJoin(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function projectEntries(projectAgentsDir: string, kind: ProjectKind): fs.Dirent[] {
  const dir = path.join(projectAgentsDir, kind);
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  } catch {
    return [];
  }
}

/**
 * Manifest paths are persisted to `.agents-managed.json`, which lives in the
 * version-controlled project dir and therefore travels between machines. Store
 * them POSIX-style: `path.join` yields `skills\myskill` on Windows, and a
 * manifest carrying that would silently fail to match — and so fail to clean up
 * its managed files — when the same project is synced on macOS or Linux.
 * Normalizing on both write and read also repairs manifests written by earlier
 * Windows builds.
 */
function toPosixRel(rel: string): string {
  return rel.replace(/\\/g, '/');
}

function record(
  kind: ProjectKind,
  name: string,
  relPaths: string[],
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  result.synced.push(`${kind}/${name}`);
  for (const rel of relPaths) manifestPaths.add(toPosixRel(rel));
}

function skip(dest: string, projectRoot: string, result: ProjectResourceSyncResult): void {
  const rel = path.relative(projectRoot, dest);
  result.skipped.push(rel);
  console.warn(`Skipping project resource target ${rel}: already exists and is user-owned`);
}

function syncProjectCommands(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
  agentRoot: string,
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  const cfg = AGENTS[agent];
  const commandsAsSkills = shouldInstallCommandAsSkill(agent, version);
  const supportsCommands = supports(agent, 'commands', version).ok;
  if (!commandsAsSkills && !supportsCommands) return;

  const projectRoot = path.dirname(projectAgentsDir);
  for (const entry of projectEntries(projectAgentsDir, 'commands')) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -'.md'.length);
    const srcFile = path.join(projectAgentsDir, 'commands', entry.name);
    const metadata = parseCommandMetadata(srcFile);
    if (!commandAppliesTo(agent, version, metadata).ok) continue;

    if (commandsAsSkills) {
      const sourceMarker = readSkillSourceCommandMarker(name, [path.join(projectAgentsDir, 'skills')]);
      if (pathExists(path.join(projectAgentsDir, 'skills', name)) && sourceMarker !== name) continue;
      const skillName = commandSkillName(name);
      const rel = path.join('skills', skillName);
      const destDir = path.join(agentRoot, rel);
      if (pathExists(destDir)) {
        skip(destDir, projectRoot, result);
        continue;
      }
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, 'SKILL.md'), buildCommandSkillContent(name, srcFile), 'utf-8');
      record('commands', name, [rel], result, manifestPaths);
      continue;
    }

    const ext = cfg.format === 'toml' ? '.toml' : '.md';
    const rel = path.join(cfg.commandsSubdir, `${name}${ext}`);
    const destFile = path.join(agentRoot, rel);
    if (pathExists(destFile)) {
      skip(destFile, projectRoot, result);
      continue;
    }
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    if (cfg.format === 'toml') {
      fs.writeFileSync(destFile, markdownToToml(name, fs.readFileSync(srcFile, 'utf-8')), 'utf-8');
    } else {
      fs.copyFileSync(srcFile, destFile);
    }
    record('commands', name, [rel], result, manifestPaths);
  }
}

function syncProjectSkills(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
  agentRoot: string,
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  if (!supports(agent, 'skills', version).ok) return;
  const projectRoot = path.dirname(projectAgentsDir);
  for (const entry of projectEntries(projectAgentsDir, 'skills')) {
    if (!entry.isDirectory()) continue;
    const srcDir = path.join(projectAgentsDir, 'skills', entry.name);
    if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) continue;
    const rel = path.join('skills', entry.name);
    const destDir = path.join(agentRoot, rel);
    if (pathExists(destDir)) {
      skip(destDir, projectRoot, result);
      continue;
    }
    copyDir(srcDir, destDir);
    record('skills', entry.name, [rel], result, manifestPaths);
  }
}

function readProjectSubagents(projectAgentsDir: string): Map<string, InstalledSubagent> {
  const map = new Map<string, InstalledSubagent>();
  for (const entry of projectEntries(projectAgentsDir, 'subagents')) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectAgentsDir, 'subagents', entry.name);
    const agentMd = path.join(dir, 'AGENT.md');
    if (!fs.existsSync(agentMd)) continue;
    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    map.set(entry.name, { name: entry.name, path: dir, files, frontmatter });
  }
  return map;
}

function syncProjectSubagents(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
  projectRoot: string,
  agentRoot: string,
  manifest: ProjectManagedManifest | null,
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  if (!supports(agent, 'subagents', version).ok) return;
  const target = subagentTarget(agent);
  if (!target) return;
  const all = readProjectSubagents(projectAgentsDir);
  const dir = target.dir(projectRoot);
  const targetDirRel = toPosixRel(path.relative(agentRoot, dir));
  const hadManagedTarget = manifest?.paths.some((rel) => rel === targetDirRel || rel.startsWith(targetDirRel + '/')) ?? false;

  for (const sub of all.values()) {
    const occupied = target.occupied(dir, sub.name);
    const existing = occupied.find((entry) => pathExists(entry.path));
    if (existing) {
      skip(existing.path, projectRoot, result);
      continue;
    }
    try {
      target.write(dir, sub);
      record('subagents', sub.name, occupied.map((entry) => path.relative(agentRoot, entry.path)), result, manifestPaths);
    } catch {
      // Malformed source or unsupported transform; skip this item.
    }
  }

  const syncedNames = result.synced
    .filter((name) => name.startsWith('subagents/'))
    .map((name) => name.slice('subagents/'.length))
    .filter((name) => all.has(name))
    .map((name) => all.get(name)!);
  if (target.finalize && (syncedNames.length > 0 || hadManagedTarget)) {
    target.finalize(dir, syncedNames);
    for (const entry of target.finalizeOccupied?.(dir) ?? []) {
      // Same normalization as record(): this is the one manifest write that
      // doesn't funnel through it (the parent subagent index, e.g. Kimi's
      // agents/_agents-cli.yaml).
      manifestPaths.add(toPosixRel(path.relative(agentRoot, entry.path)));
    }
  }
}

function workflowManagedRelPaths(agent: AgentId, projectRoot: string, name: string, workflowDir: string): string[] {
  if (agent === 'kimi') return [path.join('.kimi-code', 'skills', name)];
  if (agent === 'goose') {
    const rels = [path.join('.config', 'goose', 'recipes', `${name}.yaml`)];
    const subagentsDir = path.join(workflowDir, 'subagents');
    let hasSubagents = false;
    try {
      hasSubagents = fs.readdirSync(subagentsDir).some((f) => f.endsWith('.md'));
    } catch {
      hasSubagents = false;
    }
    if (hasSubagents) rels.push(path.join('.config', 'goose', 'recipes', `${name}.subrecipes`));
    return rels;
  }
  if (agent === 'openclaw') return [path.join('.openclaw', 'workflows', `${name}.lobster`)];
  return [path.join(agentConfigDirName(agent), 'workflows', name)];
}

function syncProjectWorkflows(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
  projectRoot: string,
  agentRoot: string,
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  if (!supports(agent, 'workflows', version).ok) return;
  if (agent === 'antigravity') return;

  for (const entry of projectEntries(projectAgentsDir, 'workflows')) {
    if (!entry.isDirectory()) continue;
    const workflowDir = path.join(projectAgentsDir, 'workflows', entry.name);
    if (!fs.existsSync(path.join(workflowDir, 'WORKFLOW.md'))) continue;
    const rels = workflowManagedRelPaths(agent, projectRoot, entry.name, workflowDir);
    const existing = rels.map((rel) => path.join(projectRoot, rel)).find((dest) => pathExists(dest));
    if (existing) {
      skip(existing, projectRoot, result);
      continue;
    }
    let success = false;
    if (agent === 'kimi' || agent === 'goose' || agent === 'openclaw') {
      success = syncWorkflowToVersion(workflowDir, entry.name, agent, projectRoot).success;
    } else {
      copyDir(workflowDir, path.join(agentRoot, 'workflows', entry.name));
      success = true;
    }
    if (success) {
      record('workflows', entry.name, rels.map((rel) => path.relative(agentRoot, path.join(projectRoot, rel))), result, manifestPaths);
    }
  }
}
