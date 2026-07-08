/**
 * `agents check` — scriptable drift gate for CI.
 *
 * Runs the SAME drift/divergence diagnostic `agents doctor` computes (via the
 * shared `computeDrift` in `../lib/drift.js`) and turns it into an exit code:
 * non-zero when any installed version is stale or never-synced, zero when the
 * whole install is fresh. `agents doctor` is the human report; `agents check`
 * is the machine gate — same engine, different output.
 *
 * Orphans are surfaced informationally but never fail the check: they are a
 * `prune` concern, not sync drift (mirrors the sync-status engine, where an
 * orphan alone never flags needsSync).
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS, ALL_AGENT_IDS } from '../lib/agents.js';
import { setHelpSections } from '../lib/help.js';
import { computeDrift, type SyncStatusRow } from '../lib/drift.js';

const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  ALL_AGENT_IDS.map((id) => [id, AGENTS[id].name]),
);

interface CheckOptions {
  json?: boolean;
  quiet?: boolean;
  cwd?: string;
}

function label(row: SyncStatusRow): string {
  return `${AGENT_NAMES[row.agent] || row.agent}@${row.version}`;
}

export function registerCheckCommand(program: Command): void {
  const checkCmd = program
    .command('check')
    .description('CI drift gate: exit non-zero when any installed version is out of sync (stale or never-synced), zero when clean.')
    .option('--json', 'Output machine-readable JSON')
    .option('-q, --quiet', 'Suppress per-version lines; print only the one-line verdict')
    .option('--cwd <path>', 'Resolution cwd for project layer detection (default: process.cwd())');

  setHelpSections(checkCmd, {
    examples: `
      # Fail the build if anything drifted (exit 1), pass if clean (exit 0)
      agents check

      # Just the verdict line, nothing per-version
      agents check --quiet

      # Machine-readable, for scripting
      agents check --json

      # Gate in a CI step
      agents check || { echo "resources drifted — run 'agents doctor --fix'"; exit 1; }
    `,
  });

  checkCmd.action((opts: CheckOptions) => {
    const cwd = opts.cwd ? opts.cwd : process.cwd();
    const drift = computeDrift(cwd);

    if (opts.json) {
      console.log(JSON.stringify({
        hasDrift: drift.hasDrift,
        stale: drift.staleCount,
        neverSynced: drift.neverSyncedCount,
        orphanVersions: drift.orphanVersionCount,
        versions: drift.syncRows.map((r) => ({
          agent: r.agent,
          version: r.version,
          status: r.status,
          isDefault: r.isDefault,
          divergence: r.divergence ?? [],
        })),
      }, null, 2));
      process.exit(drift.hasDrift ? 1 : 0);
    }

    if (drift.syncRows.length === 0) {
      // Nothing installed is a clean state, not a failure — CI on a fresh
      // checkout with no versions should pass, not error.
      console.log(chalk.gray('check: no installed versions — nothing to verify'));
      process.exit(0);
    }

    if (!drift.hasDrift) {
      const orphanNote = drift.orphanVersionCount > 0
        ? chalk.gray(` (${drift.orphanVersionCount} version(s) carry orphans — run \`agents prune cleanup\`)`)
        : '';
      console.log(`${chalk.green('ok')}  ${drift.syncRows.length} version(s) in sync${orphanNote}`);
      process.exit(0);
    }

    // Drift: one-line verdict always, per-version detail unless --quiet.
    const parts: string[] = [];
    if (drift.staleCount > 0) parts.push(`${drift.staleCount} stale`);
    if (drift.neverSyncedCount > 0) parts.push(`${drift.neverSyncedCount} never-synced`);
    console.error(`${chalk.red('drift')}  ${parts.join(', ')} of ${drift.syncRows.length} version(s)`);

    if (!opts.quiet) {
      for (const row of drift.syncRows) {
        if (row.status === 'fresh') continue;
        const tag = row.status === 'stale' ? chalk.yellow('stale') : chalk.gray('cold ');
        console.error(`  ${tag}  ${label(row)}`);
        for (const line of row.divergence ?? []) {
          console.error(chalk.gray(`           ${line}`));
        }
      }
      console.error(chalk.gray('\nReconcile with `agents doctor --fix` (or `agents doctor <agent>@<version> --fix`).'));
    }

    process.exit(1);
  });
}
