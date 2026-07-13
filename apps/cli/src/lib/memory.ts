/**
 * Canonical agent memory resource — accumulated facts/preferences/knowledge
 * distinct from `rules` (instructions / AGENTS.md persona).
 *
 * Layout (project > user > system layering):
 *   ~/.agents/memory/MEMORY.md          always-read index
 *   ~/.agents/memory/<slug>.md          individual facts
 *   ~/.agents/.system/memory/           system layer
 *   <project>/.agents/memory/           project layer
 *
 * Sync fans out into each capable agent's version home under an agent-specific
 * target dir (see memoryTargetDir).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import {
  getUserAgentsDir,
  getSystemAgentsDir,
  getProjectAgentsDir,
  ensureAgentsDir,
} from './state.js';
import { agentConfigDirName } from './agents.js';
import { supports } from './capabilities.js';

export interface MemoryFact {
  /** Filename without .md (slug). */
  name: string;
  /** Absolute path to the fact file. */
  path: string;
  /** Layer that wins for this name. */
  layer: 'project' | 'user' | 'system';
  /** First non-empty line of the body (for list display). */
  summary: string;
}

export interface MemoryLayerDir {
  layer: 'project' | 'user' | 'system';
  dir: string;
}

/** User-layer memory root (~/.agents/memory/). */
export function getUserMemoryDir(): string {
  return path.join(getUserAgentsDir(), 'memory');
}

/** System-layer memory root (~/.agents/.system/memory/). */
export function getSystemMemoryDir(): string {
  return path.join(getSystemAgentsDir(), 'memory');
}

/** Project-layer memory root when a project agents dir exists. */
export function getProjectMemoryDir(cwd: string = process.cwd()): string | null {
  const project = getProjectAgentsDir(cwd);
  return project ? path.join(project, 'memory') : null;
}

/** Ensure the user memory dir exists (creates MEMORY.md index if missing). */
export function ensureUserMemoryDir(): string {
  ensureAgentsDir();
  const dir = getUserMemoryDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const index = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(
      index,
      [
        '# Memory index',
        '',
        'Always-read summary of accumulated agent memory. Individual facts live',
        'as sibling `*.md` files. Managed by `agents memory`.',
        '',
      ].join('\n'),
      'utf-8',
    );
  }
  return dir;
}

function isFactFile(name: string): boolean {
  return name.endsWith('.md') && name.toLowerCase() !== 'memory.md';
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'fact';
}

function summarize(content: string): string {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.length > 80 ? t.slice(0, 77) + '...' : t;
  }
  return '(empty)';
}

/** Layer dirs highest-priority first. */
export function getMemoryLayerDirs(cwd: string = process.cwd()): MemoryLayerDir[] {
  const out: MemoryLayerDir[] = [];
  const project = getProjectMemoryDir(cwd);
  if (project && fs.existsSync(project)) out.push({ layer: 'project', dir: project });
  const user = getUserMemoryDir();
  if (fs.existsSync(user)) out.push({ layer: 'user', dir: user });
  const system = getSystemMemoryDir();
  if (fs.existsSync(system)) out.push({ layer: 'system', dir: system });
  return out;
}

/** List memory facts with project > user > system override on name. */
export function listMemoryFacts(cwd: string = process.cwd()): MemoryFact[] {
  const seen = new Set<string>();
  const results: MemoryFact[] = [];
  for (const { layer, dir } of getMemoryLayerDirs(cwd)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!isFactFile(file)) continue;
      const name = file.replace(/\.md$/i, '');
      if (seen.has(name)) continue;
      seen.add(name);
      const filePath = path.join(dir, file);
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      results.push({ name, path: filePath, layer, summary: summarize(content) });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one fact by name (winning layer). */
export function readMemoryFact(name: string, cwd: string = process.cwd()): MemoryFact | null {
  const slug = slugify(name);
  for (const { layer, dir } of getMemoryLayerDirs(cwd)) {
    const filePath = path.join(dir, `${slug}.md`);
    if (!fs.existsSync(filePath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    return { name: slug, path: filePath, layer, summary: summarize(content) };
  }
  return null;
}

/** Write a fact into the user layer. Returns the absolute path. */
export function addMemoryFact(name: string, body: string): string {
  const dir = ensureUserMemoryDir();
  const slug = slugify(name);
  const filePath = path.join(dir, `${slug}.md`);
  const content = body.trimStart().startsWith('#')
    ? body.endsWith('\n') ? body : body + '\n'
    : `# ${slug}\n\n${body.trim()}\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  rebuildMemoryIndex(dir);
  return filePath;
}

/** Remove a fact from the user layer. Returns true if a file was deleted. */
export function removeMemoryFact(name: string): boolean {
  const dir = getUserMemoryDir();
  const slug = slugify(name);
  const filePath = path.join(dir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  if (fs.existsSync(dir)) rebuildMemoryIndex(dir);
  return true;
}

/** Rebuild MEMORY.md index from sibling fact files in a single layer dir. */
export function rebuildMemoryIndex(dir: string): void {
  let facts: string[] = [];
  try {
    facts = fs.readdirSync(dir).filter(isFactFile).sort();
  } catch {
    return;
  }
  const lines = [
    '# Memory index',
    '',
    'Always-read summary of accumulated agent memory. Managed by `agents memory`.',
    '',
  ];
  if (facts.length === 0) {
    lines.push('_No facts yet. Add one with `agents memory add <name> --body "..."`._', '');
  } else {
    for (const file of facts) {
      const name = file.replace(/\.md$/i, '');
      let summary = '';
      try {
        summary = summarize(fs.readFileSync(path.join(dir, file), 'utf-8'));
      } catch {
        summary = '';
      }
      lines.push(`- **${name}** — ${summary}`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), lines.join('\n'), 'utf-8');
}

/**
 * Per-agent target directory (relative to version home) for synced memory.
 * Claude/Codex/OpenClaw/Grok get native-ish paths; others get a generic memory/.
 */
export function memoryTargetDir(agent: AgentId): string {
  switch (agent) {
    case 'claude':
      return path.join(agentConfigDirName(agent), 'memory');
    case 'codex':
      return path.join(agentConfigDirName(agent), 'memories');
    case 'openclaw':
    case 'grok':
      return 'memory';
    default:
      return path.join(agentConfigDirName(agent), 'memory');
  }
}

/** Copy canonical layered memory into one version home. Returns fact names written. */
export function syncMemoryToVersionHome(
  agent: AgentId,
  versionHome: string,
  cwd: string = process.cwd(),
): string[] {
  if (!supports(agent, 'memory').ok) return [];
  const facts = listMemoryFacts(cwd);
  const targetRel = memoryTargetDir(agent);
  const targetDir = path.join(versionHome, targetRel);
  fs.mkdirSync(targetDir, { recursive: true });

  // Clear previous managed fact files (keep non-.md).
  try {
    for (const entry of fs.readdirSync(targetDir)) {
      if (entry.endsWith('.md')) {
        try { fs.unlinkSync(path.join(targetDir, entry)); } catch { /* ignore */ }
      }
    }
  } catch { /* target missing */ }

  const written: string[] = [];
  for (const fact of facts) {
    const dest = path.join(targetDir, `${fact.name}.md`);
    try {
      fs.copyFileSync(fact.path, dest);
      written.push(fact.name);
    } catch { /* skip unreadable */ }
  }

  // Always write an index from the winning layers.
  const indexSrc = (() => {
    for (const { dir } of getMemoryLayerDirs(cwd)) {
      const p = path.join(dir, 'MEMORY.md');
      if (fs.existsSync(p)) return p;
    }
    return null;
  })();
  if (indexSrc) {
    try {
      fs.copyFileSync(indexSrc, path.join(targetDir, 'MEMORY.md'));
    } catch { /* ignore */ }
  } else {
    rebuildMemoryIndex(targetDir);
  }

  return written;
}

