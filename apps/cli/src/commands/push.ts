/**
 * Removed `agents push` command.
 *
 * `agents push` was previously the inverse of the god-command `agents pull` —
 * it pushed local commits in `~/.agents/` upstream. It is replaced by the
 * explicit `agents repo push <alias>` so the target repo is named, matching
 * the post-split `agents repo pull` shape.
 *
 * Kept registered so muscle-memory invocations (including `agents push --help`)
 * land on a clear redirect instead of cascading to the top-level help.
 */

import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';

const REDIRECT =
  'agents-cli: "agents push" was removed.\n' +
  '            Git push a repo: agents repo push <alias>   (system | user | <extra>)\n\n';

/** Register the deprecated `agents push` command as a hard-error redirect. */
export function registerPushCommand(program: Command): void {
  const pushCmd = program
    .command('push [alias]')
    .description('Removed. See `agents repo push`.');

  setHelpSections(pushCmd, {
    notes: `
      Removed. Equivalent:
        agents repo push <alias>     git push (system | user | extra)
    `,
  });

  pushCmd.action(() => {
    process.stderr.write(REDIRECT);
    process.exit(2);
  });
}
