/**
 * `agents inspect <target>` — detail view for one agent+version or one DotAgents repo.
 *
 * Agent targets (`claude`, `claude@2.1.170`) show the per-version header (paths,
 * shim, capabilities, resource counts, sessions). Repo targets (`user`, `system`,
 * `project`, a registered extra-repo alias, or a filesystem path to a repo with a
 * `.agents/` dir or to a DotAgents root itself) show the repo root, git state, and
 * per-kind resource counts. Drill-down flags (`--skills`, `--hooks`, `--mcp`, ...)
 * list one resource kind for either target form; passing a positional query to the
 * same flag fuzzy-searches for a single resource and prints its detail. Resource
 * names render as OSC-8 hyperlinks to the marker file (SKILL.md / WORKFLOW.md /
 * AGENT.md / the file itself) so users can click straight to the source.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import * as yaml from 'yaml';
import type { AgentId, CapabilityName, DiscoveredPlugin, ManifestHook, HookMatches, HookCache } from '../lib/types.js';
import { AGENTS, getCliState, resolveAgentName } from '../lib/agents.js';
import { supports } from '../lib/capabilities.js';
import {
  readMeta,
  getUserAgentsDir,
  getSystemAgentsDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../lib/state.js';
import { getVersionHomePath } from '../lib/versions.js';
import { getShimsDir, getVersionedAliasPath } from '../lib/shims.js';
import {
  getAgentResources,
  listResources,
  type ResourceEntry,
  type SkillResourceEntry,
} from '../lib/resources.js';
import { listHookEntriesFromDir } from '../lib/hooks.js';
import { listMcpServerConfigs, discoverMcpConfigsFromRepo, type McpYamlConfig } from '../lib/mcp.js';
import { discoverPlugins, discoverPluginsInDir, pluginResourceGroups, type PluginResourceGroup } from '../lib/plugins.js';
import { PLUGIN_GROUP_COLORS } from './plugins.js';
import { countSessionsInScope } from '../lib/session/discover.js';
import type { SessionAgentId } from '../lib/session/types.js';
import { damerauLevenshtein } from '../lib/fuzzy.js';

/** Resource kinds the inspect command can drill into. */
const DRILLABLE_KINDS = [
  'commands',
  'skills',
  'hooks',
  'mcp',
  'rules',
  'plugins',
  'workflows',
  'subagents',
] as const;
type DrillableKind = typeof DRILLABLE_KINDS[number];

/**
 * Summary-view partition. SIMPLE kinds render as a one-line count + name preview;
 * RICH kinds (hooks/plugins/mcp) get their own expanded section showing each
 * item's key detail (events/predicates, bundle contents, transport/url). Together
 * they cover every DrillableKind.
 */
const SIMPLE_KINDS = ['commands', 'skills', 'rules', 'subagents', 'workflows'] as const;
const RICH_KINDS = ['hooks', 'plugins', 'mcp'] as const;

/**
 * Singular aliases for the plural drill-down flags. `--plugin code` reads as
 * "show the one plugin named code" — a required-value flag that always lands in
 * detail mode, the natural counterpart to `--plugins` (list). `mcp` has no
 * distinct singular, so it is intentionally absent.
 */
const SINGULAR_DRILL_ALIASES: Record<string, DrillableKind> = {
  command: 'commands',
  skill: 'skills',
  hook: 'hooks',
  rule: 'rules',
  plugin: 'plugins',
  workflow: 'workflows',
  subagent: 'subagents',
};

const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'hooks', 'mcp', 'skills', 'commands', 'subagents', 'plugins', 'workflows', 'rules', 'allowlist',
];

interface ResourceItem {
  name: string;
  source: string;
  /** Absolute path to the resource entry (file or directory). */
  path: string;
  /** Path the OSC-8 link should point at — marker file inside bundles, else `path`. */
  linkTarget: string;
  /** One-line description (frontmatter `description:` or first non-frontmatter line). */
  description: string;
  /** Scalar detail rows surfaced in detail mode (e.g. a plugin's version). */
  extra?: Array<[string, string]>;
  /** For plugins: the resource categories (skills, commands, …) the bundle packages. */
  groups?: PluginResourceGroup[];
}

export interface InspectOptions {
  brief?: boolean;
  json?: boolean;
  // Drill-down flags. commander treats `--skills [query]` so the value is
  // either undefined (flag absent), true (flag present, no query), or string.
  commands?: boolean | string;
  skills?: boolean | string;
  hooks?: boolean | string;
  mcp?: boolean | string;
  rules?: boolean | string;
  plugins?: boolean | string;
  workflows?: boolean | string;
  subagents?: boolean | string;
  // Singular aliases — required value, always detail mode (see SINGULAR_DRILL_ALIASES).
  command?: string;
  skill?: string;
  hook?: string;
  rule?: string;
  plugin?: string;
  workflow?: string;
  subagent?: string;
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerInspectCommand(program: Command): void {
  const cmd = program
    .command('inspect <target>')
    .description('Inspect one installed agent at one version, or a DotAgents repo (user|system|project|alias|path) — paths, capabilities, resources, drill into any kind.')
    .option('--brief', 'header + capabilities only; skip resources/sessions')
    .option('--json', 'machine-readable JSON output');

  for (const kind of DRILLABLE_KINDS) {
    cmd.option(`--${kind} [query]`, `list ${kind}; pass a name (fuzzy) to show detail`);
  }
  for (const singular of Object.keys(SINGULAR_DRILL_ALIASES)) {
    cmd.option(`--${singular} <query>`, `show detail for one ${singular} by name (fuzzy)`);
  }

  cmd.action(async (target: string, options: InspectOptions) => {
    await inspectAction(target, options);
  });
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

export async function inspectAction(target: string, options: InspectOptions): Promise<void> {
  const agentKey = target.split('@')[0].toLowerCase();
  if (!(agentKey in AGENTS)) {
    const repo = resolveRepoTarget(target);
    if (repo) {
      await inspectRepo(repo, options);
      return;
    }
    // Repo targets take precedence over typo correction; only fall through to
    // parseTarget when the key resolves to an agent (alias or single-edit fix).
    if (!resolveAgentName(agentKey)) {
      const extras = getEnabledExtraRepos();
      console.error(chalk.red(`Unknown target: ${target}`));
      console.error(chalk.gray(`Agents: ${Object.keys(AGENTS).join(', ')}`));
      const aliases = extras.length > 0 ? `, ${extras.map(e => e.alias).join(', ')}` : '';
      console.error(chalk.gray(`Repos:  user, system, project${aliases} — or a path to a repo with a .agents/ dir`));
      process.exit(1);
    }
  }

  const { agent, version } = parseTarget(target);
  const versionHome = getVersionHomePath(agent, version);

  if (!fs.existsSync(versionHome)) {
    console.error(chalk.red(`${agent}@${version} is not installed.`));
    console.error(chalk.gray(`Run 'agents add ${agent}@${version}' first.`));
    process.exitCode = 1;
    return;
  }

  const drill = pickDrillKind(options);

  if (drill) {
    const { kind, query } = drill;
    if (query === true || query === undefined) {
      await renderList(agent, version, versionHome, kind, options);
    } else {
      await renderDetail(agent, version, versionHome, kind, String(query), options);
    }
    return;
  }

  await renderSummary(agent, version, versionHome, options);
}

function parseTarget(target: string): { agent: AgentId; version: string } {
  const [rawAgent, rawVersion] = target.split('@');
  const agent = resolveAgentName(rawAgent || '');
  if (!agent) {
    console.error(chalk.red(`Unknown agent: ${rawAgent}`));
    console.error(chalk.gray(`Known agents: ${Object.keys(AGENTS).join(', ')}`));
    process.exit(1);
  }

  let version = rawVersion;
  if (!version || version === 'default') {
    const meta = readMeta();
    const def = meta.agents?.[agent];
    if (!def) {
      console.error(chalk.red(`No default version set for ${agent}.`));
      console.error(chalk.gray(`Pass a version: agents inspect ${agent}@<version>`));
      process.exit(1);
    }
    version = def;
  }
  return { agent, version };
}

function pickDrillKind(options: InspectOptions): { kind: DrillableKind; query: boolean | string } | null {
  const active: Array<{ flag: string; kind: DrillableKind; query: boolean | string }> = [];
  for (const kind of DRILLABLE_KINDS) {
    const value = options[kind];
    if (value !== undefined) active.push({ flag: `--${kind}`, kind, query: value });
  }
  // Singular aliases (`--plugin code`) always carry a name → detail mode.
  for (const [singular, plural] of Object.entries(SINGULAR_DRILL_ALIASES)) {
    const value = (options as Record<string, unknown>)[singular];
    if (typeof value === 'string') active.push({ flag: `--${singular}`, kind: plural, query: value });
  }
  if (active.length === 0) return null;
  if (active.length > 1) {
    console.error(chalk.red(`Pick at most one drill-down flag. Got: ${active.map(a => a.flag).join(', ')}`));
    process.exit(1);
  }
  return { kind: active[0].kind, query: active[0].query };
}

// ─── Repo targets ────────────────────────────────────────────────────────────

export interface RepoTarget {
  /** Display label: 'user' | 'system' | 'project', an extra-repo alias, or a path-derived name. */
  label: string;
  /** Absolute path to the DotAgents root (the dir holding commands/, skills/, ...). */
  root: string;
}

/** Files at a DotAgents root that mark it as one, beyond the per-kind dirs. */
const REPO_MARKER_FILES = ['agents.yaml', 'hooks.yaml'];

/**
 * Resolve a non-agent target as a DotAgents repo: the built-in layer names,
 * a registered extra-repo alias, or a filesystem path. Paths accept either a
 * DotAgents root itself or a repo whose `.agents/` dir should be inspected.
 * Returns null when the target is none of these.
 */
export function resolveRepoTarget(target: string, cwd?: string): RepoTarget | null {
  if (target === 'user') return { label: 'user', root: getUserAgentsDir() };
  if (target === 'system') return { label: 'system', root: getSystemAgentsDir() };
  if (target === 'project') {
    const dir = getProjectAgentsDir(cwd);
    if (!dir) {
      console.error(chalk.red('No project .agents/ directory found from the current directory.'));
      process.exit(1);
    }
    return { label: 'project', root: dir };
  }

  for (const extra of getEnabledExtraRepos()) {
    if (extra.alias === target) return { label: extra.alias, root: extra.dir };
  }

  const expanded = target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
  const abs = path.resolve(cwd ?? process.cwd(), expanded);
  const stat = safeStat(abs);
  if (!stat || !stat.isDirectory()) return null;

  // A dir literally named `.agents` is the root itself.
  if (path.basename(abs) === '.agents') {
    return { label: path.basename(path.dirname(abs)), root: abs };
  }
  // A nested `.agents/` that is a populated DotAgents root wins over `abs` — the
  // project case (`agents inspect .` from a repo root whose resources live under
  // `.agents/`, while the repo's own top-level `skills/`, `agents.yaml` pin, etc.
  // are unrelated source, not a DotAgents tree).
  const nested = path.join(abs, '.agents');
  if (isDotAgentsRoot(nested)) {
    return { label: path.basename(abs), root: nested };
  }
  // Otherwise treat `abs` itself as the root: standalone clones and extra repos
  // like ~/.agents-extras keep resources at the top level and use `.agents/`
  // only for worktrees (so their nested `.agents/` is not a DotAgents root).
  if (isDotAgentsRoot(abs)) {
    return { label: path.basename(abs), root: abs };
  }
  return null;
}

function isDotAgentsRoot(dir: string): boolean {
  for (const marker of REPO_MARKER_FILES) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  for (const kind of DRILLABLE_KINDS) {
    if (safeStat(path.join(dir, kind))?.isDirectory()) return true;
  }
  return false;
}

export async function inspectRepo(repo: RepoTarget, options: InspectOptions): Promise<void> {
  const drill = pickDrillKind(options);
  const jsonHead = { repo: repo.label, root: repo.root };

  if (drill) {
    const items = collectRepoKind(repo, drill.kind);
    if (drill.query === true || drill.query === undefined) {
      renderItemList(repo.label, jsonHead, drill.kind, items, options);
    } else {
      renderItemDetail(repo.label, jsonHead, drill.kind, String(drill.query), items, options);
    }
    return;
  }

  renderRepoSummary(repo, options);
}

/** List one resource kind from a single repo root — no layering, no overrides. */
export function collectRepoKind(repo: RepoTarget, kind: DrillableKind): ResourceItem[] {
  // Plugins are bundles with a manifest + nested skills/commands/hooks — read
  // them through the plugin discoverer so the manifest description and bundled
  // resources surface, rather than treating each as an opaque directory.
  if (kind === 'plugins') {
    return discoverPluginsInDir(path.join(repo.root, 'plugins'))
      .map(p => pluginToItem(p, repo.label))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const dir = path.join(repo.root, kind);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }

  const items: ResourceItem[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // Build/tooling caches are never resources — they only inflate counts.
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    items.push({
      name: entry.name.replace(/\.(md|yaml|yml|toml|json)$/, ''),
      source: repo.label,
      path: p,
      linkTarget: linkTarget(p),
      description: readDescription(p),
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** A few resource names for the at-a-glance preview, with a `…(+N)` tail. */
function previewNames(items: ResourceItem[], n: number): string {
  if (items.length === 0) return '';
  const shown = items.slice(0, n).map(i => i.name);
  const extra = items.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` …(+${extra})` : '');
}

/** Recursive size + file count of a path; symlinks are not followed. */
export function pathSize(p: string): { bytes: number; files: number } {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(p); } catch { return { bytes: 0, files: 0 }; }
  if (stat.isSymbolicLink()) return { bytes: 0, files: 0 };
  if (stat.isFile()) return { bytes: stat.size, files: 1 };
  if (!stat.isDirectory()) return { bytes: 0, files: 0 };
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return { bytes: 0, files: 0 }; }
  let bytes = 0, files = 0;
  for (const e of entries) {
    const sub = pathSize(path.join(p, e.name));
    bytes += sub.bytes; files += sub.files;
  }
  return { bytes, files };
}

/** Human byte size: "84 KB", "3.1 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export interface ManifestSummary {
  /** `run.<agent>.strategy` pairs from agents.yaml. */
  strategies: Array<{ agent: string; strategy: string }>;
  /** `agents.<agent>` version pins from agents.yaml, when present. */
  versions: Array<{ agent: string; version: string }>;
}

/** Parse the repo's own agents.yaml into the version pins + run strategies it declares. */
export function repoManifestSummary(root: string): ManifestSummary | null {
  let parsed: unknown;
  try {
    parsed = yaml.parse(fs.readFileSync(path.join(root, 'agents.yaml'), 'utf-8'));
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const strategies: ManifestSummary['strategies'] = [];
  if (obj.run && typeof obj.run === 'object') {
    for (const [agent, cfg] of Object.entries(obj.run as Record<string, unknown>)) {
      const strategy = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).strategy : undefined;
      if (typeof strategy === 'string') strategies.push({ agent, strategy });
    }
  }

  const versions: ManifestSummary['versions'] = [];
  if (obj.agents && typeof obj.agents === 'object') {
    for (const [agent, ver] of Object.entries(obj.agents as Record<string, unknown>)) {
      if (typeof ver === 'string') versions.push({ agent, version: ver });
    }
  }

  if (strategies.length === 0 && versions.length === 0) return null;
  return { strategies, versions };
}

function renderRepoSummary(repo: RepoTarget, options: InspectOptions): void {
  const git = repoGitInfo(repo.root);
  const manifests = REPO_MARKER_FILES.filter(m => fs.existsSync(path.join(repo.root, m)));
  const manifest = repoManifestSummary(repo.root);

  const kindData = {} as Record<DrillableKind, { items: ResourceItem[]; size: { bytes: number; files: number } }>;
  let totalBytes = 0, totalFiles = 0;
  let repoHookByScript: Map<string, ManifestHook> = new Map();
  let repoHookItemList: ResourceItem[] = [];
  let repoMcpConfigs: Map<string, McpYamlConfig> = new Map();
  if (!options.brief) {
    for (const kind of DRILLABLE_KINDS) {
      const items = collectRepoKind(repo, kind);
      const size = pathSize(path.join(repo.root, kind));
      kindData[kind] = { items, size };
      totalBytes += size.bytes; totalFiles += size.files;
    }
    repoHookByScript = hookManifestByScript(hookManifestFromFile(path.join(repo.root, 'agents.yaml')));
    repoHookItemList = repoHookItems(repo);
    repoMcpConfigs = new Map(discoverMcpConfigsFromRepo(repo.root).map(s => [s.name, s.config]));
  }

  if (options.json) {
    console.log(JSON.stringify({
      repo: repo.label,
      root: repo.root,
      git,
      manifests,
      manifest,
      size: options.brief ? null : { bytes: totalBytes, files: totalFiles },
      resources: options.brief ? null : Object.fromEntries(
        DRILLABLE_KINDS.map(kind => {
          const size = kindData[kind].size;
          // Hooks use the grouped reader (clean names) instead of the raw readdir.
          const items = kind === 'hooks' ? repoHookItemList : kindData[kind].items;
          const base = {
            count: items.length,
            bytes: size.bytes,
            files: size.files,
            names: items.map(i => i.name),
          };
          if (kind === 'hooks') return [kind, { ...base, items: items.map(i => {
            const h = repoHookByScript.get(i.name);
            return { name: i.name, events: h?.events ?? [], matcher: h?.matcher, matches: h?.matches, cache: h?.cache };
          }) }];
          if (kind === 'mcp') return [kind, { ...base, items: items.map(i => {
            const c = repoMcpConfigs.get(i.name);
            return { name: i.name, transport: c?.transport, url: c?.url, command: c?.command, args: c?.args };
          }) }];
          if (kind === 'plugins') return [kind, { ...base, items: items.map(i => ({
            name: i.name,
            version: i.extra?.find(([k]) => k === 'version')?.[1],
            groups: Object.fromEntries((i.groups ?? []).map(g => [g.label, g.items.length])),
          })) }];
          return [kind, base];
        }),
      ),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(repo.label) + '  ' + chalk.gray('[dotagents repo]') + '\n');

  // Indent for continuation sub-rows: 2 leading + 10 key column + 1 space.
  const sub = (label: string, value: string) => console.log(`  ${''.padEnd(10)} ${chalk.gray(label.padEnd(8))} ${value}`);

  console.log(`  ${'root'.padEnd(10)} ${termLink(repo.root, repo.root)}`);

  if (git) {
    const dirty = git.dirty > 0 ? ` ${chalk.gray('·')} ${chalk.yellow(`${git.dirty} dirty`)}` : '';
    const url = git.url ? ` ${chalk.gray('·')} ${chalk.gray(git.url)}` : '';
    console.log(`  ${'git'.padEnd(10)} ${git.branch}${dirty}${url}`);
    if (git.lastCommit) {
      const rel = git.lastCommit.relative ? `  ${chalk.gray(`(${git.lastCommit.relative})`)}` : '';
      sub('last', `${chalk.cyan(git.lastCommit.sha)}  ${truncate(git.lastCommit.subject, 60)}${rel}`);
    }
    if (git.ahead !== null && git.behind !== null && (git.ahead > 0 || git.behind > 0)) {
      sub('sync', `ahead ${git.ahead} ${chalk.gray('·')} behind ${git.behind}`);
    }
    if (git.dirtyFiles.length > 0) {
      const shown = git.dirtyFiles.slice(0, 4).join(', ');
      const extra = git.dirtyFiles.length - Math.min(4, git.dirtyFiles.length);
      sub('dirty', chalk.yellow(shown + (extra > 0 ? ` …(+${extra})` : '')));
    }
  }

  if (manifests.length > 0) {
    console.log(`  ${'manifests'.padEnd(10)} ${manifests.join(', ')}`);
    if (manifest) {
      if (manifest.versions.length > 0) {
        sub('versions', manifest.versions.map(v => `${v.agent} ${chalk.cyan(v.version)}`).join(chalk.gray(' · ')));
      }
      if (manifest.strategies.length > 0) {
        sub('run', manifest.strategies.map(s => `${s.agent}:${s.strategy}`).join(chalk.gray(' · ')));
      }
    }
  }

  if (!options.brief) {
    console.log(`  ${'size'.padEnd(10)} ${formatBytes(totalBytes)} ${chalk.gray('·')} ${totalFiles} files`);

    console.log('\n' + chalk.bold('Resources'));
    for (const kind of SIMPLE_KINDS) {
      const { items, size } = kindData[kind];
      const count = String(items.length).padStart(4);
      const sz = items.length > 0 ? formatBytes(size.bytes).padStart(8) : ''.padEnd(8);
      const preview = items.length > 0 ? chalk.gray(truncate(previewNames(items, 4), 60)) : '';
      console.log(`  ${kind.padEnd(10)} ${count}  ${sz}  ${preview}`.trimEnd());
    }

    printExpandedSection('Hooks', hookRows(repoHookItemList, repoHookByScript));
    printExpandedSection('Plugins', pluginRows(kindData.plugins.items));
    printExpandedSection('MCP', mcpRows(kindData.mcp.items, repoMcpConfigs));
  }

  console.log('');
  console.log(chalk.gray(`Drill in:   agents inspect ${repo.label} --skills <query>`));
  console.log('');
}

export interface RepoGitInfo {
  branch: string;
  dirty: number;
  dirtyFiles: string[];
  url: string | null;
  lastCommit: { sha: string; subject: string; relative: string } | null;
  ahead: number | null;
  behind: number | null;
}

export function repoGitInfo(root: string): RepoGitInfo | null {
  const git = (args: string): string | null => {
    try {
      return execSync(`git -C ${JSON.stringify(root)} ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch { return null; }
  };
  const branch = git('rev-parse --abbrev-ref HEAD');
  if (branch === null) return null;

  // Read status WITHOUT trimming — git()'s .trim() would strip the leading
  // space of the first porcelain line (`XY path`), corrupting the path slice.
  let statusRaw: string | null;
  try {
    statusRaw = execSync(`git -C ${JSON.stringify(root)} status --porcelain`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch { statusRaw = null; }
  const dirtyFiles = statusRaw ? statusRaw.split('\n').filter(Boolean).map(l => l.slice(3)) : [];

  let lastCommit: RepoGitInfo['lastCommit'] = null;
  const log = git('log -1 --format=%h%x1f%s%x1f%cr');
  if (log) {
    const [sha, subject, relative] = log.split('\x1f');
    if (sha) lastCommit = { sha, subject: subject ?? '', relative: relative ?? '' };
  }

  let ahead: number | null = null, behind: number | null = null;
  const counts = git("rev-list --left-right --count '@{upstream}...HEAD'");
  if (counts) {
    const [b, a] = counts.split(/\s+/).map(n => parseInt(n, 10));
    if (Number.isFinite(b) && Number.isFinite(a)) { behind = b; ahead = a; }
  }

  return { branch, dirty: dirtyFiles.length, dirtyFiles, url: git('remote get-url origin'), lastCommit, ahead, behind };
}

// ─── Summary mode ────────────────────────────────────────────────────────────

async function renderSummary(agent: AgentId, version: string, versionHome: string, options: InspectOptions): Promise<void> {
  const meta = readMeta();
  const isDefault = meta.agents?.[agent] === version;
  const strategy = meta.run?.[agent]?.strategy ?? 'pinned';
  const cliState = await getCliState(agent).catch(() => null);

  const configSymlink = path.join(os.homedir(), `.${agent}`);
  const configTarget = readSymlinkSafe(configSymlink);

  const shimPath = path.join(getShimsDir(), AGENTS[agent].cliCommand);
  const aliasPath = getVersionedAliasPath(agent, version);

  const capabilities = collectCapabilities(agent, version);

  const itemsByKind = options.brief ? null : collectItemsByKind(agent, versionHome);
  const hookByScript = options.brief ? null : hookManifestByScript(loadCentralHookManifest());
  const mcpConfigs = options.brief ? null : new Map(listMcpServerConfigs().map(s => [s.name, s.config]));

  const sessions = options.brief ? null : {
    total: safeCountSessions(agent),
  };

  if (options.json) {
    const json = {
      agent,
      version,
      default: isDefault,
      home: versionHome,
      configSymlink: configTarget ? { from: configSymlink, to: configTarget } : null,
      shim: shimPath,
      alias: aliasPath,
      strategy,
      installedShim: cliState?.installed === true ? cliState.path : null,
      capabilities,
      resources: itemsByKind ? summaryResourcesJson(itemsByKind, hookByScript!, mcpConfigs!) : null,
      sessions,
    };
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  // Plain text
  const head = `${chalk.bold(agent)} ${chalk.gray('@')} ${chalk.cyan(version)}${isDefault ? '  ' + chalk.green('[default]') : ''}`;
  console.log('\n' + head + '\n');

  const rows: Array<[string, string]> = [
    ['install', versionHome],
    ['config', configTarget ? `${configSymlink}  ${chalk.gray('→')}  ${configTarget}` : chalk.gray('(no symlink)')],
    ['shim', shimPath],
    ['alias', aliasPath],
    ['strategy', strategy],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(10)} ${v}`);

  console.log('\n' + chalk.bold('Capabilities'));
  for (const cap of CAPABILITY_NAMES) {
    const res = capabilities[cap];
    const mark = res.ok ? chalk.green('✓') : chalk.red('✗');
    const reason = res.ok ? '' : chalk.gray(`(${res.reason}${res.need ? ' ' + res.need : ''})`);
    console.log(`  ${cap.padEnd(10)} ${mark} ${reason}`);
  }

  if (itemsByKind) {
    console.log('\n' + chalk.bold('Resources'));
    for (const kind of SIMPLE_KINDS) {
      printSimpleResourceRow(kind, itemsByKind[kind]);
    }
    printExpandedSection('Hooks', hookRows(itemsByKind.hooks, hookByScript!));
    printExpandedSection('Plugins', pluginRows(itemsByKind.plugins));
    printExpandedSection('MCP', mcpRows(itemsByKind.mcp, mcpConfigs!));
  }

  if (sessions) {
    console.log('\n' + chalk.bold('Sessions'));
    console.log(`  ${'total'.padEnd(10)} ${sessions.total}   ${chalk.gray('(across all versions)')}`);
  }

  console.log('');
  console.log(chalk.gray(`Drill in:   agents inspect ${agent}@${version} --skills <query>`));
  console.log(chalk.gray(`Diagnose:   agents doctor ${agent}@${version}`));
  console.log('');
}

// ─── List mode ───────────────────────────────────────────────────────────────

async function renderList(agent: AgentId, version: string, versionHome: string, kind: DrillableKind, options: InspectOptions): Promise<void> {
  const items = collectKind(agent, versionHome, kind);
  renderItemList(`${agent}@${version}`, { agent, version }, kind, items, options);
}

function renderItemList(header: string, jsonHead: Record<string, unknown>, kind: DrillableKind, items: ResourceItem[], options: InspectOptions): void {
  if (options.json) {
    console.log(JSON.stringify({
      ...jsonHead,
      kind,
      count: items.length,
      items: items.map(i => ({ name: i.name, source: i.source, path: i.path, description: i.description, ...(i.groups ? { groups: i.groups } : {}) })),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(header) + '  ' + chalk.gray(`${kind} (${items.length})`) + '\n');

  if (items.length === 0) {
    console.log(chalk.gray(`  (none installed)`));
    console.log('');
    return;
  }

  for (const item of items) {
    const tag = chalk.gray(`[${item.source}]`.padEnd(10));
    console.log(`  ${tag} ${termLink(chalk.cyan(item.name), item.linkTarget)}`);
    if (item.description) {
      console.log(`             ${chalk.gray(truncate(item.description, 90))}`);
    }
    if (item.groups) printGroupRows(item.groups);
  }
  console.log('');
}

/** Print a plugin's resource breakdown as aligned `label  items` rows under a list entry. */
function printGroupRows(groups: PluginResourceGroup[]): void {
  if (groups.length === 0) return;
  const width = Math.max(...groups.map(g => g.label.length));
  for (const g of groups) {
    const colorFn = PLUGIN_GROUP_COLORS[g.label] ?? chalk.white;
    const label = chalk.gray(g.label.padEnd(width));
    const value = g.items.map((s) => colorFn(s)).join(chalk.gray(', '));
    console.log(`             ${label}  ${value}`);
  }
}

// ─── Detail mode (fuzzy) ─────────────────────────────────────────────────────

async function renderDetail(agent: AgentId, version: string, versionHome: string, kind: DrillableKind, query: string, options: InspectOptions): Promise<void> {
  const items = collectKind(agent, versionHome, kind);
  renderItemDetail(`${agent}@${version}`, { agent, version }, kind, query, items, options);
}

function renderItemDetail(header: string, jsonHead: Record<string, unknown>, kind: DrillableKind, query: string, items: ResourceItem[], options: InspectOptions): void {
  const matches = findMatches(items, query);

  if (matches.length === 0) {
    const suggestions = suggestClosest(items, query, 3);
    if (options.json) {
      console.log(JSON.stringify({ ...jsonHead, kind, query, match: null, suggestions: suggestions.map(s => s.name) }, null, 2));
    } else {
      console.error(chalk.red(`No ${kind} matching '${query}'.`));
      if (suggestions.length > 0) {
        console.error(chalk.gray(`Closest: ${suggestions.map(s => s.name).join(', ')}`));
      }
    }
    process.exit(1);
  }

  const best = matches[0];
  const others = matches.slice(1, 4);

  if (options.json) {
    const detail = buildDetail(best.item, kind);
    console.log(JSON.stringify({
      ...jsonHead,
      kind,
      query,
      match: { ...detail, matchKind: best.matchKind },
      others: others.map(o => ({ name: o.item.name, source: o.item.source, path: o.item.path, matchKind: o.matchKind })),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(header) + '  ' + chalk.gray(`${kind} matching "${query}"`) + '\n');
  const matchTag = best.matchKind === 'exact' ? 'exact' : best.matchKind === 'substring' ? 'substring' : `~${best.distance}`;
  console.log(`  ${chalk.green('✓')}  ${termLink(chalk.bold.cyan(best.item.name), best.item.linkTarget)}  ${chalk.gray(`[${matchTag}, ${best.item.source}]`)}`);
  if (best.item.description) {
    console.log(`     ${chalk.gray(truncate(best.item.description, 100))}`);
  }
  for (const [k, v] of buildDetailRows(best.item, kind)) {
    console.log(`     ${chalk.gray(k.padEnd(10))} ${v}`);
  }

  if (others.length > 0) {
    console.log('\n' + chalk.gray('Other matches:'));
    for (const m of others) {
      const tag = m.matchKind === 'substring' ? 'substring' : `~${m.distance}`;
      console.log(`  ${termLink(chalk.cyan(m.item.name), m.item.linkTarget)}  ${chalk.gray(`(${tag}) [${m.item.source}]`)}`);
    }
  }
  console.log('');
}

// ─── Data collection ─────────────────────────────────────────────────────────

function collectCapabilities(agent: AgentId, version: string): Record<CapabilityName, { ok: boolean; reason?: string; need?: string }> {
  const out = {} as Record<CapabilityName, { ok: boolean; reason?: string; need?: string }>;
  for (const cap of CAPABILITY_NAMES) {
    const res = supports(agent, cap, version);
    if (res.ok) {
      out[cap] = { ok: true };
    } else {
      out[cap] = { ok: false, reason: res.reason, need: res.need };
    }
  }
  return out;
}

function collectItemsByKind(agent: AgentId, versionHome: string): Record<DrillableKind, ResourceItem[]> {
  const out = {} as Record<DrillableKind, ResourceItem[]>;
  for (const kind of DRILLABLE_KINDS) out[kind] = collectKind(agent, versionHome, kind);
  return out;
}

/** A simple-kind count row: `kind  N   user:30 system:12   name, name …(+K)`. */
function printSimpleResourceRow(kind: string, items: ResourceItem[]): void {
  const count = String(items.length).padStart(4);
  const breakdown = chalk.gray(scopeBreakdownPlain(countBySource(items.map(i => i.source))).padEnd(18));
  const preview = items.length > 0 ? chalk.gray(truncate(previewNames(items, 3), 48)) : '';
  console.log(`  ${kind.padEnd(10)} ${count}   ${breakdown}  ${preview}`.trimEnd());
}

/**
 * Build the `resources` JSON: every kind keeps `total` + `bySource` (back-compat),
 * simple kinds add `names`, and the rich kinds add structured `items` (hook
 * events/predicates, mcp transport/url/command, plugin version + group counts).
 */
function summaryResourcesJson(
  itemsByKind: Record<DrillableKind, ResourceItem[]>,
  hookByScript: Map<string, ManifestHook>,
  mcpConfigs: Map<string, McpYamlConfig>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kind of DRILLABLE_KINDS) {
    const items = itemsByKind[kind];
    const base = { total: items.length, bySource: countBySource(items.map(i => i.source)) };
    if (kind === 'hooks') {
      out[kind] = { ...base, items: items.map(i => {
        const h = hookByScript.get(i.name);
        return { name: i.name, source: i.source, events: h?.events ?? [], matcher: h?.matcher, matches: h?.matches, cache: h?.cache };
      }) };
    } else if (kind === 'mcp') {
      out[kind] = { ...base, items: items.map(i => {
        const c = mcpConfigs.get(i.name);
        return { name: i.name, source: i.source, transport: c?.transport, url: c?.url, command: c?.command, args: c?.args };
      }) };
    } else if (kind === 'plugins') {
      out[kind] = { ...base, items: items.map(i => ({
        name: i.name,
        source: i.source,
        version: i.extra?.find(([k]) => k === 'version')?.[1],
        groups: Object.fromEntries((i.groups ?? []).map(g => [g.label, g.items.length])),
      })) };
    } else {
      out[kind] = { ...base, names: items.map(i => i.name) };
    }
  }
  return out;
}

function collectKind(agent: AgentId, versionHome: string, kind: DrillableKind): ResourceItem[] {
  switch (kind) {
    case 'commands':
    case 'hooks':
    case 'workflows':
      return entriesFromAgentResources(agent, versionHome, kind);
    case 'skills':
      return skillsFromAgentResources(agent, versionHome);
    case 'mcp':
      return mcpItems(agent, versionHome);
    case 'rules':
    case 'subagents':
      return listResources(kind).map(r => ({
        name: r.name,
        source: r.source,
        path: r.path,
        linkTarget: linkTarget(r.path),
        description: readDescription(r.path),
      }));
    case 'plugins':
      return pluginItems();
  }
}

function pluginItems(): ResourceItem[] {
  return discoverPlugins().map(p => pluginToItem(p, 'user'));
}

/**
 * Map a discovered plugin to a resource item, surfacing the manifest description
 * and the bundle's nested resources (skills, commands, hooks, ...) as detail rows.
 */
function pluginToItem(plugin: DiscoveredPlugin, source: string): ResourceItem {
  const extra: Array<[string, string]> = [];
  if (plugin.manifest.version) extra.push(['version', plugin.manifest.version]);
  return {
    name: plugin.name,
    source,
    path: plugin.root,
    linkTarget: linkTarget(plugin.root),
    description: plugin.manifest.description ?? '',
    extra,
    groups: pluginResourceGroups(plugin),
  };
}

function entriesFromAgentResources(agent: AgentId, versionHome: string, kind: 'commands' | 'hooks' | 'workflows'): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  const list = res[kind] as ResourceEntry[];
  return list.map(e => ({
    name: e.name,
    source: e.scope,
    path: e.path,
    linkTarget: linkTarget(e.path),
    description: readDescription(e.path),
  }));
}

function skillsFromAgentResources(agent: AgentId, versionHome: string): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  return (res.skills as SkillResourceEntry[]).map(s => ({
    name: s.name,
    source: s.scope,
    path: s.path,
    linkTarget: linkTarget(s.path),
    description: readDescription(s.path),
  }));
}

function mcpItems(agent: AgentId, versionHome: string): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  return res.mcp.map(m => ({
    name: m.name,
    source: m.scope,
    path: '',
    linkTarget: '',
    description: m.version ? `version ${m.version}` : '',
  }));
}

// ─── Detail field builders ───────────────────────────────────────────────────

function buildDetail(item: ResourceItem, kind: DrillableKind): Record<string, unknown> {
  const rows = buildDetailRows(item, kind);
  const out: Record<string, unknown> = {
    name: item.name,
    source: item.source,
    path: item.path,
    description: item.description,
  };
  for (const [k, v] of rows) out[k] = v;
  return out;
}

function buildDetailRows(item: ResourceItem, kind: DrillableKind): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (item.path && kind !== 'mcp') {
    const stat = safeStat(item.path);
    if (stat) rows.push(['size', stat.isDirectory() ? '(bundle)' : `${stat.size} bytes`]);
  }
  // Kind-specific fields
  if (kind === 'skills' || kind === 'commands' || kind === 'subagents') {
    const fm = readFrontmatter(item.path);
    if (fm) {
      // description was already printed by caller; skip if redundant
      if (typeof fm.description === 'string' && fm.description.trim() !== item.description.trim()) {
        rows.push(['description', truncate(fm.description, 120)]);
      }
      if (Array.isArray(fm.triggers)) rows.push(['triggers', fm.triggers.join(', ')]);
      if (typeof fm.model === 'string') rows.push(['model', fm.model]);
      if (Array.isArray(fm.tools)) rows.push(['tools', fm.tools.join(', ')]);
    }
  }
  // Plugin bundles surface their nested resources (skills, commands, …) plus
  // scalar rows (version).
  if (kind === 'plugins') {
    if (item.groups) for (const g of item.groups) rows.push([g.label, g.items.join(', ')]);
    if (item.extra) rows.push(...item.extra);
  }
  return rows;
}

// ─── Rich expanded sections (summary view) ───────────────────────────────────

/** One row in an expanded section: a source tag, a clickable name, and a detail string. */
interface RichRow {
  source: string;
  name: string;
  detail: string;
  linkTarget?: string;
}

/** `system` → `sys`; everything else unchanged. Keeps the tag column narrow. */
function abbrevSource(s: string): string {
  return s === 'system' ? 'sys' : s;
}

/**
 * Compact one-liner for a hook from its manifest entry: the firing events (with
 * the matcher/tool-name in parens), then a `·`-separated predicate summary, then
 * an optional cache tail. Plain text — the caller applies color.
 */
export function summarizeHook(hook: ManifestHook): string {
  const events = (hook.events ?? []).join('/') || '(no event)';
  let matcher = hook.matcher;
  if (!matcher && hook.matches?.tool_name) {
    const tn = hook.matches.tool_name;
    matcher = Array.isArray(tn) ? tn.join('|') : tn;
  }
  const head = matcher ? `${events}(${matcher})` : events;

  const parts = [head];
  const preds = summarizeMatches(hook.matches);
  if (preds) parts.push(preds);
  let line = parts.join(' · ');

  const ttl = hookCacheTtl(hook.cache);
  if (ttl) line += ` (${ttl} cache)`;
  return line;
}

/** `·`-separated predicate summary from a hook's `matches:` block (tool_name omitted — shown in the matcher parens). */
function summarizeMatches(m?: HookMatches): string {
  if (!m) return '';
  const bits: string[] = [];
  if (m.git_dirty) bits.push('git_dirty');
  if (m.prompt_contains) bits.push(`prompt~"${truncate(m.prompt_contains, 24)}"`);
  if (m.prompt_matches) bits.push(`prompt=/${truncate(m.prompt_matches, 24)}/`);
  if (m.tool_args_match) bits.push(`args=/${truncate(m.tool_args_match, 20)}/`);
  if (m.cwd_includes) {
    const c = Array.isArray(m.cwd_includes) ? m.cwd_includes.join('|') : m.cwd_includes;
    bits.push(`cwd~${truncate(c, 24)}`);
  }
  if (m.project_has) bits.push(`has ${m.project_has}`);
  return bits.join(' · ');
}

/** Normalize a hook cache shorthand/object to a display ttl ("5m", "1h"); null when uncached. */
function hookCacheTtl(cache?: HookCache): string | null {
  if (cache === undefined || cache === null) return null;
  if (typeof cache === 'string') return cache.replace(/-bg$/, '');
  return String(cache.ttl);
}

/** Compact one-liner for an MCP server: padded transport + the url (http) or command line (stdio). */
export function summarizeMcp(cfg: McpYamlConfig): string {
  const target = cfg.transport === 'http'
    ? (cfg.url ?? '')
    : [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ');
  return `${cfg.transport.padEnd(5)}  ${truncate(target, 60)}`.trimEnd();
}

/** Print `Title (N)` then up to `max` aligned `[source] name  detail` rows with a `…(+K)` tail. */
function printExpandedSection(title: string, rows: RichRow[], max = 6): void {
  console.log('\n' + chalk.bold(title) + chalk.gray(` (${rows.length})`));
  if (rows.length === 0) {
    console.log(chalk.gray('  (none)'));
    return;
  }
  const shown = rows.slice(0, max);
  const nameW = Math.max(...shown.map(r => r.name.length));
  for (const r of shown) {
    const tag = chalk.gray(`[${abbrevSource(r.source)}]`.padEnd(8));
    const padded = r.name.padEnd(nameW);
    const name = r.linkTarget ? termLink(chalk.cyan(padded), r.linkTarget) : chalk.cyan(padded);
    const detail = r.detail ? '  ' + chalk.gray(r.detail) : '';
    console.log(`  ${tag} ${name}${detail}`);
  }
  if (rows.length > max) console.log(chalk.gray(`  …(+${rows.length - max})`));
}

/** Tally a source list into `{user: n, system: m}`. */
function countBySource(sources: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) out[s] = (out[s] || 0) + 1;
  return out;
}

/** Unbracketed scope breakdown for the simple count rows: `user:30 system:12`. */
function scopeBreakdownPlain(bySource: Record<string, number>): string {
  return Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join(' ');
}

/**
 * Index a hook manifest by script basename (no extension). Installed hooks are
 * named after their script file (`04-capture-…`), while the manifest is keyed by
 * logical name (`capture-…`) with the filename in `script:` — so we join on the
 * script basename, not the manifest key.
 */
export function hookManifestByScript(manifest: Record<string, ManifestHook>): Map<string, ManifestHook> {
  const out = new Map<string, ManifestHook>();
  for (const hook of Object.values(manifest)) {
    if (hook && typeof hook.script === 'string') {
      out.set(path.basename(hook.script).replace(/\.[^.]+$/, ''), hook);
    }
  }
  return out;
}

/** Build hook rows by enriching the installed hook items with manifest events/predicates. */
function hookRows(items: ResourceItem[], byScript: Map<string, ManifestHook>): RichRow[] {
  return items.map(item => {
    const hook = byScript.get(item.name);
    return {
      source: item.source,
      name: item.name,
      linkTarget: item.linkTarget,
      // Hooks are shell scripts with no human description — show events/predicates
      // from the manifest, or nothing rather than a meaningless shebang line.
      detail: hook ? summarizeHook(hook) : '',
    };
  });
}

/** Build plugin rows: `vVERSION  skills:6 commands:5 …` from the bundle's groups. */
function pluginRows(items: ResourceItem[]): RichRow[] {
  return items.map(item => {
    const version = item.extra?.find(([k]) => k === 'version')?.[1];
    const counts = (item.groups ?? []).map(g => `${g.label}:${g.items.length}`).join(' ');
    const detail = [version ? `v${version}` : '', counts].filter(Boolean).join('  ');
    return { source: item.source, name: item.name, detail, linkTarget: item.linkTarget };
  });
}

/** Build MCP rows by joining the installed mcp items with their full configs (transport/url/command). */
function mcpRows(items: ResourceItem[], configs: Map<string, McpYamlConfig>): RichRow[] {
  return items.map(item => {
    const cfg = configs.get(item.name);
    return { source: item.source, name: item.name, detail: cfg ? summarizeMcp(cfg) : item.description };
  });
}

/** Read a repo/agents.yaml `hooks:` section into a name→ManifestHook map (best-effort). */
function hookManifestFromFile(agentsYamlPath: string): Record<string, ManifestHook> {
  try {
    const meta = yaml.parse(fs.readFileSync(agentsYamlPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
    return meta?.hooks ?? {};
  } catch { return {}; }
}

/**
 * Merge the system + user `agents.yaml` hook manifests (user wins on key
 * collision). Built directly from the two layer files rather than via
 * `parseHookManifest()` so inspecting never emits the shadow/override warnings
 * that the registrar path prints.
 */
function loadCentralHookManifest(): Record<string, ManifestHook> {
  return {
    ...hookManifestFromFile(path.join(getSystemAgentsDir(), 'agents.yaml')),
    ...hookManifestFromFile(path.join(getUserAgentsDir(), 'agents.yaml')),
  };
}

/**
 * Hook items for a repo's Hooks section. Uses the grouped hook reader (script +
 * data file collapsed into one entry, non-hook files like promptcuts.yaml or
 * README.md filtered out) rather than a naive readdir, so names are clean and
 * join cleanly against the manifest by script basename.
 */
function repoHookItems(repo: RepoTarget): ResourceItem[] {
  return listHookEntriesFromDir(path.join(repo.root, 'hooks')).map(h => ({
    name: h.name,
    source: repo.label,
    path: h.scriptPath,
    linkTarget: h.scriptPath,
    description: '',
  }));
}

// ─── Fuzzy matching ──────────────────────────────────────────────────────────

interface ScoredMatch {
  item: ResourceItem;
  matchKind: 'exact' | 'substring' | 'fuzzy';
  distance: number;
}

function findMatches(items: ResourceItem[], query: string): ScoredMatch[] {
  const q = query.toLowerCase();
  const out: ScoredMatch[] = [];

  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name === q) {
      out.push({ item, matchKind: 'exact', distance: 0 });
    } else if (name.includes(q)) {
      out.push({ item, matchKind: 'substring', distance: name.length - q.length });
    }
  }

  if (out.length > 0) {
    out.sort((a, b) => rankMatch(a) - rankMatch(b));
    return out;
  }

  // No substring hits — fall back to edit distance.
  const threshold = Math.max(2, Math.floor(q.length * 0.3));
  for (const item of items) {
    const d = damerauLevenshtein(q, item.name.toLowerCase());
    if (d <= threshold) out.push({ item, matchKind: 'fuzzy', distance: d });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

function rankMatch(m: ScoredMatch): number {
  if (m.matchKind === 'exact') return 0;
  if (m.matchKind === 'substring') return 100 + m.distance;
  return 1000 + m.distance;
}

function suggestClosest(items: ResourceItem[], query: string, n: number): ResourceItem[] {
  const q = query.toLowerCase();
  const scored = items.map(item => ({ item, d: damerauLevenshtein(q, item.name.toLowerCase()) }));
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, n).map(s => s.item);
}

// ─── Frontmatter + description helpers ───────────────────────────────────────

function readDescription(p: string): string {
  if (!p) return '';
  let filePath = p;
  try {
    if (fs.statSync(p).isDirectory()) {
      for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md', 'README.md']) {
        const c = path.join(p, marker);
        if (fs.existsSync(c)) { filePath = c; break; }
      }
    }
  } catch { return ''; }

  const fm = readFrontmatter(filePath);
  if (fm && typeof fm.description === 'string' && fm.description.trim().length > 0) {
    return fm.description.trim();
  }
  return readFirstProseLine(filePath);
}

function readFrontmatter(p: string): Record<string, unknown> | null {
  if (!p) return null;
  let filePath = p;
  try {
    if (fs.statSync(p).isDirectory()) {
      for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md']) {
        const c = path.join(p, marker);
        if (fs.existsSync(c)) { filePath = c; break; }
      }
    }
  } catch { return null; }

  if (!filePath.endsWith('.md')) return null;
  let head = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf-8');
  } catch { return null; }

  if (!head.startsWith('---')) return null;
  const end = head.indexOf('\n---', 3);
  if (end === -1) return null;
  const body = head.slice(3, end).trim();
  try {
    const parsed = yaml.parse(body);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function readFirstProseLine(p: string): string {
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return '';
    if (stat.size > 64 * 1024) return '';
    const text = fs.readFileSync(p, 'utf-8');
    // Skip frontmatter
    let body = text;
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 3);
      if (end !== -1) body = body.slice(end + 4);
    }
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) return line.replace(/^#+\s*/, '');
      return line;
    }
  } catch { /* ignore */ }
  return '';
}

// ─── OSC-8 + path helpers ────────────────────────────────────────────────────

function termLink(text: string, filePath: string): string {
  if (!filePath) return text;
  const url = `file://${filePath}`;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function linkTarget(p: string): string {
  if (!p) return '';
  try {
    if (!fs.statSync(p).isDirectory()) return p;
  } catch { return p; }
  for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md']) {
    const c = path.join(p, marker);
    if (fs.existsSync(c)) return c;
  }
  return p;
}

function readSymlinkSafe(p: string): string | null {
  try {
    const stat = fs.lstatSync(p);
    if (!stat.isSymbolicLink()) return null;
    return fs.readlinkSync(p);
  } catch { return null; }
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

const SESSION_AGENTS: ReadonlySet<string> = new Set([
  'claude', 'codex', 'gemini', 'opencode', 'openclaw', 'rush', 'hermes', 'grok', 'kimi',
]);

function safeCountSessions(agent: AgentId): number {
  if (!SESSION_AGENTS.has(agent)) return 0;
  try { return countSessionsInScope({ agent: agent as SessionAgentId }); } catch { return 0; }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
