/**
 * Extra DotAgent repo management.
 *
 * Registers `agents repos add|init|list|remove|enable|disable` (`repo` alias)
 * which manage additional DotAgent repos alongside the primary ~/.agents/.system/
 * repo so private, work, or team skills can ship separately from public ones.
 *
 * Extras are user-level config: managed clones live at ~/.agents-<alias>/ as
 * peer dirs to ~/.agents/, and user-owned repos may live anywhere. All extras
 * are registered in meta.extraRepos. Sync functions merge their resources into
 * agent version homes after the user repo's (user-wins on name collisions).
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { visibleWidth, padVisible } from '../lib/format.js';
import { stripAnsi } from '../lib/session/width.js';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import simpleGit from 'simple-git';
import { confirm, input } from '@inquirer/prompts';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { itemPicker } from '../lib/picker.js';
import { addHostOption } from '../lib/hosts/option.js';
import {
  inspectRepo,
  resolveRepoTarget,
  type RepoTarget as InspectRepoTarget,
  type InspectOptions,
} from './inspect.js';

const HOME = os.homedir();

/**
 * Resolve a target argument to an absolute path.
 * - No arg: ~/.agents/
 * - Looks like a path (starts with /, ~, .): resolve as path
 * - Otherwise: ~/.agents-{name}/
 */
function resolveRepoPath(target?: string): string {
  if (!target) return path.join(HOME, '.agents');
  const trimmed = target.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.startsWith('.')) {
    return path.resolve(trimmed.replace(/^~/, HOME));
  }
  return path.join(HOME, `.agents-${trimmed}`);
}

import {
  applyExtraAliasToVersions,
  ensureAgentsDir,
  getExtraRepoDir,
  getSystemAgentsDir,
  getUserAgentsDir,
  readMeta,
  resolveExtraRepoDir,
  updateMeta,
} from '../lib/state.js';
import {
  parseSource,
  pullRepo,
  commitAndPush,
  isGitRepo,
  isSystemRepoOrigin,
  adoptRepo,
  displayHomePath,
} from '../lib/git.js';
import { DEFAULT_SYSTEM_REPO } from '../lib/types.js';
import type { AgentId, ExtraRepoConfig } from '../lib/types.js';
import { ALL_AGENT_IDS, isAgentName, resolveAgentName } from '../lib/agents.js';
import { refresh } from '../lib/refresh.js';
import { capableAgents } from '../lib/capabilities.js';
import { getGlobalDefault, getVersionHomePath, listInstalledVersions } from '../lib/versions.js';
import { syncAllMarketplaces } from '../lib/plugin-marketplace.js';

/**
 * After a repo add/remove/enable/disable, reconcile each plugins-capable
 * agent's default version against the new marketplace set. Re-synthesizes
 * catalogs and known_marketplaces.json entries. Source-copy of plugins is
 * out of scope here — full sync still goes through `agents repo refresh`.
 */
function syncMarketplacesForDefaults(): void {
  for (const agent of capableAgents('plugins')) {
    const def = getGlobalDefault(agent);
    if (!def) continue;
    if (!listInstalledVersions(agent).includes(def)) continue;
    try {
      syncAllMarketplaces(agent, getVersionHomePath(agent, def));
    } catch { /* best-effort */ }
  }
}

const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Derive a default alias from a source URL (e.g. gh:foo/.agents-work -> agents-work). */
function deriveAlias(source: string): string {
  const parsed = parseSource(source);
  let base: string;
  if (parsed.type === 'local') {
    base = path.basename(parsed.url);
  } else {
    const match = parsed.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    base = match ? match[2] : parsed.url;
  }
  // Strip leading dots and any "agents-" prefix so the alias is short and
  // becomes ~/.agents-<alias>/ on disk (e.g. ".agents-work" -> "work").
  return base.replace(/^\.+/, '').replace(/^agents-/, '') || 'repo';
}

/**
 * These are DotAgent *resource* repos, so changes are reported at the resource
 * level ("2 skills, 1 hook") rather than the raw-file level. A resource is the
 * unit a user reasons about: one skill, one command, one plugin — even if it
 * spans several files on disk.
 */
type RepoResourceKind =
  | 'skill' | 'command' | 'plugin' | 'hook' | 'mcp' | 'subagent'
  | 'rule' | 'workflow' | 'routine' | 'profile' | 'permission'
  | 'cli' | 'config' | 'other';

/** Top-level dir -> resource kind. Directory-based resources collapse to one unit. */
const RESOURCE_DIRS: Record<string, RepoResourceKind> = {
  skills: 'skill', commands: 'command', prompts: 'command', plugins: 'plugin',
  hooks: 'hook', mcp: 'mcp', subagents: 'subagent', rules: 'rule',
  workflows: 'workflow', routines: 'routine', profiles: 'profile',
  permissions: 'permission', cli: 'cli',
};

/** [singular, plural] display labels per kind. */
const RESOURCE_LABELS: Record<RepoResourceKind, [string, string]> = {
  skill: ['skill', 'skills'], command: ['command', 'commands'],
  plugin: ['plugin', 'plugins'], hook: ['hook', 'hooks'], mcp: ['MCP', 'MCPs'],
  subagent: ['subagent', 'subagents'], rule: ['rule', 'rules'],
  workflow: ['workflow', 'workflows'], routine: ['routine', 'routines'],
  profile: ['profile', 'profiles'], permission: ['permission', 'permissions'],
  cli: ['CLI', 'CLIs'], config: ['config file', 'config files'],
  other: ['other file', 'other files'],
};

/** Display order — the resources a user cares about most come first. */
const RESOURCE_ORDER: RepoResourceKind[] = [
  'skill', 'command', 'plugin', 'hook', 'mcp', 'subagent', 'rule',
  'workflow', 'routine', 'profile', 'permission', 'cli', 'config', 'other',
];

export type ChangeAction = 'new' | 'changed' | 'removed';

/**
 * Map a repo-relative path to the resource unit it belongs to. Directory-based
 * resources (skills/foo/SKILL.md) collapse to `skills/foo` so all their files
 * count as one unit; flat config files (agents.yaml, hooks.yaml) count alone.
 */
export function resourceUnit(file: string): { kind: RepoResourceKind; unit: string } {
  const parts = file.split('/');
  const top = parts[0];
  if (top === 'agents.yaml' || top === 'hooks.yaml') return { kind: 'config', unit: top };
  const kind = RESOURCE_DIRS[top];
  if (kind) return { kind, unit: parts.length > 1 ? `${top}/${parts[1]}` : file };
  return { kind: 'other', unit: file };
}

/** One resource kind + action, collapsed to a unit count (e.g. 2 new skills). */
export interface CountedResource {
  action: ChangeAction;
  kind: RepoResourceKind;
  count: number;
}

/** Resource-level summary of a changed-file set. */
export interface ResourceDelta {
  /** Counts in display order (grouped new -> changed -> removed, then RESOURCE_ORDER). */
  counts: CountedResource[];
  /** Total distinct resource units changed. */
  total: number;
}

/**
 * Collapse a changed-file set to distinct resource units, then count them by
 * (action, kind). A skill whose three files all changed counts as one changed
 * skill; a unit with mixed add+modify reads as a single change. This is the
 * shared structured core behind every SYNC / CHANGES rendering.
 */
export function resourceDelta(entries: { action: ChangeAction; file: string }[]): ResourceDelta {
  // Gather every action seen across a unit's files, then collapse to one action.
  const units = new Map<string, { kind: RepoResourceKind; actions: Set<ChangeAction> }>();
  for (const { action, file } of entries) {
    const { kind, unit } = resourceUnit(file);
    const key = `${kind} ${unit}`;
    const cur = units.get(key) ?? { kind, actions: new Set<ChangeAction>() };
    cur.actions.add(action);
    units.set(key, cur);
  }

  const counts = new Map<string, number>(); // `${action} ${kind}` -> count
  for (const { kind, actions } of units.values()) {
    let action: ChangeAction;
    if (actions.size === 1) action = [...actions][0]!;
    else if ([...actions].every((a) => a === 'new')) action = 'new';
    else if ([...actions].every((a) => a === 'removed')) action = 'removed';
    else action = 'changed'; // mixed add+modify within one unit reads as a change
    const key = `${action} ${kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const ordered: CountedResource[] = [];
  for (const action of ['new', 'changed', 'removed'] as ChangeAction[]) {
    for (const kind of RESOURCE_ORDER) {
      const n = counts.get(`${action} ${kind}`);
      if (n) ordered.push({ action, kind, count: n });
    }
  }
  return { counts: ordered, total: units.size };
}

const ACTION_COLOR: Record<ChangeAction, (s: string) => string> = {
  new: chalk.green, changed: chalk.yellow, removed: chalk.red,
};

/** One colored phrase per counted resource, e.g. `2 new skills`. */
function deltaPhrases(delta: ResourceDelta): string[] {
  return delta.counts.map(({ action, kind, count }) => {
    const [singular, plural] = RESOURCE_LABELS[kind];
    return ACTION_COLOR[action](`${count} ${action} ${count === 1 ? singular : plural}`);
  });
}

/** Join phrases with `, `, capping at `maxParts` and appending `+N more`. */
function joinPhrases(parts: string[], maxParts: number): string {
  if (parts.length > maxParts) {
    const shown = parts.slice(0, maxParts);
    shown.push(chalk.gray(`+${parts.length - maxParts} more`));
    return shown.join(', ');
  }
  return parts.join(', ');
}

/**
 * Kind-only brief for the compact (wide-terminal) layout: `(24 skills, 9 commands, +20)`
 * — the top `maxKinds` kinds by display order, with a `+N` remainder. Drops the
 * new/changed verb (the arrow already carries direction) to stay short. Returns
 * '' when there is nothing to summarize.
 */
export function deltaBrief(delta: ResourceDelta, maxKinds = 2): string {
  if (delta.total === 0) return '';
  const shown = delta.counts.slice(0, maxKinds);
  const shownUnits = shown.reduce((s, c) => s + c.count, 0);
  const rest = delta.total - shownUnits;
  const kinds = shown.map(({ kind, count }) => {
    const [singular, plural] = RESOURCE_LABELS[kind];
    return `${count} ${count === 1 ? singular : plural}`;
  });
  if (rest > 0) kinds.push(`+${rest}`);
  return chalk.gray(`(${kinds.join(', ')})`);
}

/**
 * Render a set of changed files as a resource-level summary, e.g.
 * `2 new skills, 1 changed hook`. Counts distinct resource units (a skill whose
 * three files all changed is "1 changed skill"), grouped by action then kind,
 * and colors each phrase green/yellow/red for new/changed/removed. Caps at
 * `maxParts` phrases, appending `+N more` so a big diff stays scannable.
 */
export function formatResourceDelta(
  entries: { action: ChangeAction; file: string }[],
  maxParts = 5,
): string {
  return joinPhrases(deltaPhrases(resourceDelta(entries)), maxParts);
}

/** Parse `git diff --name-status <range>` into resource-delta entries. */
async function diffResourceEntries(
  git: ReturnType<typeof simpleGit>,
  range: string,
): Promise<{ action: ChangeAction; file: string }[]> {
  let raw: string;
  try {
    raw = await git.diff(['--name-status', range]);
  } catch {
    return []; // no upstream resolvable / range invalid — caller falls back to counts
  }
  const out: { action: ChangeAction; file: string }[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const code = cols[0] ?? '';
    const file = cols[cols.length - 1] ?? ''; // renames put the new path last
    if (!file) continue;
    const c = code[0];
    const action: ChangeAction = c === 'A' ? 'new' : c === 'D' ? 'removed' : 'changed';
    out.push({ action, file });
  }
  return out;
}

/** One side of a divergence: the resource delta plus the raw commit count (fallback). */
interface RepoDivergence {
  delta: ResourceDelta;
  commits: number;
}

/**
 * Structured status for one repo. `raw` is a free-form trailer for special cases
 * (missing repo, no git remote, error) that don't fit the columns; otherwise the
 * fields feed whichever layout (table / cards) the terminal width selects.
 */
interface RepoRow {
  alias: string;
  raw?: string;
  branch?: string;
  tracking?: boolean;
  pull?: RepoDivergence; // present only when behind > 0
  push?: RepoDivergence; // present only when ahead > 0
  clean?: boolean;
  local?: ResourceDelta; // present only when the working tree is dirty
  url?: string;
  commit?: string;
}

/**
 * Read one repo's status into structured data: branch, resource-level sync (what
 * a pull/push would move), resource-level local edits, and remote URL + commit.
 * Formatting is deferred to the layout renderers so the same data can drive both
 * the wide table and the narrow cards.
 */
async function renderRepoRow(t: RepoTarget): Promise<RepoRow> {
  if (!fs.existsSync(t.dir)) {
    return { alias: t.alias, raw: `${chalk.red('missing')} ${chalk.gray(t.dir)}` };
  }
  if (!isGitRepo(t.dir)) {
    return { alias: t.alias, raw: `${chalk.gray('local (no git remote)')} ${chalk.gray(t.dir)}` };
  }

  try {
    const git = simpleGit(t.dir);
    const status = await git.status();
    // Show the local branch name; the upstream remote is already implied by URL.
    const branch = status.current || (status.tracking ? status.tracking.replace(/^origin\//, '') : '(detached)');
    const row: RepoRow = { alias: t.alias, branch, tracking: !!status.tracking };

    // SYNC: what a pull brings in / a push sends out, described by resource.
    const ahead = status.ahead ?? 0;
    const behind = status.behind ?? 0;
    if (status.tracking) {
      if (behind > 0) {
        // Three-dot isolates upstream's side via the merge-base, so a diverged
        // branch reports exactly what a pull adds (not the inverse of local commits).
        row.pull = { delta: resourceDelta(await diffResourceEntries(git, 'HEAD...@{upstream}')), commits: behind };
      }
      if (ahead > 0) {
        row.push = { delta: resourceDelta(await diffResourceEntries(git, '@{upstream}...HEAD')), commits: ahead };
      }
    }

    // CHANGES: uncommitted working-tree edits, described by resource.
    const localEntries: { action: ChangeAction; file: string }[] = [
      ...status.created.map((f) => ({ action: 'new' as const, file: f })),
      ...status.not_added.map((f) => ({ action: 'new' as const, file: f })),
      ...status.modified.map((f) => ({ action: 'changed' as const, file: f })),
      ...status.conflicted.map((f) => ({ action: 'changed' as const, file: f })),
      ...status.renamed.map((r) => ({ action: 'changed' as const, file: (r as { to: string }).to })),
      ...status.deleted.map((f) => ({ action: 'removed' as const, file: f })),
    ];
    row.clean = status.isClean();
    if (!row.clean) row.local = resourceDelta(localEntries);

    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    row.url = origin?.refs?.fetch || '';
    row.commit = (await git.log({ maxCount: 1 })).latest?.hash.slice(0, 8) || '';
    return row;
  } catch (err) {
    return { alias: t.alias, raw: `${chalk.red('error')} ${(err as Error).message}` };
  }
}

/** Terminal width at or above which `list` uses the wide table instead of cards. */
const WIDE_COLS = 120;

const commitsWord = (n: number): string => chalk.yellow(`${n} commit${n > 1 ? 's' : ''}`);

/** `owner/repo` from a git URL, for the compact card header. Falls back to the raw URL. */
export function repoSlug(url: string): string {
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1]! : url;
}

/** Full SYNC string: `24 new skills, ... to pull  ·  ... to push` (verbose table). */
function syncFull(row: RepoRow): string {
  if (!row.tracking) return chalk.gray('no upstream');
  if (!row.pull && !row.push) return chalk.green('up to date');
  const pieces: string[] = [];
  if (row.pull) {
    const detail = joinPhrases(deltaPhrases(row.pull.delta), 5) || commitsWord(row.pull.commits);
    pieces.push(`${detail} ${chalk.gray('to pull')}`);
  }
  if (row.push) {
    const detail = joinPhrases(deltaPhrases(row.push.delta), 5) || commitsWord(row.push.commits);
    pieces.push(`${detail} ${chalk.gray('to push')}`);
  }
  return pieces.join(chalk.gray('  ·  '));
}

/** Compact SYNC for the wide table: `↓53 (24 skills, 9 commands, +20)  ↑13`. */
function syncCompact(row: RepoRow): string {
  if (!row.tracking) return chalk.gray('no upstream');
  if (!row.pull && !row.push) return chalk.green('up to date');
  const pieces: string[] = [];
  if (row.pull) {
    const n = row.pull.delta.total || row.pull.commits;
    const brief = deltaBrief(row.pull.delta);
    pieces.push(`${chalk.yellow(`↓${n}`)}${brief ? ` ${brief}` : ''}`);
  }
  if (row.push) {
    const n = row.push.delta.total || row.push.commits;
    pieces.push(chalk.magenta(`↑${n}`));
  }
  return pieces.join('  ');
}

/** Full CHANGES string for the verbose table. */
function changesFull(row: RepoRow): string {
  if (row.clean) return chalk.green('clean');
  return joinPhrases(deltaPhrases(row.local!), 5);
}

/** Compact CHANGES for the wide table: `clean` or `~1 edit`. */
function changesCompact(row: RepoRow): string {
  if (row.clean) return chalk.green('clean');
  const n = row.local!.total;
  return chalk.yellow(`~${n} edit${n === 1 ? '' : 's'}`);
}

/**
 * Print the aligned table. `compact` picks short (arrow-count) SYNC/CHANGES cells
 * that keep the table bounded; verbose passes `compact: false` for full detail.
 * Only the trailing REMOTE column is allowed to run long.
 */
function renderTable(rows: RepoRow[], compact: boolean): void {
  const cells = new Map<string, [string, string, string, string]>();
  for (const r of rows) {
    if (r.raw) continue;
    const remote = r.url
      ? chalk.gray(`${r.url}${r.commit ? ` (${r.commit})` : ''}`)
      : r.commit ? chalk.gray(`(${r.commit})`) : '';
    cells.set(r.alias, [
      r.branch ?? '',
      compact ? syncCompact(r) : syncFull(r),
      compact ? changesCompact(r) : changesFull(r),
      remote,
    ]);
  }

  const headers = ['REPO', 'BRANCH', 'SYNC', 'CHANGES'];
  const tableCells = [...cells.values()];
  const aliasW = Math.max(headers[0].length, ...rows.map((r) => r.alias.length));
  const branchW = Math.max(headers[1].length, 0, ...tableCells.map((c) => visibleWidth(c[0])));
  const syncW = Math.max(headers[2].length, 0, ...tableCells.map((c) => visibleWidth(c[1])));
  const changesW = Math.max(headers[3].length, 0, ...tableCells.map((c) => visibleWidth(c[2])));

  console.log(
    `  ${chalk.gray(headers[0].padEnd(aliasW))}  ${chalk.gray(headers[1].padEnd(branchW))}  ${chalk.gray(headers[2].padEnd(syncW))}  ${chalk.gray(headers[3].padEnd(changesW))}  ${chalk.gray('REMOTE')}`,
  );
  for (const r of rows) {
    const aliasCol = chalk.cyan(r.alias.padEnd(aliasW));
    const c = cells.get(r.alias);
    if (c) {
      console.log(`  ${aliasCol}  ${padVisible(c[0], branchW)}  ${padVisible(c[1], syncW)}  ${padVisible(c[2], changesW)}  ${c[3]}`);
    } else {
      console.log(`  ${aliasCol}  ${r.raw}`);
    }
  }
}

/** Pack colored phrases into `, `-joined lines no wider than `width`. */
export function wrapPhrases(parts: string[], width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const p of parts) {
    const cand = cur ? `${cur}, ${p}` : p;
    if (cur && visibleWidth(cand) > width) {
      lines.push(cur);
      cur = p;
    } else {
      cur = cand;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Print one block per repo, width-independent. The category list wraps under an
 * indented `↓ pull` / `↑ push` / `local` label instead of running off the edge,
 * so a narrow terminal stays readable.
 */
function renderCards(rows: RepoRow[], cols: number): void {
  const LABEL = '      '; // indent for detail labels
  const detailWidth = Math.max(20, cols - LABEL.length - 9); // 9 ≈ "↓ pull   "
  let first = true;
  for (const r of rows) {
    if (!first) console.log('');
    first = false;

    if (r.raw) {
      console.log(`  ${chalk.cyan(r.alias)}  ${r.raw}`);
      continue;
    }

    const head = [r.branch, r.commit || null, r.url ? repoSlug(r.url) : null].filter(Boolean).join(chalk.gray(' · '));
    console.log(`  ${chalk.green('●')} ${chalk.cyan(r.alias)}  ${chalk.gray(head)}`);

    const detail = (label: string, div: RepoDivergence, color: (s: string) => string) => {
      const phrases = div.delta.total ? deltaPhrases(div.delta) : [commitsWord(div.commits)];
      const lines = wrapPhrases(phrases, detailWidth);
      lines.forEach((line, i) => {
        const lab = i === 0 ? color(label.padEnd(9)) : ' '.repeat(9);
        console.log(`${LABEL}${lab}${line}`);
      });
    };
    if (r.tracking === false) {
      console.log(`${LABEL}${chalk.gray('no upstream')}`);
    } else if (r.pull || r.push) {
      if (r.pull) detail('↓ pull', r.pull, chalk.yellow);
      if (r.push) detail('↑ push', r.push, chalk.magenta);
    }

    const local = r.clean ? chalk.green('clean') : wrapPhrases(deltaPhrases(r.local!), detailWidth);
    if (Array.isArray(local)) {
      local.forEach((line, i) => console.log(`${LABEL}${chalk.gray((i === 0 ? 'local' : '').padEnd(9))}${line}`));
    } else {
      console.log(`${LABEL}${chalk.gray('local'.padEnd(9))}${local}`);
    }
  }
}

/**
 * Shared action body for `agents repo list` and the hidden `agents repo status`
 * alias. Responsive: a wide terminal gets an aligned table with compact SYNC /
 * CHANGES cells; a narrow one gets one card per repo with wrapping detail;
 * `--verbose` forces the full-detail table at any width.
 */
async function listRepos(alias: string | undefined, opts: { verbose?: boolean; json?: boolean } = {}): Promise<void> {
  const targets = collectRepoTargets(alias);
  if (!targets) {
    process.exitCode = 1;
    return;
  }
  if (targets.length === 0) {
    if (opts.json) {
      console.log('[]');
      return;
    }
    console.log(chalk.gray('No repos to show.'));
    return;
  }

  const rows = await Promise.all(targets.map(renderRepoRow));

  if (opts.json) {
    // Structured dump of the same rows so agents can enumerate repos + sync state.
    // `raw` (the missing / no-git-remote human label) is the only colored field —
    // strip ANSI so the JSON stays clean; every other field is already structured.
    const clean = rows.map((r) => (r.raw !== undefined ? { ...r, raw: stripAnsi(r.raw) } : r));
    console.log(JSON.stringify(clean, null, 2));
    return;
  }
  // TTY width when interactive; fall back to $COLUMNS (honored when piped) then 80.
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;

  console.log('');
  if (opts.verbose) {
    renderTable(rows, false);
  } else if (cols >= WIDE_COLS) {
    renderTable(rows, true);
  } else {
    renderCards(rows, cols);
  }

  const userDir = getUserAgentsDir();
  if (!isGitRepo(userDir) && fs.existsSync(userDir)) {
    console.log(chalk.gray('\n  user repo has no git remote — scaffold one with: agents repo init'));
  }
  console.log('');
}

/**
 * Label for push/pull spinners and results: alias + resolved dir + tracking ref.
 * e.g. `user (~/.agents → origin/main)`.
 */
function formatRepoTarget(alias: string, dir: string, branch?: string): string {
  const ref = branch ? `origin/${branch}` : 'origin';
  return `${alias} (${displayHomePath(dir)} → ${ref})`;
}

/** Register the `agents repos` command tree (`repo` is a convenience alias). */
export function registerRepoCommands(program: Command): void {
  // addHostOption on the group so --help documents --host/--device; remote
  // routing is handled pre-parse by maybeRunOnHost (passthrough.ts).
  const repoCmd = addHostOption(
    program
      .command('repos')
      .alias('repo')
      .description('Manage extra DotAgent repos alongside ~/.agents/ (for private or team skills).'),
  );

  setHelpSections(repoCmd, {
    examples: `
      # Scaffold an editable repo (default: ~/.agents/)
      agents repos init

      # Scaffold a named repo at ~/.agents-work/
      agents repos init work

      # Register an existing repo (clones to ~/.agents-<alias>/)
      agents repos add gh:yourname/.agents-work

      # Register with a custom alias
      agents repos add git@github.com:acme/team-skills.git --as acme

      # See what's registered
      agents repos list

      # View one repo's contents (git state + resource counts); omit the name for a picker
      agents repos view system

      # Temporarily disable without deleting
      agents repos disable acme
    `,
    notes: `
      Managed extras live at ~/.agents-<alias>/ as peer dirs to ~/.agents/. User-owned
      repos can also live anywhere and be registered by path.

      Resolution: skills/commands/hooks merge into agent version homes after the user
      repo's, so ~/.agents/ wins on name collisions.
    `,
  });

  repoCmd
    .command('init [target]')
    .description('Create a user-owned repo from a template and register it as an extra')
    .option('--from <source>', 'Template repo to clone from', DEFAULT_SYSTEM_REPO)
    .option('--as <alias>', 'Alias to register under (defaults to the directory name)')
    .action(async (target: string | undefined, options: { from: string; as?: string }) => {
      let targetDir = resolveRepoPath(target);

      if (!target && fs.existsSync(targetDir)) {
        if (!isInteractiveTerminal()) {
          console.log(chalk.red(`Path already exists: ${targetDir}`));
          console.log(chalk.gray('Pass a name (e.g. `agents repo init work` -> ~/.agents-work) or a path.'));
          process.exitCode = 1;
          return;
        }
        try {
          const name = await input({
            message: 'Name for your repo:',
            default: 'work',
            validate: (raw: string) => {
              const v = raw.trim();
              if (!v) return 'Required';
              if (!ALIAS_PATTERN.test(v)) return 'Letters, digits, "_" or "-"; must start with letter/digit';
              const candidate = path.join(HOME, `.agents-${v}`);
              if (fs.existsSync(candidate)) return `~/.agents-${v} already exists`;
              return true;
            },
            theme: { prefix: chalk.gray('Will be created at $HOME/.agents-<name>/') } as any,
          });
          targetDir = path.join(HOME, `.agents-${name.trim()}`);
        } catch (err) {
          if (isPromptCancelled(err)) {
            process.exit(130);
          }
          throw err;
        }
      }

      const alias = options.as ? options.as.trim() : (path.basename(targetDir).replace(/^\.+/, '') || 'repo');
      if (!ALIAS_PATTERN.test(alias)) {
        console.log(chalk.red(`Invalid alias "${alias}".`));
        process.exitCode = 1;
        return;
      }

      const meta = readMeta();
      const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };
      if (extras[alias]) {
        console.log(chalk.red(`Alias "${alias}" is already registered.`));
        process.exitCode = 1;
        return;
      }
      if (fs.existsSync(targetDir)) {
        console.log(chalk.red(`Path already exists: ${targetDir}`));
        process.exitCode = 1;
        return;
      }

      const parsed = parseSource(options.from);
      const spinner = ora(`Cloning ${options.from} into ${targetDir}...`).start();
      try {
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        await simpleGit().clone(parsed.url, targetDir);
        await simpleGit(targetDir).removeRemote('origin');
        const log = await simpleGit(targetDir).log({ maxCount: 1 });
        const commit = log.latest?.hash.slice(0, 8) || 'unknown';
        extras[alias] = { url: targetDir, path: targetDir, enabled: true };
        updateMeta({ extraRepos: extras });
        syncExtraAliasAcrossVersions(alias, true);
        spinner.succeed(`Created ${targetDir} (${commit})`);
        console.log(chalk.gray(`\nRegistered as "${alias}". Edit files there, then add your own git remote when ready.`));
      } catch (err) {
        spinner.fail(`Init failed: ${(err as Error).message}`);
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
        process.exitCode = 1;
      }
    });

  repoCmd
    .command('add <source>')
    .description('Register an existing local repo or clone a remote repo into ~/.agents-<alias>/')
    .option('--as <alias>', 'Override the auto-derived alias (letters, digits, _ or -)')
    .action(async (source: string, options: { as?: string }) => {
      const meta = readMeta();
      const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };

      const alias = options.as ? options.as.trim() : deriveAlias(source);
      if (!ALIAS_PATTERN.test(alias)) {
        console.log(chalk.red(`Invalid alias "${alias}".`));
        console.log(chalk.gray('Alias must start with a letter/digit and contain only letters, digits, "_" or "-".'));
        process.exitCode = 1;
        return;
      }
      if (extras[alias]) {
        console.log(chalk.red(`Alias "${alias}" is already registered.`));
        console.log(chalk.gray(`Existing: ${extras[alias].url}`));
        console.log(chalk.gray(`Use --as <other-alias>, or: agents repo remove ${alias}`));
        process.exitCode = 1;
        return;
      }

      let parsed;
      try {
        parsed = parseSource(source);
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exitCode = 1;
        return;
      }

      if (parsed.type === 'local') {
        extras[alias] = { url: parsed.url, path: parsed.url, enabled: true };
        updateMeta({ extraRepos: extras });
        syncExtraAliasAcrossVersions(alias, true);
        syncMarketplacesForDefaults();
        console.log(chalk.green(`Registered local repo "${alias}" -> ${parsed.url}`));
        return;
      }

      ensureAgentsDir();
      const targetDir = getExtraRepoDir(alias);
      if (fs.existsSync(targetDir)) {
        console.log(chalk.red(`Directory already exists: ${targetDir}`));
        console.log(chalk.gray('Remove it manually or pick a different alias with --as.'));
        process.exitCode = 1;
        return;
      }

      const spinner = ora(`Cloning ${source}...`).start();
      try {
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        await simpleGit().clone(parsed.url, targetDir);
        if (parsed.ref) {
          await simpleGit(targetDir).checkout(parsed.ref);
        }
        const log = await simpleGit(targetDir).log({ maxCount: 1 });
        const commit = log.latest?.hash.slice(0, 8) || 'unknown';
        spinner.succeed(`Cloned ${source} -> ${targetDir} (${commit})`);
      } catch (err) {
        spinner.fail(`Clone failed: ${(err as Error).message}`);
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
        process.exitCode = 1;
        return;
      }

      extras[alias] = { url: parsed.url, path: targetDir, enabled: true };
      updateMeta({ extraRepos: extras });
      syncExtraAliasAcrossVersions(alias, true);
      syncMarketplacesForDefaults();

      console.log(chalk.gray(`\nRegistered as "${alias}". Skills and commands from this repo will be`));
      console.log(chalk.gray(`picked up automatically the next time you launch any agent.`));
    });

  repoCmd
    .command('list [alias]')
    .alias('ls')
    .description('Show all repos with resource-level sync (skills/commands/plugins to pull or push) and local changes.')
    .option('-v, --verbose', 'Full per-resource detail in a table, regardless of terminal width')
    .option('--json', 'machine-readable JSON output')
    .action(async (alias: string | undefined, options: { verbose?: boolean; json?: boolean }) => {
      await listRepos(alias, options);
    });

  repoCmd
    .command('view [name]')
    .description("Show one repo's contents: git state and per-kind resource counts. Omit the name for an interactive picker.")
    .option('--brief', 'header + git only; skip resource counts')
    .option('--json', 'machine-readable JSON output')
    .action(async (name: string | undefined, options: InspectOptions) => {
      if (name) {
        const repo = resolveRepoTarget(name);
        if (!repo) {
          console.log(chalk.red(`Unknown repo "${name}". Use "system", "user", "project", or a registered extra alias.`));
          process.exitCode = 1;
          return;
        }
        await inspectRepo(repo, options);
        return;
      }

      const targets = collectRepoTargets(undefined) || [];
      if (!isInteractiveTerminal()) {
        console.log(chalk.red('No repo name given and not an interactive terminal.'));
        console.log(chalk.gray('Pass a name (e.g. `agents repos view system`) or run in a TTY for the picker.'));
        process.exitCode = 1;
        return;
      }

      const picked = await itemPicker<RepoTarget>({
        message: 'Select a repo to view',
        items: targets,
        filter: (q) => targets.filter((t) => t.alias.toLowerCase().includes(q.toLowerCase())),
        labelFor: (t) => `${chalk.cyan(t.alias.padEnd(10))} ${chalk.gray(t.dir)}`,
      });
      if (!picked) return;

      const repo: InspectRepoTarget = { label: picked.item.alias, root: picked.item.dir };
      await inspectRepo(repo, options);
    });

  repoCmd
    .command('remove <alias>')
    .alias('rm')
    .description('Unregister an extra repo. Managed clones are deleted; external paths are kept.')
    .action(async (alias: string) => {
      const meta = readMeta();
      const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };
      if (!extras[alias]) {
        console.log(chalk.red(`No extra repo registered as "${alias}".`));
        process.exitCode = 1;
        return;
      }

      const dir = resolveExtraRepoDir(alias, extras[alias]);
      // Managed clones live at the default ~/.agents-<alias>/ — those we own
      // and should delete on remove. Anything else is user-owned, leave alone.
      const isManagedClone = path.resolve(dir) === path.resolve(getExtraRepoDir(alias));
      try {
        if (isManagedClone && fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        console.log(chalk.yellow(`Warning: could not delete ${dir}: ${(err as Error).message}`));
      }

      delete extras[alias];
      updateMeta({ extraRepos: extras });
      syncExtraAliasAcrossVersions(alias, false);
      syncMarketplacesForDefaults();
      console.log(chalk.green(`Removed "${alias}"`));
    });

  repoCmd
    .command('enable <alias>')
    .description('Re-enable a previously disabled extra repo')
    .action(async (alias: string) => {
      await toggle(alias, true);
    });

  repoCmd
    .command('disable <alias>')
    .description('Stop merging this repo during sync without deleting the clone')
    .action(async (alias: string) => {
      await toggle(alias, false);
    });

  repoCmd
    .command('pull [alias] [url]')
    .description('Pull updates. Aliases: "system" (~/.agents/.system/), "user" (~/.agents/), or any registered extra. No arg pulls all. Pass a git URL to git-back a not-yet-cloned user repo: "agents repo pull user <url>".')
    .action(async (alias: string | undefined, url: string | undefined) => {
      const targets = collectRepoTargets(alias);
      if (!targets) {
        process.exitCode = 1;
        return;
      }
      if (targets.length === 0) {
        console.log(chalk.gray('No repos to pull.'));
        return;
      }
      for (const t of targets) {
        if (!fs.existsSync(t.dir) || !isGitRepo(t.dir)) {
          // A plain (never-cloned) user repo — setup makes ~/.agents a bare dir and
          // never git-clones it (state.ts ensureAgentsDir), so a fresh/Windows box
          // silently falls out of config sync. If a URL was passed, git-back it in
          // place (keeping local files, backing up any that differ); else guide the
          // user. Only the USER repo gets this — system is cloned by setup, extras
          // by `repo add`.
          if (t.alias === 'user' && url) {
            const spinner = ora(`Git-backing ${t.dir} from ${url}...`).start();
            const res = await adoptRepo(url, t.dir);
            if (!res.success) {
              spinner.fail(`user: could not git-back — ${res.error}`);
              process.exitCode = 1;
              continue;
            }
            spinner.succeed(`user: git-backed -> ${res.commit}`);
            if (res.backedUp.length > 0) {
              console.log(chalk.yellow(`  backed up ${res.backedUp.length} locally-modified file(s) to ${res.backupDir}`));
              console.log(chalk.gray(`  (${res.backedUp.slice(0, 5).join(', ')}${res.backedUp.length > 5 ? ', …' : ''})`));
            }
            // Now a git repo — fall through to the normal pull below.
          } else {
            console.log(chalk.yellow(`  ${t.alias}: not a git repo, skipping`));
            if (t.alias === 'user') {
              console.log(chalk.gray('  git-back it from your config remote: agents repo pull user <git-url>'));
            }
            continue;
          }
        }
        if (t.alias === 'system') {
          // Skip system repo unless explicitly requested
          if (alias !== 'system') continue;

          // User explicitly asked for system repo — show status and offer to pull
          try {
            const git = simpleGit(t.dir);
            await git.fetch();
            const status = await git.status();
            const behind = status.behind ?? 0;
            if (behind === 0) {
              console.log(chalk.green('Up to date'));
            } else {
              // Count changed resources by type
              const diff = await git.diff(['--name-only', 'HEAD..@{upstream}']);
              const files = diff.split('\n').filter(Boolean);
              const counts: Record<string, number> = {};
              for (const f of files) {
                if (f.startsWith('skills/')) counts['skills'] = (counts['skills'] || 0) + 1;
                else if (f.startsWith('commands/')) counts['commands'] = (counts['commands'] || 0) + 1;
                else if (f.startsWith('hooks/')) counts['hooks'] = (counts['hooks'] || 0) + 1;
                else if (f.startsWith('rules/')) counts['rules'] = (counts['rules'] || 0) + 1;
                else counts['other'] = (counts['other'] || 0) + 1;
              }
              const parts: string[] = [];
              if (counts['skills']) parts.push(`${counts['skills']} skill${counts['skills'] > 1 ? 's' : ''}`);
              if (counts['commands']) parts.push(`${counts['commands']} command${counts['commands'] > 1 ? 's' : ''}`);
              if (counts['hooks']) parts.push(`${counts['hooks']} hook${counts['hooks'] > 1 ? 's' : ''}`);
              if (counts['rules']) parts.push(`${counts['rules']} rule${counts['rules'] > 1 ? 's' : ''}`);
              if (counts['other']) parts.push(`${counts['other']} other`);
              const summary = parts.length > 0 ? parts.join(', ') : `${behind} update${behind > 1 ? 's' : ''}`;
              console.log(chalk.yellow(`${summary} available`));

              if (isInteractiveTerminal()) {
                const doPull = await confirm({ message: 'Pull now?', default: true });
                if (doPull) {
                  const result = await pullRepo(t.dir);
                  if (result.success) {
                    console.log(chalk.green('Updated'));
                  } else {
                    console.log(chalk.red(result.error || 'Pull failed'));
                  }
                }
              }
            }
          } catch (err) {
            console.log(chalk.red((err as Error).message));
          }
          continue;
        }
        const spinner = ora(`Pulling ${formatRepoTarget(t.alias, t.dir)}...`).start();
        const result = await pullRepo(t.dir);
        if (result.success) {
          spinner.succeed(`${formatRepoTarget(t.alias, t.dir, result.branch)}: ${result.commit}`);
        } else {
          spinner.fail(`${formatRepoTarget(t.alias, t.dir)}: ${result.error}`);
        }
      }
    });

  repoCmd
    .command('push [alias]')
    .description('Commit and push the user repo or a user-owned extra. Refuses to push the system repo.')
    .option('-m, --message <msg>', 'Commit message', 'Update via agents repos push')
    .action(async (alias: string | undefined, options: { message: string }) => {
      const targets = collectRepoTargets(alias);
      if (!targets) {
        process.exitCode = 1;
        return;
      }
      // Drop system-repo targets — read-only by design.
      const pushable: RepoTarget[] = [];
      for (const t of targets) {
        if (t.alias === 'system') {
          console.log(chalk.yellow('Skipping system repo (read-only — managed via the agents-cli upstream).'));
          continue;
        }
        if (!fs.existsSync(t.dir) || !isGitRepo(t.dir)) {
          console.log(chalk.yellow(`  ${t.alias}: not a git repo, skipping`));
          continue;
        }
        // Defense in depth: refuse if origin happens to be the system upstream.
        if (await isSystemRepoOrigin(t.dir)) {
          console.log(chalk.red(`  ${t.alias}: origin tracks the system repo — refusing to push.`));
          continue;
        }
        pushable.push(t);
      }
      if (pushable.length === 0) {
        console.log(chalk.gray('No pushable repos.'));
        return;
      }
      for (const t of pushable) {
        const spinner = ora(`Pushing ${formatRepoTarget(t.alias, t.dir)}...`).start();
        const result = await commitAndPush(t.dir, options.message);
        if (result.success) {
          spinner.succeed(
            `${formatRepoTarget(t.alias, t.dir, result.branch)}: ${result.detail ?? 'pushed'}`,
          );
        } else {
          spinner.fail(`${formatRepoTarget(t.alias, t.dir)}: ${result.error}`);
        }
      }
    });

  repoCmd
    .command('refresh [agent]')
    .description('Re-materialize resources into installed agent version homes. No git, no network.')
    .option('-y, --yes', 'Auto-sync everything without prompting')
    .option('--skip-clis', 'Skip CLI version install/upgrade from agents.yaml')
    .action(async (arg: string | undefined, options: { yes?: boolean; skipClis?: boolean }) => {
      let agentFilter: AgentId | undefined;
      if (arg) {
        if (!isAgentName(arg)) {
          console.log(chalk.red(`Unknown agent "${arg}".`));
          console.log(chalk.gray(`Available: ${ALL_AGENT_IDS.join(', ')}`));
          process.exitCode = 1;
          return;
        }
        agentFilter = resolveAgentName(arg)!;
      }
      try {
        await refresh({
          agentFilter,
          skipPrompts: options.yes,
          skipClis: options.skipClis,
        });
        console.log(chalk.green('\nRefresh complete'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  repoCmd
    .command('status [alias]', { hidden: true })
    .description('Alias of `list` (kept for muscle memory).')
    .option('-v, --verbose', 'Full per-resource detail in a table, regardless of terminal width')
    .option('--json', 'machine-readable JSON output')
    .action(async (alias: string | undefined, options: { verbose?: boolean; json?: boolean }) => {
      await listRepos(alias, options);
    });
}

interface RepoTarget {
  alias: string;
  dir: string;
}

/**
 * Resolve an alias (or undefined for "all") to a list of repo targets.
 * Returns null when a named alias isn't found (callers should set exit code).
 */
function collectRepoTargets(alias: string | undefined): RepoTarget[] | null {
  const meta = readMeta();
  const extras = meta.extraRepos || {};

  const all: RepoTarget[] = [
    { alias: 'system', dir: getSystemAgentsDir() },
    { alias: 'user', dir: getUserAgentsDir() },
    ...Object.keys(extras)
      .filter((a) => extras[a].enabled)
      .map((a) => ({ alias: a, dir: resolveExtraRepoDir(a, extras[a]) })),
  ];

  if (!alias) return all;
  const found = all.find((t) => t.alias === alias) || (extras[alias]
    ? { alias, dir: resolveExtraRepoDir(alias, extras[alias]) }
    : null);
  if (!found) {
    console.log(chalk.red(`Unknown repo "${alias}". Use "system", "user", or a registered extra alias.`));
    return null;
  }
  return [found];
}

/**
 * Keep already-installed versions' selectors in sync with an extra-repo change:
 * add `<alias>:*` when the repo is registered/enabled, strip it when removed.
 * Newly-installed versions inherit it from `defaultPatterns()` at scaffold time,
 * so without this a repo added after install is invisible to existing versions.
 */
function syncExtraAliasAcrossVersions(alias: string, add: boolean): void {
  const n = applyExtraAliasToVersions(alias, add);
  if (n > 0) {
    const verb = add ? 'Added to' : 'Removed from';
    console.log(chalk.gray(`${verb} ${n} existing version selector${n === 1 ? '' : 's'}.`));
  }
}

async function toggle(alias: string, enabled: boolean): Promise<void> {
  const meta = readMeta();
  const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };
  if (!extras[alias]) {
    console.log(chalk.red(`No extra repo registered as "${alias}".`));
    process.exitCode = 1;
    return;
  }
  if (extras[alias].enabled === enabled) {
    console.log(chalk.gray(`"${alias}" is already ${enabled ? 'enabled' : 'disabled'}.`));
    return;
  }
  extras[alias] = { ...extras[alias], enabled };
  updateMeta({ extraRepos: extras });
  // Re-enabling backfills the alias into existing versions; disabling leaves the
  // selectors (resolution skips disabled extras) so a later enable is a no-op.
  if (enabled) syncExtraAliasAcrossVersions(alias, true);
  syncMarketplacesForDefaults();
  console.log(chalk.green(`${enabled ? 'Enabled' : 'Disabled'} "${alias}"`));
}
