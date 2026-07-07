/**
 * `agents sessions sync` — push this machine's transcripts to R2 and pull every
 * other machine's, merging copies of the same session via CRDT union. The local
 * sessions index is rebuilt from the synced-in mirror by the normal scanner.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import {
  isSyncConfigured,
  isSyncEnabled,
  setSyncEnabled,
  SYNC_BUNDLE,
} from '../lib/session/sync/config.js';
import { syncSessions } from '../lib/session/sync/sync.js';

interface SyncCmdOptions {
  verbose?: boolean;
  json?: boolean;
  enable?: boolean;
  disable?: boolean;
  status?: boolean;
}

export async function runSessionsSync(options: SyncCmdOptions): Promise<void> {
  // Toggle / status actions short-circuit before any network cycle.
  if (options.disable) {
    setSyncEnabled(false);
    console.log(
      chalk.yellow('Automatic session sync disabled') +
      chalk.dim(' — the daemon stops pushing/pulling within ~90s. Re-enable: agents sessions sync --enable'),
    );
    return;
  }
  if (options.enable) {
    setSyncEnabled(true);
    console.log(chalk.green('Automatic session sync enabled') + chalk.dim(' — the daemon resumes on its next cycle.'));
    return;
  }
  if (options.status) {
    const enabled = isSyncEnabled();
    const configured = isSyncConfigured();
    if (options.json) {
      console.log(JSON.stringify({ enabled, configured }, null, 2));
    } else {
      console.log(
        `automatic sync: ${enabled ? chalk.green('enabled') : chalk.yellow('disabled')}` +
        chalk.dim('  ·  ') +
        `credentials: ${configured ? chalk.green('configured') : chalk.yellow(`missing (${SYNC_BUNDLE})`)}`,
      );
    }
    return;
  }

  if (!isSyncConfigured()) {
    console.error(
      chalk.red(`Sessions sync is not configured.`) +
      `\nAdd R2 credentials to the '${SYNC_BUNDLE}' bundle:\n` +
      `  agents secrets add ${SYNC_BUNDLE} R2_ACCOUNT_ID\n` +
      `  agents secrets add ${SYNC_BUNDLE} R2_BUCKET_NAME\n` +
      `  agents secrets add ${SYNC_BUNDLE} R2_ACCESS_KEY_ID\n` +
      `  agents secrets add ${SYNC_BUNDLE} R2_SECRET_ACCESS_KEY`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = await syncSessions({
      verbose: options.verbose,
      log: msg => console.error(chalk.dim(msg)),
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const parts = [
        `pushed ${result.pushed}`,
        `pulled ${result.pulled}`,
        result.merged > 0 ? `merged ${result.merged}` : null,
      ].filter(Boolean);
      console.log(
        chalk.green('synced') + ` ${result.machine}: ` + parts.join(', ') +
        chalk.dim(` (${result.pushSkipped + result.pullSkipped} unchanged)`),
      );
    }

    if (result.errors.length > 0) {
      for (const e of result.errors) console.error(chalk.yellow(`  ! ${e}`));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(chalk.red(`sync failed: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

export function registerSessionsSyncCommand(sessionsCmd: Command): void {
  const syncCmd = sessionsCmd
    .command('sync')
    .description('Sync session transcripts across machines via R2 (CRDT merge). Claude and Codex.')
    .option('-v, --verbose', 'Log each pushed and pulled session')
    .option('--json', 'Output the sync result as JSON')
    .option('--enable', 'Turn ON automatic background sync on this machine (persisted)')
    .option('--disable', 'Turn OFF automatic background sync on this machine (persisted)')
    .option('--status', 'Show whether automatic sync is enabled and configured');

  setHelpSections(syncCmd, {
    examples: `
      # One sync cycle (push local changes, pull + merge from other machines)
      agents sessions sync

      # See exactly what moved
      agents sessions sync --verbose

      # Stop this machine's daemon from auto-syncing (prefer on-demand --host reads)
      agents sessions sync --disable

      # Check the current switch + credential state
      agents sessions sync --status
    `,
    notes: `
      - Credentials come from the '${SYNC_BUNDLE}' secrets bundle (R2 S3 API, read+write).
      - Each machine writes only its own prefix; conflicts are impossible by construction.
      - The daemon runs this automatically (~90s); this command forces an immediate cycle.
      - Sessions present locally always win; synced-in copies fill in other machines' sessions.
      - --disable/--enable persist a machine-local switch (~/.agents/.history) that gates the
        daemon's automatic sync; a bare 'agents sessions sync' still forces a manual cycle.
        The AGENTS_SESSIONS_SYNC env var (on/off) overrides the switch for one invocation.
    `,
  });

  // `--json` is also declared on the parent `sessions` command, so a bare
  // `options` arg would miss it (Commander binds the shared flag to the parent).
  // optsWithGlobals() merges ancestor + local options so --json resolves here.
  syncCmd.action(async (_options: SyncCmdOptions, cmd: Command) => {
    await runSessionsSync(cmd.optsWithGlobals() as SyncCmdOptions);
  });
}
