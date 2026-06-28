/**
 * Per-version, per-cwd resource diff for `agents doctor <agent[@version]>`.
 *
 * Mirrors what `syncResourcesToVersion` writes into a version home, then
 * compares each kind back against its resolved source (project > user > system
 * > extra repos). Surfaces:
 *   - ok       — present in home, content matches resolved source
 *   - diff     — present in home, content differs from resolved source
 *   - missing  — resolved source exists, not present in home
 *   - extra    — present in home, no source in any layer
 *
 * Coverage:
 *   commands, skills, hooks, rules — full content compare with source layer.
 *   mcp, permissions, subagents, plugins, promptcuts — presence-only.
 *
 * Intentional asymmetries (must mirror sync):
 *   - hooks ignore the project layer (`syncResourcesToVersion` skips
 *     project/.agents/hooks/ for safety).
 *   - rules/AGENTS.md on agents without native @-import support is compared
 *     against the compiled artifact, not the raw source file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, agentConfigDirName } from './agents.js';
import type { AgentId } from './types.js';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getSystemAgentsDir,
  getEnabledExtraRepos,
  getResolvedRulesDir,
  getUserRulesDir,
  getPromptcutsPath,
  getEffectivePromptcutsPath,
} from './state.js';
import {
  getAvailableResources,
  getActuallySyncedResources,
  getVersionHomePath,
} from './versions.js';
import { markdownToToml } from './convert.js';
import { resolveImports, supportsRulesImports } from './rules/compile.js';
import { listCommandsInVersionHome, getVersionCommandsDir } from './commands.js';
import { listSkillsInVersionHome, getVersionSkillsDir } from './skills.js';
import { listHooksInVersionHome, getVersionHooksDir, listHookEntriesFromDir } from './hooks.js';

const RULES_DOC_FILENAME = 'README.md';
const COMPILED_HEADER =
  '<!-- Auto-compiled by agents-cli from ~/.agents/rules/AGENTS.md + imports.\n' +
  '     Edit the source files under ~/.agents/rules/ — edits to this file will be overwritten on next sync. -->\n\n';

export type DoctorKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'permissions'
  | 'subagents'
  | 'plugins'
  | 'promptcuts';

export type DiffStatus = 'ok' | 'diff' | 'missing' | 'extra';

export type SourceLayer = 'project' | 'user' | 'system' | 'extra';

export interface ResourceDiff {
  kind: DoctorKind;
  name: string;
  status: DiffStatus;
  source?: SourceLayer;
  /** Absolute path to the resolved source file/dir (when source is known). */
  sourcePath?: string;
  /** Absolute path to the file/dir inside the version home (when present). */
  homePath?: string;
}

export interface VersionResourceReport {
  agent: AgentId;
  version: string;
  home: string;
  cwd: string;
  layers: {
    project: string | null;
    user: string;
    system: string;
    extras: Array<{ alias: string; dir: string }>;
  };
  kinds: Record<DoctorKind, ResourceDiff[]>;
  summary: { ok: number; diff: number; missing: number; extra: number };
}

const ALL_KINDS: DoctorKind[] = [
  'commands',
  'skills',
  'hooks',
  'rules',
  'mcp',
  'permissions',
  'subagents',
  'plugins',
  'promptcuts',
];

interface SourceCandidate {
  layer: SourceLayer;
  path: string;
  /** Optional alias when layer === 'extra'. */
  alias?: string;
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function readSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function fileExists(p: string | null | undefined): p is string {
  return !!p && fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink();
}

function findFirst(candidates: SourceCandidate[]): SourceCandidate | null {
  for (const c of candidates) {
    if (fileExists(c.path) || (fs.existsSync(c.path) && fs.lstatSync(c.path).isDirectory())) {
      return c;
    }
  }
  return null;
}

function buildLayerBases(cwd: string, kind: DoctorKind, opts: { excludeProject?: boolean } = {}) {
  const projectDir = opts.excludeProject ? null : getProjectAgentsDir(cwd);
  const userDir = getUserAgentsDir();
  const systemDir = getSystemAgentsDir();
  const extras = getEnabledExtraRepos();
  const out: SourceCandidate[] = [];
  if (projectDir) out.push({ layer: 'project', path: path.join(projectDir, kind) });
  out.push({ layer: 'user', path: path.join(userDir, kind) });
  out.push({ layer: 'system', path: path.join(systemDir, kind) });
  for (const e of extras) out.push({ layer: 'extra', path: path.join(e.dir, kind), alias: e.alias });
  return out;
}

// ─── commands ─────────────────────────────────────────────────────────────────

function diffCommands(agent: AgentId, version: string, cwd: string, excludeProject = false): ResourceDiff[] {
  const agentConfig = AGENTS[agent];
  const isToml = agentConfig.format === 'toml';
  const ext = isToml ? '.toml' : '.md';
  const homeDir = getVersionCommandsDir(agent, version);
  const installed = new Set(listCommandsInVersionHome(agent, version));
  const layerBases = buildLayerBases(cwd, 'commands', { excludeProject });

  const sourceByName = new Map<string, SourceCandidate>();
  for (const base of layerBases) {
    if (!fs.existsSync(base.path)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.replace(/\.md$/, '');
      if (sourceByName.has(name)) continue;
      sourceByName.set(name, { layer: base.layer, path: path.join(base.path, entry.name), alias: base.alias });
    }
  }

  const rows: ResourceDiff[] = [];
  const seen = new Set<string>();

  for (const [name, src] of sourceByName) {
    seen.add(name);
    const homePath = path.join(homeDir, `${name}${ext}`);
    if (!installed.has(name)) {
      rows.push({ kind: 'commands', name, status: 'missing', source: src.layer, sourcePath: src.path });
      continue;
    }
    const installedContent = readSafe(homePath);
    const sourceContent = readSafe(src.path);
    if (installedContent == null || sourceContent == null) {
      rows.push({ kind: 'commands', name, status: 'diff', source: src.layer, sourcePath: src.path, homePath });
      continue;
    }
    const expected = isToml ? markdownToToml(name, sourceContent) : sourceContent;
    const matches = normalize(installedContent) === normalize(expected);
    rows.push({
      kind: 'commands',
      name,
      status: matches ? 'ok' : 'diff',
      source: src.layer,
      sourcePath: src.path,
      homePath,
    });
  }

  for (const name of installed) {
    if (seen.has(name)) continue;
    rows.push({ kind: 'commands', name, status: 'extra', homePath: path.join(homeDir, `${name}${ext}`) });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── skills ───────────────────────────────────────────────────────────────────

function dirsContentMatch(src: string, dst: string): boolean {
  const ignore = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);
  const srcEntries = (() => {
    try { return fs.readdirSync(src, { withFileTypes: true }); } catch { return null; }
  })();
  const dstEntries = (() => {
    try { return fs.readdirSync(dst, { withFileTypes: true }); } catch { return null; }
  })();
  if (!srcEntries || !dstEntries) return false;

  const filter = (es: fs.Dirent[]) =>
    es.filter((e) => !e.isSymbolicLink() && !ignore.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const srcF = filter(srcEntries);
  const dstF = filter(dstEntries);
  if (srcF.length !== dstF.length) return false;
  for (let i = 0; i < srcF.length; i++) {
    if (srcF[i].name !== dstF[i].name) return false;
    const a = path.join(src, srcF[i].name);
    const b = path.join(dst, dstF[i].name);
    if (srcF[i].isDirectory()) {
      if (!dstF[i].isDirectory()) return false;
      if (!dirsContentMatch(a, b)) return false;
    } else if (srcF[i].isFile()) {
      if (!dstF[i].isFile()) return false;
      const ac = readSafe(a);
      const bc = readSafe(b);
      if (ac == null || bc == null) return false;
      if (normalize(ac) !== normalize(bc)) return false;
    }
  }
  return true;
}

function diffSkills(agent: AgentId, version: string, cwd: string, excludeProject = false): ResourceDiff[] {
  const homeDir = getVersionSkillsDir(agent, version);
  const installed = new Set(listSkillsInVersionHome(agent, version));
  const layerBases = buildLayerBases(cwd, 'skills', { excludeProject });

  const sourceByName = new Map<string, SourceCandidate>();
  for (const base of layerBases) {
    if (!fs.existsSync(base.path)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!fs.existsSync(path.join(base.path, entry.name, 'SKILL.md'))) continue;
      if (sourceByName.has(entry.name)) continue;
      sourceByName.set(entry.name, { layer: base.layer, path: path.join(base.path, entry.name), alias: base.alias });
    }
  }

  const rows: ResourceDiff[] = [];
  const seen = new Set<string>();
  for (const [name, src] of sourceByName) {
    seen.add(name);
    const homePath = path.join(homeDir, name);
    if (!installed.has(name)) {
      rows.push({ kind: 'skills', name, status: 'missing', source: src.layer, sourcePath: src.path });
      continue;
    }
    const matches = dirsContentMatch(src.path, homePath);
    rows.push({
      kind: 'skills',
      name,
      status: matches ? 'ok' : 'diff',
      source: src.layer,
      sourcePath: src.path,
      homePath,
    });
  }

  for (const name of installed) {
    if (seen.has(name)) continue;
    rows.push({ kind: 'skills', name, status: 'extra', homePath: path.join(homeDir, name) });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── hooks ────────────────────────────────────────────────────────────────────

function diffHooks(agent: AgentId, version: string, cwd: string): ResourceDiff[] {
  if (!AGENTS[agent].supportsHooks) return [];
  const installedEntries = listHooksInVersionHome(agent, version);
  const installedByName = new Map(installedEntries.map((e) => [e.name, e]));
  // Sync intentionally excludes project/.agents/hooks/ — mirror that.
  const layerBases = buildLayerBases(cwd, 'hooks', { excludeProject: true });

  // Group source files the same way the hook installer does (basename across
  // script + sidecar data file); first-layer wins on name collision.
  const sourceByName = new Map<string, { layer: SourceLayer; alias?: string; entry: ReturnType<typeof listHookEntriesFromDir>[number] }>();
  for (const base of layerBases) {
    if (!fs.existsSync(base.path)) continue;
    for (const entry of listHookEntriesFromDir(base.path)) {
      if (sourceByName.has(entry.name)) continue;
      sourceByName.set(entry.name, { layer: base.layer, alias: base.alias, entry });
    }
  }

  const rows: ResourceDiff[] = [];
  const seen = new Set<string>();
  for (const [name, src] of sourceByName) {
    seen.add(name);
    const installed = installedByName.get(name);
    if (!installed) {
      rows.push({ kind: 'hooks', name, status: 'missing', source: src.layer, sourcePath: src.entry.scriptPath });
      continue;
    }
    const a = readSafe(src.entry.scriptPath);
    const b = readSafe(installed.scriptPath);
    let matches = a != null && b != null && normalize(a) === normalize(b);
    if (matches && src.entry.dataFile && installed.dataFile) {
      const ad = readSafe(src.entry.dataFile);
      const bd = readSafe(installed.dataFile);
      matches = ad != null && bd != null && normalize(ad) === normalize(bd);
    } else if (matches && (!!src.entry.dataFile !== !!installed.dataFile)) {
      matches = false;
    }
    rows.push({
      kind: 'hooks',
      name,
      status: matches ? 'ok' : 'diff',
      source: src.layer,
      sourcePath: src.entry.scriptPath,
      homePath: installed.scriptPath,
    });
  }

  for (const [name, installed] of installedByName) {
    if (seen.has(name)) continue;
    rows.push({ kind: 'hooks', name, status: 'extra', homePath: installed.scriptPath });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── rules / memory ───────────────────────────────────────────────────────────

function listRulesNames(cwd: string, excludeProject = false): Map<string, SourceCandidate> {
  const projectDir = excludeProject ? null : getProjectAgentsDir(cwd);
  const userRules = getUserRulesDir();
  const systemRules = getResolvedRulesDir();
  const extras = getEnabledExtraRepos();
  const layers: SourceCandidate[] = [];
  if (projectDir) layers.push({ layer: 'project', path: path.join(projectDir, 'rules') });
  layers.push({ layer: 'user', path: userRules });
  layers.push({ layer: 'system', path: systemRules });
  for (const e of extras) layers.push({ layer: 'extra', path: path.join(e.dir, 'rules'), alias: e.alias });

  const out = new Map<string, SourceCandidate>();
  for (const base of layers) {
    if (!fs.existsSync(base.path)) continue;
    let entries: string[];
    try { entries = fs.readdirSync(base.path); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.md') || file === RULES_DOC_FILENAME) continue;
      const stat = fs.lstatSync(path.join(base.path, file));
      if (stat.isSymbolicLink()) continue;
      const name = file.replace(/\.md$/, '');
      if (out.has(name)) continue;
      out.set(name, { layer: base.layer, path: path.join(base.path, file), alias: base.alias });
    }
  }
  return out;
}

function expectedRuleContent(agent: AgentId, name: string, sourcePath: string): string | null {
  // AGENTS.md on agents without native @-import support is compiled with imports inlined.
  if (name === 'AGENTS' && !supportsRulesImports(agent)) {
    const root = readSafe(sourcePath);
    if (root == null) return null;
    // Compile relative to the source's own dir so project-layer AGENTS.md resolves
    // its imports relative to the project rules dir, not the user one.
    const baseDir = path.dirname(sourcePath);
    const { content } = resolveImports(root, baseDir);
    return COMPILED_HEADER + content;
  }
  return readSafe(sourcePath);
}

function diffRules(agent: AgentId, version: string, cwd: string, excludeProject = false): ResourceDiff[] {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const configDir = path.join(versionHome, agentConfigDirName(agent));
  const sourcesByName = listRulesNames(cwd, excludeProject);

  // Files actually present in the version home.
  const homeFiles = new Set<string>();
  if (fs.existsSync(configDir)) {
    for (const f of fs.readdirSync(configDir)) {
      if (!f.endsWith('.md')) continue;
      homeFiles.add(f);
    }
  }

  const rows: ResourceDiff[] = [];
  const homeSeen = new Set<string>();

  for (const [name, src] of sourcesByName) {
    const targetName = name === 'AGENTS' ? agentConfig.instructionsFile : `${name}.md`;
    homeSeen.add(targetName);
    const homePath = path.join(configDir, targetName);

    if (!homeFiles.has(targetName)) {
      rows.push({ kind: 'rules', name, status: 'missing', source: src.layer, sourcePath: src.path });
      continue;
    }
    const expected = expectedRuleContent(agent, name, src.path);
    const actual = readSafe(homePath);
    if (expected == null || actual == null) {
      rows.push({ kind: 'rules', name, status: 'diff', source: src.layer, sourcePath: src.path, homePath });
      continue;
    }
    rows.push({
      kind: 'rules',
      name,
      status: normalize(expected) === normalize(actual) ? 'ok' : 'diff',
      source: src.layer,
      sourcePath: src.path,
      homePath,
    });
  }

  // Anything in the configDir matching an instructions filename or AGENTS.md
  // but with no source is an extra. We only report files that look like rules
  // — i.e. the agent's instructionsFile, plus any *.md siblings that came
  // from the rules sync.
  const rulesFilenames = new Set<string>();
  rulesFilenames.add(agentConfig.instructionsFile);
  for (const targetName of homeSeen) rulesFilenames.add(targetName);
  for (const f of homeFiles) {
    if (homeSeen.has(f)) continue;
    if (!rulesFilenames.has(f) && f !== agentConfig.instructionsFile) continue;
    const name = f === agentConfig.instructionsFile ? 'AGENTS' : f.replace(/\.md$/, '');
    rows.push({ kind: 'rules', name, status: 'extra', homePath: path.join(configDir, f) });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── presence-only kinds ──────────────────────────────────────────────────────

function diffPresenceOnly(
  kind: DoctorKind,
  available: string[],
  synced: string[],
): ResourceDiff[] {
  const availableSet = new Set(available);
  const syncedSet = new Set(synced);
  const rows: ResourceDiff[] = [];
  for (const name of available) {
    rows.push({
      kind,
      name,
      status: syncedSet.has(name) ? 'ok' : 'missing',
    });
  }
  for (const name of synced) {
    if (availableSet.has(name)) continue;
    rows.push({ kind, name, status: 'extra' });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function diffPromptcuts(): ResourceDiff[] {
  const sourcePath = getEffectivePromptcutsPath();
  if (!fs.existsSync(sourcePath)) return [];
  return [{ kind: 'promptcuts', name: 'promptcuts.yaml', status: 'ok', sourcePath }];
}

// ─── public API ───────────────────────────────────────────────────────────────

export interface DiffOptions {
  cwd?: string;
  /** Restrict to specific kinds; undefined = all. */
  kinds?: DoctorKind[];
  /**
   * Drop the project (`<cwd>/.agents/`) layer from resolution. Used by the heal
   * path: the GLOBAL version home is only ever reconciled against user/system/
   * extra sources — project resources are layered at launch, never synced into
   * the global home, so counting them as "missing" there is a false gap.
   */
  excludeProject?: boolean;
}

export function diffVersionResources(
  agent: AgentId,
  version: string,
  options: DiffOptions = {},
): VersionResourceReport {
  const rawCwd = options.cwd ?? process.cwd();
  const excludeProject = options.excludeProject ?? false;
  const home = getVersionHomePath(agent, version);
  const requested = new Set<DoctorKind>(options.kinds ?? ALL_KINDS);

  // When excluding the project layer, resolve every per-cwd lookup against a
  // neutral cwd so no `<cwd>/.agents/` is ever discovered.
  const cwd = rawCwd;
  const projectDir = excludeProject ? null : getProjectAgentsDir(cwd);

  const available = getAvailableResources(cwd);
  const synced = getActuallySyncedResources(agent, version, { cwd });

  const empty: Record<DoctorKind, ResourceDiff[]> = {
    commands: [],
    skills: [],
    hooks: [],
    rules: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
    promptcuts: [],
  };

  if (requested.has('commands')) empty.commands = diffCommands(agent, version, cwd, excludeProject);
  if (requested.has('skills')) empty.skills = diffSkills(agent, version, cwd, excludeProject);
  if (requested.has('hooks')) empty.hooks = diffHooks(agent, version, cwd);
  if (requested.has('rules')) empty.rules = diffRules(agent, version, cwd, excludeProject);
  if (requested.has('mcp')) empty.mcp = diffPresenceOnly('mcp', available.mcp, synced.mcp);
  if (requested.has('permissions')) empty.permissions = diffPresenceOnly('permissions', available.permissions, synced.permissions);
  if (requested.has('subagents')) empty.subagents = diffPresenceOnly('subagents', available.subagents, synced.subagents);
  if (requested.has('plugins')) empty.plugins = diffPresenceOnly('plugins', available.plugins, synced.plugins);
  if (requested.has('promptcuts')) empty.promptcuts = diffPromptcuts();

  let ok = 0, diff = 0, missing = 0, extra = 0;
  for (const list of Object.values(empty)) {
    for (const r of list) {
      if (r.status === 'ok') ok++;
      else if (r.status === 'diff') diff++;
      else if (r.status === 'missing') missing++;
      else if (r.status === 'extra') extra++;
    }
  }

  return {
    agent,
    version,
    home,
    cwd,
    layers: {
      project: projectDir,
      user: getUserAgentsDir(),
      system: getSystemAgentsDir(),
      extras: getEnabledExtraRepos().map((e) => ({ alias: e.alias, dir: e.dir })),
    },
    kinds: empty,
    summary: { ok, diff, missing, extra },
  };
}

export const DOCTOR_ALL_KINDS = ALL_KINDS;
