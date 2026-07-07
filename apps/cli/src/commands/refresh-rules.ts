/**
 * Internal rules refresh command.
 *
 * Registers the hidden `agents refresh-rules` command invoked by shims for
 * agents that do not natively resolve @-imports in their rules file.
 * Recompiles only when source files have changed.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS, resolveAgentName } from '../lib/agents.js';
import { isVersionInstalled } from '../lib/versions.js';
import { ensureRulesFresh, supportsRulesImports } from '../lib/rules/compile.js';

/**
 * Hidden command invoked by shims for agents that don't natively resolve
 * @-imports in their rules file. Fast-path check first (sha256 of tracked
 * source files); only recompiles if a source has changed since the last
 * sync. Typical cost: 10-20ms when rules are fresh.
 */
export function registerRefreshRulesCommand(program: Command): void {
  program
    .command('refresh-rules', { hidden: true })
    .description('Internal: recompile rules for an agent if sources have changed. Called by shims.')
    .requiredOption('--agent <agent>', 'Agent identifier (codex, opencode, cursor, etc.)')
    .requiredOption('--agent-version <version>', 'Installed version whose rules file should be refreshed')
    .option('--quiet', 'Suppress all output (exit code indicates success)', false)
    .action((opts) => {
      const agentId = resolveAgentName(opts.agent as string);
      const version = opts.agentVersion as string;
      const quiet = !!opts.quiet;

      if (!agentId) {
        if (!quiet) console.error(chalk.red(`Unknown agent '${opts.agent}'`));
        process.exitCode = 1;
        return;
      }

      if (supportsRulesImports(agentId)) {
        // Nothing to do — agent resolves @-imports natively.
        return;
      }

      if (!isVersionInstalled(agentId, version)) {
        if (!quiet) {
          console.error(chalk.red(`${AGENTS[agentId].name}@${version} is not installed`));
        }
        process.exitCode = 1;
        return;
      }

      const recompiled = ensureRulesFresh(agentId, version);
      if (!quiet && recompiled) {
        console.log(chalk.gray(`Refreshed rules for ${agentId}@${version}`));
      }
    });
}
