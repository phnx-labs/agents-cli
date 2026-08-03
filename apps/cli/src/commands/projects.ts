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
import { execFileSync, spawnSync } from 'child_process';

import { betaEnableHint, isBetaEnabled } from '../lib/beta.js';
import { setHelpSections } from '../lib/help.js';
import { getMainRepoRoot } from '../lib/git.js';
import { parseOwnerRepoFromRemote } from '../lib/registry.js';
import { toHomeRelative } from '../lib/project-root.js';
import { getActiveSessions } from '../lib/session/active.js';
import { factoryProjectsPath } from '../lib/auto-dispatch.js';
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
  type ProjectSessionRollup,
  type ProjectRemoteSignals,
} from '../lib/project-status.js';

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

function statusBar(r: ProjectSessionRollup): string {
  const parts: string[] = [];
  const push = (n: number | undefined, label: string, color: (s: string) => string) => {
    if (n && n > 0) parts.push(color(`${n} ${label}`));
  };
  push(r.byStatus.running, 'running', chalk.green);
  push(r.byStatus.idle, 'idle', chalk.gray);
  push(r.byStatus.input_required, 'need-input', chalk.yellow);
  push(r.byStatus.queued, 'queued', chalk.gray);
  return parts.join(' · ') || chalk.gray('no live agents');
}

function renderCard(
  def: ProjectDef,
  r: ProjectSessionRollup | undefined,
  remote: ProjectRemoteSignals | undefined,
): void {
  const agents = r?.agents ?? 0;
  const pct = r ? planPct(r.plan) : undefined;
  const planStr = pct === undefined ? '' : `  ·  ${chalk.cyan(`${pct}% plan`)}`;
  console.log(`${chalk.bold(def.name)}  ${chalk.dim('·')}  ${chalk.bold(`${agents} agents`)}${planStr}`);
  if (def.description) console.log(`  ${chalk.dim(def.description)}`);
  console.log(`  ${chalk.dim('live')}     ${r ? statusBar(r) : chalk.gray('no live agents')}`);
  const ships: string[] = [];
  if (remote?.mergedPrs) ships.push(chalk.green(`${remote.mergedPrs} merged (${remote.windowDays}d)`));
  if (r?.openPrs.length) ships.push(`${r.openPrs.length} open PR${r.openPrs.length === 1 ? '' : 's'}`);
  if (r?.worktrees) ships.push(`${r.worktrees} worktree${r.worktrees === 1 ? '' : 's'}`);
  if (ships.length) console.log(`  ${chalk.dim('ships')}    ${ships.join(' · ')}`);
  if (r && r.tickets.length) {
    console.log(`  ${chalk.dim('tickets')}  ${r.tickets.slice(0, 8).join(' · ')}${r.tickets.length > 8 ? ' …' : ''}`);
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
      agents projects add rush --repo phnx-labs/rush --path apps/web
      agents projects list
      agents projects status              # progress card for every project
      agents projects status rush --json  # one project, machine-readable
      agents run --project rush           # land an agent in the project
    `,
    notes: `
      Definitions are hand-editable YAML in ~/.agents/projects/ and sync across
      machines with 'agents push/pull'. Enable with: agents beta enable projects.
    `,
  });

  projects.hook('preAction', () => {
    if (enabled) return;
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
      for (const d of defs) {
        const agents = roll.get(d.name)?.agents ?? 0;
        const repo = d.repo ?? d.repos?.[0]?.slug ?? '';
        console.log(
          `  ${chalk.bold(d.name.padEnd(16))} ${chalk.dim((d.root ?? d.defaultPath ?? '').padEnd(32))} ${chalk.cyan(repo.padEnd(24))} ${agents} agents`,
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
      const res = spawnSync(editor, [target], { stdio: 'inherit' });
      process.exit(res.status ?? 0);
    });

  // ---- status ----
  projects
    .command('status [name]')
    .description('Progress rollup: agents, plan %, merged/open PRs, tickets, and artifacts per project.')
    .option('--json', 'Machine-readable output')
    .option('--window <days>', 'Window for merged PRs and artifacts', '7')
    .option('--no-remote', 'Skip the GitHub lookup (merged-PR count); faster, offline')
    .action(async (name: string | undefined, opts: { json?: boolean; window?: string; remote?: boolean }) => {
      const all = listProjectDefs();
      const defs = name ? all.filter((d) => d.name === name) : all;
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
      const roll = rollupSessionsByProject(all, await getActiveSessions());
      // Enrich only the shown projects. --no-remote still reads the local artifact
      // log but skips the gh call (def.repo left unused → mergedPrs stays 0).
      const remote = new Map<string, ProjectRemoteSignals>();
      await Promise.all(
        defs.map(async (d) => {
          remote.set(d.name, await enrichProjectSignals(d, windowDays, nowMs, { skipRemote: opts.remote === false }));
        }),
      );

      if (opts.json) {
        console.log(
          JSON.stringify(
            defs.map((d) => {
              const r = roll.get(d.name);
              const rem = remote.get(d.name);
              return {
                name: d.name,
                agents: r?.agents ?? 0,
                byStatus: r?.byStatus ?? {},
                plan: r?.plan ?? { done: 0, total: 0 },
                planPct: r ? planPct(r.plan) ?? null : null,
                openPrs: r?.openPrs ?? [],
                mergedPrs: rem?.mergedPrs ?? 0,
                tickets: r?.tickets ?? [],
                worktrees: r?.worktrees ?? 0,
                artifacts: rem?.artifacts ?? 0,
                lastArtifact: rem?.lastArtifact ?? null,
                windowDays,
                repos: [d.repo, ...(d.repos ?? []).map((r2) => r2.slug)].filter(Boolean),
              };
            }),
            null,
            2,
          ),
        );
        return;
      }
      for (const d of defs) renderCard(d, roll.get(d.name), remote.get(d.name));
    });

  // ---- import ----
  projects
    .command('import')
    .description('Absorb the Factory project registry (~/.agents/factory/projects.json) into YAML definitions.')
    .requiredOption('--from-factory', 'Import from the Factory projects.json registry')
    .option('--force', 'Overwrite existing definitions')
    .action((opts: { force?: boolean }) => {
      const src = factoryProjectsPath();
      let rows: unknown;
      try {
        rows = JSON.parse(fs.readFileSync(src, 'utf8'));
      } catch {
        console.error(chalk.red(`No Factory registry at ${src}`));
        process.exit(1);
      }
      const list = Array.isArray(rows) ? rows : Array.isArray((rows as { projects?: unknown[] }).projects) ? (rows as { projects: unknown[] }).projects : [];
      let created = 0;
      let skipped = 0;
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const o = raw as Record<string, unknown>;
        const name = typeof o.name === 'string' ? o.name : undefined;
        if (!name || !isSafeProjectName(name)) {
          skipped++;
          continue;
        }
        if (loadProjectDef(name) && !opts.force) {
          skipped++;
          continue;
        }
        const def: ProjectDef = { name };
        if (typeof o.path === 'string') def.root = toHomeRelative(o.path);
        if (typeof o.repoSlug === 'string') def.repo = o.repoSlug;
        if (typeof o.linearProjectId === 'string') def.linear = { projectId: o.linearProjectId };
        writeProjectDef(def);
        created++;
      }
      console.log(chalk.green(`Imported ${created} project${created === 1 ? '' : 's'}${skipped ? chalk.gray(` (${skipped} skipped)`) : ''}`));
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
