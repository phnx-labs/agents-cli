/**
 * `agents lease` — manage the disposable cloud boxes used by `agents run --lease`.
 *
 * Today: `agents lease gc`, which stops expired + idle "orphan" boxes that are
 * holding a provider's server quota (the cause of the `server_limit` 403 a new
 * lease hits). Reaping is conservative: only boxes whose lease has expired AND
 * that have been untouched for a safety window are eligible (see `isReapSafe`),
 * so a box a concurrent run just reused is never stopped.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { crabboxList, reapSafeOrphans, reapOrphans, type CrabboxBox } from '../lib/crabbox/cli.js';

function fmtIdle(box: CrabboxBox): string {
  if (box.lastTouchedAt === null) return 'idle ?';
  const iso = new Date(box.lastTouchedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `idle since ${iso}Z`;
}

export function registerLeaseCommand(program: Command): void {
  const lease = program
    .command('lease')
    .description('Manage the disposable cloud boxes used by `agents run --lease`.');

  lease
    .command('gc')
    .description(
      'Stop expired, idle lease boxes that are holding your provider quota. Safe: never stops a box in active use.',
    )
    .option('--dry-run', 'List reap-safe orphan boxes without stopping any', false)
    .option('--yes', 'Stop them without the interactive confirm', false)
    .option('--json', 'Output JSON', false)
    .action(async (opts: { dryRun?: boolean; yes?: boolean; json?: boolean }) => {
      const boxOpts = { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE };
      const nowSecs = Math.floor(Date.now() / 1000);

      let candidates: CrabboxBox[];
      try {
        candidates = reapSafeOrphans(crabboxList(boxOpts), nowSecs);
      } catch (e) {
        console.error(chalk.red(`lease gc: ${(e as Error).message}`));
        process.exit(1);
        return;
      }

      if (candidates.length === 0) {
        if (opts.json) console.log(JSON.stringify({ candidates: [], reaped: [] }));
        else console.error(chalk.gray('No reap-safe orphan boxes — nothing to collect.'));
        return;
      }

      if (!opts.json) {
        console.error(chalk.bold(`${candidates.length} reap-safe orphan box(es):`));
        for (const b of candidates) {
          console.error(`  ${chalk.cyan(b.slug)} ${chalk.dim(`(${b.class ?? '?'}, ${fmtIdle(b)})`)}`);
        }
      }

      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify({ candidates, reaped: [] }, null, 2));
        else console.error(chalk.gray('\n--dry-run: nothing stopped. Re-run with --yes to stop them.'));
        return;
      }

      // Destructive: stopping boxes the agent did not create needs an explicit yes.
      if (!opts.yes) {
        const { isInteractiveTerminal, isPromptCancelled } = await import('./utils.js');
        if (!isInteractiveTerminal()) {
          console.error(chalk.yellow('Refusing to stop boxes without --yes in a non-interactive shell.'));
          process.exit(1);
          return;
        }
        try {
          const { confirm } = await import('@inquirer/prompts');
          const ok = await confirm({ message: `Stop these ${candidates.length} box(es)?`, default: false });
          if (!ok) {
            console.error(chalk.yellow('Aborted — no boxes stopped.'));
            return;
          }
        } catch (e) {
          if (isPromptCancelled(e)) {
            console.error(chalk.yellow('Aborted — no boxes stopped.'));
            return;
          }
          throw e;
        }
      }

      // Re-list at stop time (freshness re-check) so a box touched since the
      // preview is not stopped out from under an active run.
      const { candidates: stopped, reaped } = reapOrphans({ ...boxOpts, nowSecs });
      if (opts.json) console.log(JSON.stringify({ candidates: stopped, reaped }, null, 2));
      else console.error(chalk.green(`Stopped ${reaped.length}/${stopped.length} box(es): ${reaped.join(', ') || '(none)'}`));
    });
}
