/**
 * `agents set` — ergonomic top-level setter for per-agent/version run defaults.
 *
 * `agents set claude@2.1.220 --model opus-5` pins the default model (and/or
 * mode) that `agents run` uses for that agent version. It reads and writes the
 * same store as `agents defaults run set` (agents.yaml -> run.defaults), so the
 * two stay consistent — `set` is just the short front door.
 *
 *   agents set                          # list every configured default
 *   agents set claude@2.1.220           # show the default for one version
 *   agents set claude@2.1.220 --model opus-5
 *   agents set 'claude:*' --mode auto --model opus
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import {
  formatRunDefaultEntry,
  listRunDefaults,
  parseRunDefaultSelector,
  setRunDefault,
} from '../lib/run-defaults.js';

interface SetOptions {
  mode?: string;
  model?: string;
}

export function registerSetCommand(program: Command): void {
  const set = program
    .command('set [selector]')
    .description('Set the default model/mode an agent version uses for `agents run`')
    .option('--model <model>', 'Default model or model alias, forwarded via --model')
    .option('--mode <mode>', "Default mode: plan, edit, auto, skip. 'full' accepted as alias for skip.")
    .action((selector: string | undefined, options: SetOptions) => {
      try {
        const hasFlags = options.model !== undefined || options.mode !== undefined;

        if (!selector) {
          if (hasFlags) {
            throw new Error('Selector is required when passing --model/--mode. Example: agents set claude@2.1.220 --model opus-5');
          }
          const entries = listRunDefaults();
          if (entries.length === 0) {
            console.log(chalk.gray('No agent defaults configured.'));
            console.log(chalk.gray('Set one with: agents set claude@2.1.220 --model opus-5'));
            return;
          }
          console.log(chalk.bold('Agent Defaults\n'));
          for (const entry of entries) {
            console.log(`  ${formatRunDefaultEntry(entry)}`);
          }
          return;
        }

        if (!hasFlags) {
          const parsed = parseRunDefaultSelector(selector);
          const entry = listRunDefaults().find((e) => e.selector === parsed.selector);
          if (!entry || (!entry.defaults.mode && !entry.defaults.model)) {
            console.log(chalk.gray(`No default set for ${parsed.selector}.`));
            console.log(chalk.gray(`Set one with: agents set ${selector} --model <model>`));
            return;
          }
          console.log(`  ${formatRunDefaultEntry(entry)}`);
          return;
        }

        const entry = setRunDefault(selector, {
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        });
        console.log(chalk.green('Set default:'));
        console.log(`  ${formatRunDefaultEntry(entry)}`);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  setHelpSections(set, {
    examples: `
      agents set claude@2.1.220 --model opus-5
      agents set 'claude:*' --mode auto --model opus
      agents set claude@2.1.220
      agents set
    `,
    notes: `
      Selectors use <agent>@<version> or <agent>:<version>; * matches all versions.
      Exact selectors override wildcard selectors field by field.
      Writes the same store as 'agents defaults run set'. Explicit flags on
      'agents run' always win over configured defaults.
    `,
  });
}
