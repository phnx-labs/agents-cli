import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { syncTraces } from '../lib/traces/sync.js';
import { readSyncLedger } from '../lib/traces/sync.js';
import { managedTracesBaseUrl, resolveTracesBackend } from '../lib/traces/backend.js';
import { showUrl } from '../lib/open-url.js';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const SYNC_EXAMPLES = `
  $ agents traces sync
  Push this device's derived, redacted trajectories to your Phoenix account.

  $ agents traces sync --limit 20
  Sync at most 20 sessions (useful for a first run on a large fleet device).
`.trimStart();

const SYNC_NOTES = `
  Reads from the local sessions.db, computes a derived SessionTrajectory (steps +
  gaps + stats, no raw transcript text), redacts secrets, and PUTs each to
  the agents-traces store.

  An incremental gate (traces-sync.json ledger) means re-runs only upload
  sessions whose file_mtime_ms changed since the last sync.

  Sign in first with: agents auth login
`.trimStart();

const STATUS_EXAMPLES = `
  $ agents traces status
  Show what's been synced — session count and last sync time for this device.
`.trimStart();

const OPEN_EXAMPLES = `
  $ agents traces open
  Open the Phoenix Evals console for your account.
`.trimStart();

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSync(opts: { limit?: string }): Promise<void> {
  const limit = opts.limit !== undefined ? parseInt(opts.limit, 10) : undefined;

  // Validate backend connectivity (throws with a user-friendly message if not signed in)
  try {
    resolveTracesBackend();
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.dim('Syncing traces…'));

  let result;
  try {
    result = await syncTraces({ limit });
  } catch (err) {
    console.error(chalk.red(`Sync failed: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }

  const parts: string[] = [];
  if (result.uploaded > 0) {
    parts.push(chalk.green(`${result.uploaded} uploaded`));
  }
  if (result.skipped > 0) {
    parts.push(chalk.dim(`${result.skipped} skipped`));
  }
  if (result.errors > 0) {
    parts.push(chalk.yellow(`${result.errors} errors`));
  }
  if (parts.length === 0) {
    parts.push(chalk.dim('nothing new'));
  }

  console.log(parts.join(chalk.dim('  ·  ')));
}

async function handleStatus(): Promise<void> {
  const ledger = readSyncLedger();

  if (!ledger.lastSyncMtime) {
    console.log(chalk.dim('No sync recorded on this device. Run: agents traces sync'));
    return;
  }

  const when = new Date(ledger.lastSyncMtime).toLocaleString();
  console.log(`Last sync: ${chalk.bold(when)}`);
  console.log(chalk.dim('Run `agents traces sync` to push new sessions.'));
}

async function handleOpen(): Promise<void> {
  // M2 console — for now open the base URL which will route to the console once deployed.
  const url = managedTracesBaseUrl();
  console.log(chalk.dim(`Opening ${url}`));
  const outcome = await showUrl(url);
  if (outcome.via === 'none') {
    console.log(url);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTracesCommands(program: Command): void {
  const tracesCmd = program
    .command('traces')
    .description("Sync this device's derived, redacted trajectories to your Phoenix account");

  // sync
  const syncCmd = tracesCmd
    .command('sync')
    .description('Push derived, redacted trajectories (incremental)')
    .option('--limit <n>', 'Maximum number of sessions to sync in this run')
    .action(handleSync);

  setHelpSections(syncCmd, { examples: SYNC_EXAMPLES, notes: SYNC_NOTES });

  // status
  const statusCmd = tracesCmd
    .command('status')
    .description('Show last sync time for this device')
    .action(handleStatus);

  setHelpSections(statusCmd, { examples: STATUS_EXAMPLES });

  // open
  const openCmd = tracesCmd
    .command('open')
    .description('Open the Phoenix Evals console')
    .action(handleOpen);

  setHelpSections(openCmd, { examples: OPEN_EXAMPLES });
}
