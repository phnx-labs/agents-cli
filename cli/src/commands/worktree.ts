/**
 * `agents worktree` — reclaim PR-bound agent worktrees (PHNX-3503).
 *
 * Worktree law creates one checkout per change and nothing ever removed it, so
 * every merged PR leaked a few GB. This is the one safe command that removes a
 * worktree AND its branch, and it is deliberately the ONLY way an agent can do
 * that: `git branch -d/-D` stays denied fleet-wide, because an agent choosing
 * for itself which branches to delete is the failure this avoids. Here the
 * authority is the merge, not the caller.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { getMainRepoRoot } from '../lib/git.js';
import { setHelpSections } from '../lib/help.js';
import {
  classifyWorktree,
  collectWorktrees,
  describeBlocker,
  reclaimWorktree,
  type WorktreeFacts,
} from '../lib/worktree/reclaim.js';

/** Grace window before an unattended sweep may remove a merged worktree. */
const DEFAULT_GRACE_DAYS = 3;

function parseGrace(v: string | undefined, fallback = DEFAULT_GRACE_DAYS): number {
  if (v === undefined) return fallback;
  const m = /^(\d+)\s*d?$/.exec(v.trim());
  if (!m) throw new Error(`--older-than expects days, e.g. "3" or "3d" (got "${v}")`);
  return parseInt(m[1], 10);
}

function row(f: WorktreeFacts, graceDays: number): string {
  const v = classifyWorktree(f, graceDays);
  const state = v.reclaimable
    ? chalk.green('reclaimable')
    : chalk.yellow(v.blockers.map(describeBlocker).join(', '));
  const age = f.ageDays === Number.MAX_SAFE_INTEGER ? 'gone' : `${f.ageDays}d`;
  return `  ${f.name.padEnd(44).slice(0, 44)} ${age.padStart(5)}  ${state}`;
}

export function registerWorktreeCommand(program: Command): void {
  const cmd = program
    .command('worktree')
    .description('Inspect and reclaim PR-bound agent worktrees');

  setHelpSections(cmd, {
    examples: `
      # What is on this box, and what could be reclaimed
      agents worktree list

      # Reclaim one you are finished with (after its PR merged)
      agents worktree done phnx-3503-worktree-reclaim

      # Preview a full sweep, then run it
      agents worktree sweep --dry-run
      agents worktree sweep --yes
    `,
    notes: `
      A worktree is reclaimed only when ALL of these hold — every check fails
      closed, so an unknown answer refuses:
        - no uncommitted changes,
        - no commits missing upstream (compared by patch-id, so a squash- or
          rebase-merged branch counts as landed even though its SHAs differ),
        - it is not the primary checkout, and
        - it is older than the grace window (sweep only; \`done\` is immediate).

      This is the only surface that may delete a branch. Agents hold no
      \`git branch -d/-D\` permission by design; the authority here is the merge,
      not the caller. Work that has not landed is never removed — it is listed
      with the reason instead.
    `,
  });

  cmd
    .command('list')
    .description('List worktrees in this repo with their reclaim state')
    .option('--older-than <days>', 'grace window used to judge reclaimability', String(DEFAULT_GRACE_DAYS))
    .option('--json', 'machine-readable output')
    .action(async (opts) => {
      const grace = parseGrace(opts.olderThan);
      const root = await getMainRepoRoot(process.cwd());
      const all = await collectWorktrees(root);
      if (opts.json) {
        console.log(
          JSON.stringify(
            all.map((f) => ({ ...f, ...classifyWorktree(f, grace) })),
            null,
            2,
          ),
        );
        return;
      }
      const linked = all.filter((f) => !f.isPrimary);
      if (linked.length === 0) {
        console.log('No linked worktrees in this repo.');
        return;
      }
      const ready = linked.filter((f) => classifyWorktree(f, grace).reclaimable);
      console.log(chalk.bold(`\n${linked.length} worktree(s) in ${root}\n`));
      for (const f of linked) console.log(row(f, grace));
      console.log(
        `\n  ${chalk.green(String(ready.length))} reclaimable · ` +
          `${linked.length - ready.length} held\n`,
      );
      if (ready.length > 0) console.log(`  Reclaim them: ${chalk.cyan('agents worktree sweep --yes')}\n`);
    });

  cmd
    .command('done [name]')
    .description('Reclaim one finished worktree (defaults to the current one)')
    .option('--json', 'machine-readable output')
    .action(async (name: string | undefined, opts) => {
      const root = await getMainRepoRoot(process.cwd());
      const all = await collectWorktrees(root);
      const target = name
        ? all.find((f) => f.name === name)
        : all.find((f) => !f.isPrimary && process.cwd().startsWith(f.path));
      if (!target) {
        console.error(
          name
            ? `No worktree named '${name}' in ${root}.`
            : 'Not inside a linked worktree — name one, or run `agents worktree list`.',
        );
        process.exitCode = 1;
        return;
      }
      // `done` is an explicit, attended act on one named worktree, so the grace
      // window (which exists to protect an UNATTENDED sweep) does not apply.
      const res = await reclaimWorktree(root, target, 0);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else if (res.removed) {
        console.log(
          `${chalk.green('✓')} reclaimed ${res.name}` +
            (res.branchDeleted ? ` (branch ${target.branch} deleted)` : ''),
        );
      } else {
        console.error(`${chalk.yellow('held')} ${res.name} — ${res.reason}`);
      }
      if (!res.removed) process.exitCode = 1;
    });

  cmd
    .command('sweep')
    .description('Reclaim every finished worktree in this repo')
    .option('--older-than <days>', 'only sweep worktrees older than this', String(DEFAULT_GRACE_DAYS))
    .option('--dry-run', 'show what would be reclaimed, change nothing')
    .option('--yes', 'skip the confirmation prompt')
    .option('--json', 'machine-readable output')
    .action(async (opts) => {
      const grace = parseGrace(opts.olderThan);
      const root = await getMainRepoRoot(process.cwd());
      const all = await collectWorktrees(root);
      const linked = all.filter((f) => !f.isPrimary);
      const ready = linked.filter((f) => classifyWorktree(f, grace).reclaimable);

      if (opts.dryRun) {
        const payload = {
          repo: root,
          reclaimable: ready.map((f) => f.name),
          held: linked
            .filter((f) => !classifyWorktree(f, grace).reclaimable)
            .map((f) => ({
              name: f.name,
              reasons: classifyWorktree(f, grace).blockers.map(describeBlocker),
            })),
        };
        if (opts.json) console.log(JSON.stringify(payload, null, 2));
        else {
          console.log(chalk.bold(`\nWould reclaim ${ready.length} of ${linked.length} worktree(s):\n`));
          for (const f of ready) console.log(`  ${chalk.green('•')} ${f.name}`);
          for (const h of payload.held) console.log(`  ${chalk.yellow('held')} ${h.name} — ${h.reasons.join(', ')}`);
          console.log();
        }
        return;
      }

      if (ready.length === 0) {
        if (opts.json) console.log(JSON.stringify({ repo: root, reclaimed: [], held: linked.length }, null, 2));
        else console.log(`Nothing to reclaim (${linked.length} worktree(s) held).`);
        return;
      }

      if (!opts.yes && !opts.json) {
        console.log(`${ready.length} worktree(s) are reclaimable. Re-run with --yes to remove them,`);
        console.log('or inspect them first with `agents worktree sweep --dry-run`.');
        return;
      }

      const results = [];
      for (const f of ready) results.push(await reclaimWorktree(root, f, grace));
      const removed = results.filter((r) => r.removed);
      if (opts.json) {
        console.log(JSON.stringify({ repo: root, reclaimed: removed.map((r) => r.name), results }, null, 2));
      } else {
        for (const r of results) {
          if (r.removed) console.log(`${chalk.green('✓')} ${r.name}`);
          else console.log(`${chalk.yellow('held')} ${r.name} — ${r.reason}`);
        }
        console.log(`\nReclaimed ${removed.length} of ${ready.length}.\n`);
      }
    });
}
