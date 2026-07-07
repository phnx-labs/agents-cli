/**
 * Removed `agents pull` command.
 *
 * `agents pull` was a god-command bundling git fetch+ff with local
 * materialization (install CLIs, register MCP, sync resources, register hooks,
 * etc.). It is replaced by the explicit split:
 *
 *   - `agents repo pull <alias>`     — git fetch+ff on system / user / extra
 *   - `agents repo refresh [agent]`  — re-materialize installed version homes
 *   - `agents setup`                 — first-time bootstrap
 *
 * The command is kept registered so old muscle-memory invocations get a clear
 * redirect instead of an "unknown command" error.
 */

import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';

const REDIRECT =
  'agents-cli: "agents pull" was removed.\n' +
  '            Git pull a repo:   agents repo pull <alias>      (system | user | <extra>)\n' +
  '            Re-materialize:    agents repo refresh [agent]   (claude | codex | ...)\n' +
  '            First-time setup:  agents setup\n\n';

/** Register the deprecated `agents pull` command as a hard-error redirect. */
export function registerPullCommand(program: Command): void {
  const pullCmd = program
    .command('pull [agent]')
    .description('Removed. See `agents repo pull` + `agents repo refresh`.')
    .option('-y, --yes', '(no-op)')
    .option('--skip-clis', '(no-op)');

  setHelpSections(pullCmd, {
    notes: `
      Removed. Equivalents:
        agents repo pull <alias>     git pull (system | user | extra)
        agents repo refresh [agent]  re-materialize version homes
        agents setup                 first-time bootstrap
    `,
  });

  pullCmd.action(() => {
    process.stderr.write(REDIRECT);
    process.exit(2);
  });
}
