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
  getActiveRulesPreset,
} from './state.js';
import { composeRulesFromState } from './rules/compose.js';
import {
  getAvailableResources,
  getActuallySyncedResources,
  getVersionHomePath,
  compareVersions,
} from './versions.js';
import { discoverPlugins, marketplaceSpecForName } from './plugins.js';
import type { DiscoveredPlugin } from './types.js';
import { pluginInstallDir, repairableManifestFields } from './plugin-marketplace.js';
import { markdownToToml } from './convert.js';
import { listCommandsInVersionHome, getVersionCommandsDir, listPluginCommandNames } from './commands.js';
import { shouldInstallCommandAsSkill, commandSkillMatches, commandSkillName } from './command-skills.js';
import { gooseCommandMatches, gooseCommandsDir } from './goose-commands.js';
import { supports } from './capabilities.js';
import { listSkillsInVersionHome, getVersionSkillsDir } from './skills.js';
import { listHooksInVersionHome, getVersionHooksDir, listHookEntriesFromDir } from './hooks.js';

const RULES_DOC_FILENAME = 'README.md';

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
  /** Human-readable specifics for a divergent row — e.g. for a stale plugin:
   *  "0.6.1→0.7.0, missing skills: ship, learn". Currently set for plugins. */
  detail?: string;
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
  // Command-as-skill agents (kimi, codex>=0.117, grok) install every command as a
  // SKILL wrapper at <agentDir>/skills/<cmd>/SKILL.md, not a native command file.
  // The compare must follow that or every command false-reports as drifted.
  const asSkill = shouldInstallCommandAsSkill(agent, version);
  // Agents that hold commands neither natively nor as skills (e.g. goose) must not
  // report source commands as "missing" — they structurally can't take them.
  if (!asSkill && !supports(agent, 'commands', version).ok) return [];
  const agentDir = path.join(getVersionHomePath(agent, version), agentConfigDirName(agent));
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
    if (!installed.has(name)) {
      rows.push({ kind: 'commands', name, status: 'missing', source: src.layer, sourcePath: src.path });
      continue;
    }
    if (asSkill) {
      // Compare against the installed command-skill wrapper, not a native path.
      const matches = commandSkillMatches(agentDir, name, src.path);
      rows.push({
        kind: 'commands',
        name,
        status: matches ? 'ok' : 'diff',
        source: src.layer,
        sourcePath: src.path,
        homePath: path.join(agentDir, 'skills', commandSkillName(name), 'SKILL.md'),
      });
      continue;
    }
    if (agent === 'goose') {
      // Compare against the installed Goose recipe YAML + slash_commands registration.
      const matches = gooseCommandMatches(getVersionHomePath(agent, version), name, src.path);
      rows.push({
        kind: 'commands',
        name,
        status: matches ? 'ok' : 'diff',
        source: src.layer,
        sourcePath: src.path,
        homePath: path.join(gooseCommandsDir(getVersionHomePath(agent, version)), `${name}.yaml`),
      });
      continue;
    }
    const homePath = path.join(homeDir, `${name}${ext}`);
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

  // Plugin-bundled commands (installed as `<plugin>-<cmd>`) are source-managed by
  // their plugin, tracked under the `plugins` kind — not extras. Without this,
  // `agents doctor` shows every plugin command (swarm-plan, code-review, …) as an
  // unmanaged extra, mirroring the orphan false-positive the prune path had.
  const pluginCommands = listPluginCommandNames();
  for (const name of installed) {
    if (seen.has(name)) continue;
    if (pluginCommands.has(name)) continue;
    const extraHome = asSkill
      ? path.join(agentDir, 'skills', commandSkillName(name), 'SKILL.md')
      : agent === 'goose'
        ? path.join(gooseCommandsDir(getVersionHomePath(agent, version)), `${name}.yaml`)
        : path.join(homeDir, `${name}${ext}`);
    rows.push({ kind: 'commands', name, status: 'extra', homePath: extraHome });
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
  // Native ~/.agents/skills consumers (Gemini, …) read central skills directly.
  // The orchestrator DELETES their version-home skills dir (syncResourcesToVersion)
  // and registers no skills writer, so there is nothing in the version home to
  // reconcile. Mirror diffVersionSkills' native gate (skills.ts) — without it
  // every central skill is false-reported `missing` and held as unreconcilable
  // forever (drift never clears for these agents).
  if (AGENTS[agent].nativeAgentsSkillsDir) return [];
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

function expectedRuleContent(agent: AgentId, name: string, version: string, sourcePath: string): string | null {
  // The instruction file (AGENTS → the agent's CLAUDE.md/GEMINI.md/AGENTS.md)
  // is COMPOSED from `subrules/` fragments for the version's active preset —
  // that is exactly what the rules writer emits (see
  // staleness/writers/rules.ts → composeRulesFromState). Compare against the
  // same rendering so a correctly-synced home file reconciles instead of being
  // held forever against the raw `rules/AGENTS.md` (the whole-repo doc, which a
  // preset composition deliberately never equals — system subrules don't
  // auto-append). The `agent` is not part of the rendering (every capable agent
  // gets identical composed bytes); it is kept for symmetry with the writer's
  // per-agent dispatch and future per-agent presets.
  if (name === 'AGENTS') {
    try {
      return composeRulesFromState({ preset: getActiveRulesPreset(agent, version) }).content;
    } catch {
      // No rules.yaml / unknown preset — the writer skips too; treat as unknown.
      return null;
    }
  }
  // Any sibling top-level rules file syncs as a raw copy.
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
    const expected = expectedRuleContent(agent, name, version, src.path);
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

// ─── plugins (content-aware) ───────────────────────────────────────────────

function listPluginSkillDirs(pluginDir: string): string[] {
  const d = path.join(pluginDir, 'skills');
  try {
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(d, e.name, 'SKILL.md')))
      .map((e) => e.name);
  } catch { return []; }
}

function listPluginCommandFiles(pluginDir: string): string[] {
  const d = path.join(pluginDir, 'commands');
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch { return []; }
}

/**
 * Describe how a version's marketplace MIRROR of a plugin diverges from its
 * central source — the detail presence-only checks miss. Surfaces a stale mirror
 * version, a Claude-invalid manifest, and (the part users care about) the
 * plugin's own skills/commands that never made it into the mirror. Returns null
 * when the mirror faithfully matches source.
 */
export function describePluginDrift(central: DiscoveredPlugin, mirrorDir: string): string | null {
  if (!fs.existsSync(mirrorDir)) return 'mirror missing';
  const parts: string[] = [];

  let mManifest: Record<string, unknown> | null = null;
  try {
    mManifest = JSON.parse(fs.readFileSync(path.join(mirrorDir, '.claude-plugin', 'plugin.json'), 'utf-8'));
  } catch { mManifest = null; }

  const mVer = mManifest && typeof mManifest.version === 'string' ? mManifest.version : undefined;
  const cVer = central.manifest.version;
  if (mVer && cVer && compareVersions(cVer, mVer) > 0) parts.push(`${mVer}→${cVer}`);
  if (mManifest && repairableManifestFields(mManifest).length > 0) parts.push('invalid manifest');

  const mirrorSkills = new Set(listPluginSkillDirs(mirrorDir));
  const missSkills = listPluginSkillDirs(central.root).filter((s) => !mirrorSkills.has(s)).sort();
  const mirrorCmds = new Set(listPluginCommandFiles(mirrorDir));
  const missCmds = listPluginCommandFiles(central.root).filter((c) => !mirrorCmds.has(c)).sort();
  if (missSkills.length) parts.push(`missing skill${missSkills.length > 1 ? 's' : ''}: ${missSkills.join(', ')}`);
  if (missCmds.length) parts.push(`missing command${missCmds.length > 1 ? 's' : ''}: ${missCmds.join(', ')}`);

  return parts.length ? parts.join(', ') : null;
}

function diffPlugins(agent: AgentId, version: string, cwd: string): ResourceDiff[] {
  const versionHome = getVersionHomePath(agent, version);
  const synced = new Set(getActuallySyncedResources(agent, version, { cwd }).plugins);
  const rows: ResourceDiff[] = [];
  const seen = new Set<string>();

  for (const p of discoverPlugins({ cwd })) {
    if (seen.has(p.name)) continue; // dedupe across marketplaces for the readout
    seen.add(p.name);
    if (!synced.has(p.name)) {
      rows.push({ kind: 'plugins', name: p.name, status: 'missing', sourcePath: p.root });
      continue;
    }
    const mirror = pluginInstallDir(p, marketplaceSpecForName(p.marketplace), agent, versionHome);
    const detail = describePluginDrift(p, mirror);
    rows.push({
      kind: 'plugins',
      name: p.name,
      status: detail ? 'diff' : 'ok',
      sourcePath: p.root,
      homePath: mirror,
      ...(detail ? { detail } : {}),
    });
  }
  for (const name of synced) {
    if (!seen.has(name)) rows.push({ kind: 'plugins', name, status: 'extra' });
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
  if (requested.has('plugins')) empty.plugins = diffPlugins(agent, version, cwd);
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
