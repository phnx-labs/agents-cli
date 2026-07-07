/**
 * Defaults command tree.
 *
 * `agents defaults run ...` manages selector-based defaults for `agents run`.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import {
  listRunDefaults,
  setRunDefault,
  unsetRunDefault,
  type RunDefaultEntry,
} from '../lib/run-defaults.js';

interface RunDefaultsSetOptions {
  mode?: string;
  model?: string;
}

function formatRunDefault(entry: RunDefaultEntry): string {
  const parts: string[] = [];
  if (entry.defaults.mode) parts.push(`mode ${chalk.white(entry.defaults.mode)}`);
  if (entry.defaults.model) parts.push(`model ${chalk.white(entry.defaults.model)}`);
  return `${chalk.cyan(entry.selector.padEnd(22))} ${parts.join('  ')}`;
}

export function registerDefaultsCommands(program: Command): void {
  const defaults = program
    .command('defaults')
    .description('Manage default options for agents-cli commands');

  const run = defaults
    .command('run')
    .description('Manage selector-based defaults for `agents run`');

  setHelpSections(run, {
    examples: `
      agents defaults run list
      agents defaults run set 'claude:*' --mode auto --model opus
      agents defaults run set claude@2.1.45 --mode plan --model sonnet
      agents defaults run unset 'claude:*'
    `,
    notes: `
      Selectors use <agent>:<version>. Use * for all versions of an agent.
      Exact selectors override wildcard selectors field by field.
      Explicit flags on agents run always win over configured defaults.
    `,
  });

  run
    .command('list')
    .description('List configured run defaults')
    .action(() => {
      const entries = listRunDefaults();
      if (entries.length === 0) {
        console.log(chalk.gray('No run defaults configured.'));
        console.log(chalk.gray("Set one with: agents defaults run set 'claude:*' --mode auto --model opus"));
        return;
      }

      console.log(chalk.bold('Run Defaults\n'));
      for (const entry of entries) {
        console.log(`  ${formatRunDefault(entry)}`);
      }
    });

  run
    .command('set <selector>')
    .description('Set defaults for an agent/version selector')
    .option('--mode <mode>', "Default mode: plan, edit, auto, skip. 'full' accepted as alias for skip.")
    .option('--model <model>', 'Default model or model alias, forwarded via --model')
    .action((selector: string, options: RunDefaultsSetOptions) => {
      try {
        const entry = setRunDefault(selector, {
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        });
        console.log(chalk.green('Set run default:'));
        console.log(`  ${formatRunDefault(entry)}`);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  run
    .command('unset <selector>')
    .description('Remove defaults for an agent/version selector')
    .action((selector: string) => {
      try {
        const removed = unsetRunDefault(selector);
        if (removed) {
          console.log(chalk.green(`Removed run default ${selector}`));
        } else {
          console.log(chalk.gray(`No run default matched ${selector}`));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
