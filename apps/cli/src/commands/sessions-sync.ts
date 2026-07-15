/**
 * `agents sessions sync` — push this machine's transcripts to R2 and pull every
 * other machine's, merging copies of the same session via CRDT union. The local
 * sessions index is rebuilt from the synced-in mirror by the normal scanner.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { isSyncConfigured, SYNC_BUNDLE } from '../lib/session/sync/config.js';
import { isBetaEnabled, setBetaEnabled, betaEnableHint } from '../lib/beta.js';
import { syncSessions } from '../lib/session/sync/sync.js';

/** The daemon's automatic session sync is gated by this beta feature. */
const SYNC_BETA = 'session-sync' as const;

interface SyncCmdOptions {
  verbose?: boolean;
  json?: boolean;
  enable?: boolean;
  disable?: boolean;
  status?: boolean;
}

export async function runSessionsSync(options: SyncCmdOptions): Promise<void> {
  // Toggle / status delegate to the `session-sync` beta feature — the single
  // source of truth for whether the daemon auto-syncs (opt-in, off by default).
  // These short-circuit before any network cycle.
  if (options.disable) {
    setBetaEnabled([SYNC_BETA], false);
    console.log(
      chalk.yellow('Automatic session sync disabled') +
      chalk.dim(' — the daemon stops pushing/pulling within ~90s. (Same as: agents beta disable session-sync)'),
    );
    return;
  }
  if (options.enable) {
    setBetaEnabled([SYNC_BETA], true);
    console.log(
      chalk.green('Automatic session sync enabled') +
      chalk.dim(' — the daemon resumes on its next cycle. (Same as: agents beta enable session-sync)'),
    );
    return;
  }
  if (options.status) {
    const enabled = isBetaEnabled(SYNC_BETA);
    const configured = isSyncConfigured();
    if (options.json) {
      console.log(JSON.stringify({ enabled, configured }, null, 2));
    } else {
      console.log(
        `automatic sync: ${enabled ? chalk.green('enabled (beta)') : chalk.yellow('disabled')}` +
        chalk.dim('  ·  ') +
        `credentials: ${configured ? chalk.green('configured') : chalk.yellow(`missing (${SYNC_BUNDLE})`)}`,
      );
      if (!enabled) console.log(chalk.dim(`  ${betaEnableHint(SYNC_BETA)}`));
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

    if (!options.json && result.warnings.length > 0) {
      for (const w of result.warnings) console.error(chalk.yellow(`  warning: ${w}`));
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
    .description('Sync session transcripts across machines via R2 (CRDT merge). Claude, Codex, Droid, Grok, Kimi, and OpenCode.')
    .option('-v, --verbose', 'Log each pushed and pulled session')
    .option('--json', 'Output the sync result as JSON')
    .option('--enable', 'Opt in to automatic background sync (beta; alias for: agents beta enable session-sync)')
    .option('--disable', 'Opt out of automatic background sync (alias for: agents beta disable session-sync)')
    .option('--status', 'Show whether automatic sync is opted-in (beta) and configured');

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
      - Sessions present locally always win; synced-in copies fill in other machines' sessions.
      - Automatic background sync is an opt-in BETA feature, OFF by default. The daemon only
        syncs (~90s) once you opt in via 'agents beta enable session-sync' (or the --enable
        alias here). A bare 'agents sessions sync' always forces a manual one-shot cycle
        regardless of the beta opt-in.
    `,
  });

  // `--json` is also declared on the parent `sessions` command, so a bare
  // `options` arg would miss it (Commander binds the shared flag to the parent).
  // optsWithGlobals() merges ancestor + local options so --json resolves here.
  syncCmd.action(async (_options: SyncCmdOptions, cmd: Command) => {
    await runSessionsSync(cmd.optsWithGlobals() as SyncCmdOptions);
  });
}
