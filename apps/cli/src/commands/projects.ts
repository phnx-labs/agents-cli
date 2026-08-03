/**
 * `agents projects` — named, multi-repo projects and the progress
 * rollup. Definitions live in `~/.agents/projects/<name>.yaml` (see
 * `lib/projects.ts`); this registers the command tree over them. Beta-gated on
 * `isBetaEnabled('projects')`, mirroring `agents factory`.
 *
 * The headline is `status`: instead of the vague per-agent activity line, it
 * rolls every session up by project (matched on cwd) into one card — agents by
 * lifecycle state, plan completion, open PRs, and tickets in flight.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

import { betaEnableHint, isBetaEnabled } from '../lib/beta.js';
import { setHelpSections } from '../lib/help.js';
import { getMainRepoRoot } from '../lib/git.js';
import { parseOwnerRepoFromRemote } from '../lib/registry.js';
import { truncate } from '../lib/format.js';
import { expandLocalHome, getProjectRoot, toHomeRelative } from '../lib/project-root.js';
import { machineId } from '../lib/machine-id.js';
import { getActiveSessions } from '../lib/session/active.js';
import { gatherRemoteActive } from '../lib/session/remote-active.js';
import { gatherRemoteAgentsJson } from '../lib/remote-agents-json.js';
import { factoryProjectsPath } from '../lib/auto-dispatch.js';
import {
  formatFleetWorkspaces,
  parseRemoteProbe,
  probeProjectWorkspaces,
  workspaceTargetsForDef,
  type HostWorkspaceStatus,
} from '../lib/project-probe.js';
import {
  listProjectDefs,
  loadProjectDef,
  writeProjectDef,
  removeProjectDef,
  projectDefPath,
  isSafeProjectName,
  type ProjectDef,
  type ProjectContext,
} from '../lib/projects.js';
import {
  rollupSessionsByProject,
  planPct,
  enrichProjectSignals,
  formatProjectMembers,
  type ProjectSessionRollup,
  type ProjectRemoteSignals,
} from '../lib/project-status.js';
import { fetchLinearProjectCounts, type LinearMilestone, type LinearProjectCounts } from '../lib/linear-project-counts.js';
import { listLinearProjects, pickLinearProject, type LinearPick, type LinearProjectLite } from '../lib/linear-projects.js';
import {
  buildFactoryImportCandidates,
  buildLinearImportCandidates,
  validateImportOpts,
  type ImportOptions,
  type ImportPlan,
  type RawImportFlags,
} from '../lib/project-import.js';

/** Recursion guard: a peer answering a probe fan-out never re-fans-out itself. */
export const PROJECTS_NO_FANOUT_ENV = 'AGENTS_PROJECTS_LOCAL';

/** Max peers named in the skipped note before the rest collapse to `+N`. */
const SKIPPED_NAME_LIMIT = 4;

/**
 * One compact trailing note for peers that didn't answer the `--fleet`
 * fan-out — unreachable, running an agents-cli too old to carry `projects
 * probe`, or too slow to finish inside the 12s SSH budget. Mirrors
 * `formatUnreachableNote` (activity) with the probe-specific reasons; empty
 * string when everything answered.
 */
export function formatFleetSkippedNote(skipped: string[]): string {
  if (skipped.length === 0) return '';
  const named = skipped.slice(0, SKIPPED_NAME_LIMIT);
  const rest = skipped.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', ');
  const noun = skipped.length === 1 ? 'device' : 'devices';
  return chalk.gray(`  · ${skipped.length} ${noun} didn't answer (unreachable, older agents-cli, or timed out): ${list}\n`);
}

/** `path:purpose` → a context anchor. Purpose may contain colons. */
function parseContextFlag(raw: string): ProjectContext {
  const i = raw.indexOf(':');
  if (i === -1) return { path: raw.trim(), purpose: '' };
  return { path: raw.slice(0, i).trim(), purpose: raw.slice(i + 1).trim() };
}

/** Best-effort `owner/repo` from a repo's origin remote. */
function originSlug(cwd: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
    return parseOwnerRepoFromRemote(url) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the Factory registry off disk and plan its import. Every read failure is
 * fatal and named — an unreadable or malformed registry must not read as "0
 * projects to import".
 */
function runFactoryImport(existing: Map<string, ProjectDef>, opts: ImportOptions): ImportPlan {
  const src = factoryProjectsPath();
  let rawText: string;
  try {
    rawText = fs.readFileSync(src, 'utf8');
  } catch {
    console.error(chalk.red(`No Factory registry at ${src}`));
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.error(chalk.red(`Factory registry at ${src} is not valid JSON`));
    process.exit(1);
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { projects?: unknown[] })?.projects)
      ? (parsed as { projects: unknown[] }).projects
      : [];
  return buildFactoryImportCandidates(rows, existing, opts);
}

/**
 * List the workspace's Linear projects and plan their import, binding each to a
 * local checkout under the configured projects root when the names match
 * exactly. A missing / logged-out `linear` CLI is loud (this is an explicit user
 * command), and nothing is written before the whole plan is built.
 */
function runLinearImport(existing: Map<string, ProjectDef>, opts: ImportOptions): ImportPlan {
  let list: LinearProjectLite[];
  try {
    list = listLinearProjects();
  } catch (e) {
    console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
  // No projects root configured (or unreadable) → no local matching; every def
  // still imports, carrying its Linear link and nothing it can't prove.
  const rootAbs = getProjectRoot() ? expandLocalHome(getProjectRoot()!) : undefined;
  let localDirs: string[] = [];
  if (rootAbs) {
    try {
      localDirs = fs
        .readdirSync(rootAbs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      localDirs = [];
    }
  }
  return buildLinearImportCandidates(list, existing, {
    localDirs,
    resolveRoot: (dir) => (rootAbs ? toHomeRelative(path.join(rootAbs, dir)) : undefined),
    resolveOrigin: (dir) => (rootAbs ? originSlug(path.join(rootAbs, dir)) : undefined),
  }, opts);
}

/** One `projects list` row, pre-render. */
export interface ProjectListRow {
  name: string;
  path: string;
  repo: string;
}

/** Longest path a `list` row shows before it truncates. */
const LIST_PATH_MAX = 48;

/**
 * Column widths for `projects list`, sized to the rows actually being printed.
 * Fixed padding was the bug: home-relative roots run past 50 characters, so a
 * hardcoded 32 pushed the repo column off its gridline on every long path.
 * Paths longer than {@link LIST_PATH_MAX} truncate rather than widen the table.
 */
export function computeProjectListWidths(rows: ProjectListRow[]): { name: number; path: number; repo: number } {
  const widest = (pick: (r: ProjectListRow) => string, cap: number) =>
    Math.min(cap, rows.reduce((w, r) => Math.max(w, pick(r).length), 0));
  return {
    name: widest((r) => r.name, 64),
    path: widest((r) => r.path, LIST_PATH_MAX),
    repo: widest((r) => r.repo, 64),
  };
}

/**
 * A milestone's target date as a person would say it — "due tomorrow",
 * "overdue by 3 days", "due Aug 21" — never a raw `2026-08-21` or a duration in
 * hours. Linear stores a calendar date with no timezone, so both sides are
 * compared at LOCAL midnight; parsing `YYYY-MM-DD` with `new Date(str)` would
 * read it as UTC and shift the answer by a day for anyone west of Greenwich.
 */
export function formatMilestoneDue(targetDate: string, nowMs: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDate.trim());
  if (!m) return undefined;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(due.getTime())) return undefined;
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days === -1) return 'overdue by a day';
  if (days < 0) return `overdue by ${-days} days`;
  if (days <= 14) return `due in ${days} days`;
  const sameYear = due.getFullYear() === today.getFullYear();
  const label = due.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `due ${label}`;
}

/** The `next` card line: what this project is due to hit, and how far along it is. */
export function formatNextMilestone(ms: LinearMilestone, nowMs: number): string {
  const parts = [chalk.bold(ms.name)];
  // A milestone with nothing filed under it yet has no progress to report —
  // `0/0` is noise, not information.
  if (ms.total > 0) parts.push(`${ms.done}/${ms.total}`);
  const due = ms.targetDate ? formatMilestoneDue(ms.targetDate, nowMs) : undefined;
  if (due) parts.push(due.startsWith('overdue') ? chalk.yellow(due) : chalk.dim(due));
  return parts.join(chalk.dim('  ·  '));
}

function statusBar(r: ProjectSessionRollup): string {
  const parts: string[] = [];
  const push = (n: number | undefined, label: string, color: (s: string) => string) => {
    if (n && n > 0) parts.push(color(`${n} ${label}`));
  };
  push(r.byStatus.running, 'running', chalk.green);
  push(r.byStatus.idle, 'idle', chalk.gray);
  push(r.byStatus.input_required, 'need-input', chalk.yellow);
  push(r.byStatus.queued, 'queued', chalk.gray);
  const shown =
    (r.byStatus.running ?? 0) + (r.byStatus.idle ?? 0) + (r.byStatus.input_required ?? 0) + (r.byStatus.queued ?? 0);
  // Sessions in a non-live state (orphaned/crashed/unknown) count toward the
  // headline — render the remainder so the bar never sums to less than it.
  if (r.agents > shown) parts.push(chalk.gray(`+${r.agents - shown} other`));
  return parts.join(' · ') || chalk.gray('no live agents');
}

function renderCard(
  def: ProjectDef,
  r: ProjectSessionRollup | undefined,
  remote: ProjectRemoteSignals | undefined,
  fleet?: HostWorkspaceStatus[],
  linear?: LinearProjectCounts,
  nowMs: number = Date.now(),
): void {
  const agents = r?.agents ?? 0;
  const pct = r ? planPct(r.plan) : undefined;
  const planStr = pct === undefined ? '' : `  ·  ${chalk.cyan(`${pct}% plan`)}`;
  console.log(`${chalk.bold(def.name)}  ${chalk.dim('·')}  ${chalk.bold(`${agents} agents`)}${planStr}`);
  if (def.description) console.log(`  ${chalk.dim(def.description)}`);
  console.log(`  ${chalk.dim('live')}     ${r ? statusBar(r) : chalk.gray('no live agents')}`);
  if (r && r.members.length) console.log(`  ${chalk.dim('agents')}   ${formatProjectMembers(r.members)}`);
  const ships: string[] = [];
  if (remote?.mergedPrs) ships.push(chalk.green(`${remote.mergedPrs} merged (${remote.windowDays}d)`));
  if (r?.openPrs.length) ships.push(`${r.openPrs.length} open PR${r.openPrs.length === 1 ? '' : 's'}`);
  if (r?.worktrees) ships.push(`${r.worktrees} worktree${r.worktrees === 1 ? '' : 's'}`);
  if (remote?.latestRelease) ships.push(remote.latestRelease.tag);
  if (ships.length) console.log(`  ${chalk.dim('ships')}    ${ships.join(' · ')}`);
  if (linear) {
    console.log(`  ${chalk.dim('linear')}   ${linear.done}/${linear.total}${linear.truncated ? '+' : ''} done · ${linear.inProgress} in progress`);
  }
  if (linear?.nextMilestone) {
    console.log(`  ${chalk.dim('next')}     ${formatNextMilestone(linear.nextMilestone, nowMs)}`);
  }
  if (r && r.tickets.length) {
    console.log(`  ${chalk.dim('tickets')}  ${r.tickets.slice(0, 8).join(' · ')}${r.tickets.length > 8 ? ' …' : ''}`);
  }
  if (fleet) {
    const lines = formatFleetWorkspaces(fleet);
    if (lines.length === 0) {
      console.log(`  ${chalk.dim('fleet')}    ${chalk.gray('no workspace paths (set root or repos[].path)')}`);
    }
    lines.forEach((line, i) => {
      console.log(`  ${chalk.dim((i === 0 ? 'fleet' : '').padEnd(5))}    ${line}`);
    });
  }
  if (remote?.artifacts) {
    const last = remote.lastArtifact ? `  ${chalk.dim(`· last: ${remote.lastArtifact}`)}` : '';
    console.log(`  ${chalk.dim('proof')}    ${remote.artifacts} artifact${remote.artifacts === 1 ? '' : 's'} (${remote.windowDays}d)${last}`);
  }
  const repos = [def.repo, ...(def.repos ?? []).map((x) => x.slug)].filter(Boolean) as string[];
  if (repos.length) console.log(`  ${chalk.dim('repos')}    ${[...new Set(repos)].join(' · ')}`);
  if (def.contexts?.length) {
    console.log(`  ${chalk.dim('context')}  ${def.contexts.map((c) => c.path).join(' · ')}`);
  }
  if (def.integrations?.length) {
    console.log(`  ${chalk.dim('links')}    ${def.integrations.map((i) => i.label ?? i.kind).join(' · ')}`);
  }
  console.log('');
}

export function registerProjectsCommands(program: Command): void {
  const enabled = isBetaEnabled('projects');
  const projects = program
    .command('projects', { hidden: !enabled })
    .description('Named multi-repo projects with a progress rollup.');

  setHelpSections(projects, {
    examples: `
      agents projects import --from-linear  # the projects you actually track
      agents projects add rush --repo phnx-labs/rush --path apps/web
      agents projects list
      agents projects status              # progress card for every project
      agents projects status rush --json  # one project, machine-readable
      agents projects status --fleet      # + per-device workspace drift over SSH
      agents projects link rush --linear  # bind the Linear project (auto-suggest)
      agents run --project rush           # land an agent in the project
    `,
    notes: `
      Definitions are hand-editable YAML in ~/.agents/projects/ and sync across
      machines with 'agents push/pull'. Enable with: agents beta enable projects.

      'import --from-factory' reads Factory's auto-detected registry, which
      guesses from checkouts on disk — it imports only 'high' confidence rows by
      default. Widen with --min-confidence medium or --all, and drop a bad guess
      with 'agents projects rm <name>'.
    `,
  });

  projects.hook('preAction', (_thisCommand, actionCommand) => {
    if (enabled) return;
    // `probe` is the peer half of `status --fleet`: it must answer whenever the
    // binary carries it, even where the beta flag is off — a gated peer would
    // look unreachable to every fleet member on a newer CLI.
    if (actionCommand.name() === 'probe') return;
    console.error(chalk.red('agents projects is in beta.'));
    console.error(chalk.gray(betaEnableHint('projects')));
    process.exit(1);
  });

  // ---- list ----
  projects
    .command('list')
    .description('List defined projects with their root, repo, and live agent count.')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const defs = listProjectDefs();
      if (opts.json) {
        const roll = rollupSessionsByProject(defs, await getActiveSessions());
        console.log(
          JSON.stringify(
            defs.map((d) => ({ ...d, agents: roll.get(d.name)?.agents ?? 0 })),
            null,
            2,
          ),
        );
        return;
      }
      if (!defs.length) {
        console.log(chalk.gray('No projects defined. Add one: agents projects add <name>'));
        return;
      }
      const roll = rollupSessionsByProject(defs, await getActiveSessions());
      const rows: ProjectListRow[] = defs.map((d) => ({
        name: d.name,
        path: truncate(d.root ?? d.defaultPath ?? '', LIST_PATH_MAX),
        repo: d.repo ?? d.repos?.[0]?.slug ?? '',
      }));
      const w = computeProjectListWidths(rows);
      for (const [i, d] of defs.entries()) {
        const agents = roll.get(d.name)?.agents ?? 0;
        const row = rows[i];
        console.log(
          `  ${chalk.bold(row.name.padEnd(w.name))} ${chalk.dim(row.path.padEnd(w.path))} ${chalk.cyan(row.repo.padEnd(w.repo))} ${agents} agents`,
        );
      }
    });

  // ---- add ----
  projects
    .command('add <name>')
    .description('Define a project. Infers root and repo from the current git repo when not given.')
    .option('--root <path>', 'Repo / monorepo root (defaults to the current git repo root)')
    .option('--path <subdir>', 'Default cwd for agents (a monorepo subdir)')
    .option('--repo <owner/repo>', 'Primary GitHub slug (defaults to the origin remote)')
    .option('--context <path:purpose...>', 'A described starting point; repeatable')
    .option('--linear <url-or-id>', 'Linear project URL or id')
    .option('--force', 'Overwrite an existing definition')
    .action(
      async (
        name: string,
        opts: { root?: string; path?: string; repo?: string; context?: string[]; linear?: string; force?: boolean },
      ) => {
        if (!isSafeProjectName(name)) {
          console.error(chalk.red(`Invalid project name: "${name}" (letters, digits, ., _, - only)`));
          process.exit(1);
        }
        if (loadProjectDef(name) && !opts.force) {
          console.error(chalk.red(`Project "${name}" already exists. Use --force to overwrite, or 'agents projects edit ${name}'.`));
          process.exit(1);
        }
        const cwd = process.cwd();
        let root = opts.root;
        if (!root) {
          try {
            root = toHomeRelative(await getMainRepoRoot(cwd));
          } catch {
            console.error(chalk.red('Not inside a git repo — pass --root <path> explicitly.'));
            process.exit(1);
          }
        }
        const repo = opts.repo ?? originSlug(cwd);
        const def: ProjectDef = { name, root };
        if (opts.path) def.defaultPath = `${root!.replace(/\/$/, '')}/${opts.path.replace(/^\//, '')}`;
        if (repo) def.repo = repo;
        if (opts.context?.length) def.contexts = opts.context.map(parseContextFlag);
        if (opts.linear) {
          def.linear = /^https?:/.test(opts.linear) ? { url: opts.linear } : { projectId: opts.linear };
        }
        const target = writeProjectDef(def);
        console.log(chalk.green(`Defined project "${name}"`));
        console.log(chalk.gray(`  ${target}`));
        console.log(chalk.gray(`  root ${def.root}${def.repo ? `  ·  repo ${def.repo}` : ''}`));
      },
    );

  // ---- show ----
  projects
    .command('show <name>')
    .description('Show a project definition, resolved paths, repos, contexts, and links.')
    .option('--json', 'Machine-readable output')
    .action((name: string, opts: { json?: boolean }) => {
      const def = loadProjectDef(name);
      if (!def) {
        console.error(chalk.red(`No project named "${name}". List them: agents projects list`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(def, null, 2));
        return;
      }
      console.log(chalk.bold(def.name) + (def.description ? chalk.dim(`  — ${def.description}`) : ''));
      if (def.root) console.log(`  root         ${def.root}`);
      if (def.defaultPath) console.log(`  defaultPath  ${def.defaultPath}`);
      const repos = [def.repo, ...(def.repos ?? []).map((r) => (r.subpath ? `${r.slug} (${r.subpath})` : r.slug))].filter(Boolean);
      if (repos.length) console.log(`  repos        ${repos.join(', ')}`);
      for (const c of def.contexts ?? []) console.log(`  context      ${chalk.cyan(c.path)} — ${c.purpose}`);
      for (const i of def.integrations ?? []) console.log(`  ${i.kind.padEnd(12)} ${i.url}${i.label ? chalk.dim(`  (${i.label})`) : ''}`);
      if (def.linear?.url || def.linear?.projectId) console.log(`  linear       ${def.linear.url ?? def.linear.projectId}`);
      for (const d of def.docs ?? []) console.log(`  doc          ${d}`);
      console.log(chalk.gray(`  ${projectDefPath(name)}`));
    });

  // ---- edit ----
  projects
    .command('edit <name>')
    .description('Open the project YAML in $EDITOR (it is hand-editable regardless).')
    .action((name: string) => {
      const target = projectDefPath(name);
      if (!fs.existsSync(target)) {
        console.error(chalk.red(`No project named "${name}". Create it: agents projects add ${name}`));
        process.exit(1);
      }
      const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
      // $EDITOR commonly carries args ("code --wait") — split like monitors/routines do.
      const parts = editor.split(/\s+/).filter(Boolean);
      const res = spawnSync(parts[0], [...parts.slice(1), target], { stdio: 'inherit' });
      process.exit(res.status ?? 0);
    });

  // ---- status ----
  projects
    .command('status [name]')
    .description('Progress rollup: agents, plan %, merged/open PRs, tickets, and artifacts per project.')
    .option('--json', 'Machine-readable output')
    .option('--window <days>', 'Window for merged PRs and artifacts', '7')
    .option('--no-remote', 'Skip the GitHub lookup (merged-PR count); faster, offline')
    .option('--fleet', 'Also dial every fleet device for workspace presence, branch, and drift (one SSH per peer)')
    .action(async (name: string | undefined, opts: { json?: boolean; window?: string; remote?: boolean; fleet?: boolean }) => {
      const all = listProjectDefs();
      // Named lookup goes through the strict single-def loader so a broken
      // <name>.yaml surfaces its validation error instead of "No project named".
      const defs = name ? [loadProjectDef(name)].filter((d): d is ProjectDef => d !== undefined) : all;
      if (name && !defs.length) {
        console.error(chalk.red(`No project named "${name}".`));
        process.exit(1);
      }
      if (!defs.length) {
        if (opts.json) console.log('[]');
        else console.log(chalk.gray('No projects defined. Add one: agents projects add <name>'));
        return;
      }
      const windowDays = Math.max(1, Number.parseInt(opts.window ?? '7', 10) || 7);
      const nowMs = Date.now();

      // --fleet: probe each shown def's workspace paths (root + repos[].path)
      // locally and on every peer in one parallel SSH round, and widen the
      // live-session rollup to the whole fleet via the existing sessions
      // fan-out. Both are opt-in — they dial the fleet.
      const fleetTargets = opts.fleet ? [...new Set(defs.flatMap(workspaceTargetsForDef))] : [];
      let fleetWs: HostWorkspaceStatus[] = [];
      let fleetSkipped: string[] = [];
      let fleetSessions: Awaited<ReturnType<typeof getActiveSessions>> = [];
      if (opts.fleet) {
        const self = machineId();
        fleetWs.push(...probeProjectWorkspaces(fleetTargets).map((s) => ({ ...s, host: self })));
        const [probeRes, activeRes] = await Promise.all([
          fleetTargets.length > 0
            ? gatherRemoteAgentsJson({
                args: ['projects', 'probe', '--json', ...fleetTargets],
                noFanoutEnv: PROJECTS_NO_FANOUT_ENV,
                parse: parseRemoteProbe,
                quiet: true,
              })
            : Promise.resolve({ items: [] as HostWorkspaceStatus[], deviceCount: 0, skipped: [] as string[] }),
          gatherRemoteActive(undefined, { quiet: true }),
        ]);
        fleetWs.push(...probeRes.items);
        fleetSkipped = probeRes.skipped;
        fleetSessions = activeRes.sessions;
      }

      const roll = rollupSessionsByProject(all, [...await getActiveSessions(), ...fleetSessions]);
      // Enrich only the shown projects. --no-remote still reads the local artifact
      // log but skips the gh calls + Linear counts (both are network).
      const remote = new Map<string, ProjectRemoteSignals>();
      const linear = new Map<string, LinearProjectCounts>();
      await Promise.all(
        defs.map(async (d) => {
          const skipRemote = opts.remote === false;
          const [sig, counts] = await Promise.all([
            enrichProjectSignals(d, windowDays, nowMs, { skipRemote }),
            !skipRemote && d.linear?.projectId
              ? fetchLinearProjectCounts(d.linear.projectId)
              : Promise.resolve(undefined),
          ]);
          remote.set(d.name, sig);
          if (counts) linear.set(d.name, counts);
        }),
      );

      /** This def's slice of the fleet probe, in its own target order. */
      const fleetFor = (d: ProjectDef): HostWorkspaceStatus[] => {
        const targets = new Set(workspaceTargetsForDef(d));
        return fleetWs.filter((s) => targets.has(s.path));
      };

      if (opts.json) {
        if (fleetSkipped.length > 0) process.stderr.write(formatFleetSkippedNote(fleetSkipped));
        console.log(
          JSON.stringify(
            defs.map((d) => {
              const r = roll.get(d.name);
              const rem = remote.get(d.name);
              return {
                name: d.name,
                agents: r?.agents ?? 0,
                byStatus: r?.byStatus ?? {},
                members: r?.members ?? [],
                plan: r?.plan ?? { done: 0, total: 0 },
                planPct: r ? planPct(r.plan) ?? null : null,
                openPrs: r?.openPrs ?? [],
                mergedPrs: rem?.mergedPrs ?? 0,
                latestRelease: rem?.latestRelease ?? null,
                linear: linear.get(d.name) ?? null,
                tickets: r?.tickets ?? [],
                worktrees: r?.worktrees ?? 0,
                artifacts: rem?.artifacts ?? 0,
                lastArtifact: rem?.lastArtifact ?? null,
                windowDays,
                repos: [d.repo, ...(d.repos ?? []).map((r2) => r2.slug)].filter(Boolean),
                ...(opts.fleet ? { workspaces: fleetFor(d) } : {}),
              };
            }),
            null,
            2,
          ),
        );
        return;
      }
      for (const d of defs) {
        renderCard(d, roll.get(d.name), remote.get(d.name), opts.fleet ? fleetFor(d) : undefined, linear.get(d.name), nowMs);
      }
      if (fleetSkipped.length > 0) process.stdout.write(formatFleetSkippedNote(fleetSkipped));
    });

  // ---- probe (hidden; the peer half of `status --fleet`) ----
  projects
    .command('probe [paths...]', { hidden: true })
    .description('Probe workspace repos (presence, branch, drift, dirtiness) and print JSON. Answers for this machine only.')
    .option('--json', 'Machine-readable output (the only output format)')
    .action((paths: string[]) => {
      // Never fans out — the recursion guard env is set by the parent fan-out,
      // and this command has no remote code path either way.
      console.log(JSON.stringify(probeProjectWorkspaces(paths ?? []), null, 2));
    });

  // ---- import ----
  projects
    .command('import')
    .description('Import project definitions from Linear (preferred) or the Factory auto-detection registry.')
    .option('--from-linear', 'Import the workspace\'s Linear projects (via the `linear` CLI)')
    .option('--from-factory', 'Import the Factory registry (~/.agents/factory/projects.json)')
    .option('--min-confidence <level>', '--from-factory only: lowest detection confidence to import — low|medium|high (default: high)')
    .option('--all', '--from-factory only: import every row regardless of confidence')
    .option('--force', 'Overwrite existing definitions')
    .action((raw: RawImportFlags) => {
      let opts: ImportOptions;
      try {
        opts = validateImportOpts(raw);
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
      const existing = new Map(listProjectDefs().map((d) => [d.name, d]));
      const result = opts.source === 'linear' ? runLinearImport(existing, opts) : runFactoryImport(existing, opts);
      for (const def of result.defs) writeProjectDef(def);
      const n = result.defs.length;
      const s = result.skipped.length;
      console.log(chalk.green(`Imported ${n} project${n === 1 ? '' : 's'}${s ? chalk.gray(` (${s} skipped)`) : ''}`));
      for (const skip of result.skipped) console.log(chalk.gray(`  skip ${skip.name}: ${skip.reason}`));
      if (opts.source === 'factory' && s > 0 && opts.minConfidence === 'high') {
        console.log(chalk.gray('  (widen with --min-confidence medium or --all)'));
      }
    });

  // ---- link ----
  projects
    .command('link <name>')
    .description('Attach an external tracker to a project definition (writes linear.projectId into the YAML).')
    .option('--linear [query]', 'Bind a Linear project by exact name or id; no value auto-suggests from the def name + repo')
    .action((name: string, opts: { linear?: string | boolean }) => {
      const def = loadProjectDef(name);
      if (!def) {
        console.error(chalk.red(`No project named "${name}". List them: agents projects list`));
        process.exit(1);
      }
      if (opts.linear === undefined) {
        console.error(chalk.red('Nothing to link. Pass a tracker flag, e.g. --linear [query].'));
        process.exit(1);
      }
      // Explicit user command — a missing/unauthenticated `linear` CLI is loud,
      // unlike the best-effort card enrichment.
      let list: ReturnType<typeof listLinearProjects>;
      try {
        list = listLinearProjects();
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
      const query = typeof opts.linear === 'string' ? opts.linear.trim() : '';
      let pick: LinearPick;
      if (query) {
        pick = pickLinearProject(query, list);
      } else {
        // Auto-suggest from the def's own identity — the primary repo slug is
        // the sharpest key, then the def name. Only an exact normalized match
        // writes itself; anything weaker asks the user to disambiguate.
        pick = { kind: 'none' };
        for (const hint of [def.repo, def.name].filter((h): h is string => typeof h === 'string' && h.length > 0)) {
          const d = pickLinearProject(hint, list);
          if (d.kind === 'match') {
            pick = d;
            break;
          }
          if (pick.kind === 'none') pick = d;
        }
      }
      if (pick.kind !== 'match') {
        if (pick.kind === 'candidates') {
          console.error(chalk.yellow(`No confident Linear match${query ? ` for "${query}"` : ` for "${def.name}"`}. Candidates:`));
          for (const c of pick.projects) console.error(`  ${chalk.cyan(c.id)}  ${c.name}`);
        } else {
          console.error(chalk.yellow(`No Linear project matches${query ? ` "${query}"` : ` "${def.name}"`}. Available:`));
          for (const c of list) console.error(`  ${chalk.cyan(c.id)}  ${c.name}`);
        }
        console.error(chalk.gray(`Re-run with an explicit name or id: agents projects link ${name} --linear "<name-or-id>"`));
        process.exit(1);
      }
      const p = pick.project;
      // Preserve every other field — load, set linear, write back. Keep a
      // previously linked url when the new CLI row carries none.
      if (def.linear?.projectId && def.linear.projectId !== p.id) {
        console.log(chalk.gray(`  replacing previous Linear link (${def.linear.projectId})`));
      }
      def.linear = { ...def.linear, projectId: p.id };
      if (p.url) def.linear.url = p.url;
      writeProjectDef(def);
      console.log(chalk.green(`${def.name} → Linear project "${p.name}" (${p.id})${p.url ? ` ${p.url}` : ''}`));
    });

  // ---- rm ----
  projects
    .command('rm <name>')
    .alias('remove')
    .description('Delete a project definition. Never touches the repo.')
    .action((name: string) => {
      if (removeProjectDef(name)) {
        console.log(chalk.green(`Removed project "${name}"`));
      } else {
        console.error(chalk.red(`No project named "${name}".`));
        process.exit(1);
      }
    });
}
