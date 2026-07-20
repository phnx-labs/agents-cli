/**
 * `agents status` — the unified sync-status surface.
 *
 * One command that answers "is my fleet in sync?" the same way every other
 * surface does, because it reads the same engine (computeSyncStatus). Human mode
 * renders the summary and, when a TTY finds drift, offers the interactive
 * "sync now?" flow (promptDriftSync). `--json` emits the stable UnifiedSyncStatus
 * contract the menu-bar and Agency consume. `--yes` reconciles everything with no
 * prompts (the "kick it" path, safe in scripts).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS } from '../lib/agents.js';
import { AgentId } from '../lib/types.js';
import { setHelpSections } from '../lib/help.js';
import { computeSyncStatus, type AgentVersionStatus } from '../lib/sync-status.js';
import { promptDriftSync } from '../lib/drift-sync.js';
import { resolveSurface } from './utils.js';

interface StatusOptions {
  json?: boolean;
  yes?: boolean;
  cwd?: string;
}

const agentName = (id: AgentId): string => AGENTS[id]?.name ?? id;

function versionSummary(v: AgentVersionStatus): string {
  if (!v.everSynced) return chalk.gray('never synced');
  if (v.needsSync) {
    const bits: string[] = [];
    if (v.counts.drifted) bits.push(`${v.counts.drifted} drifted`);
    if (v.counts.missing) bits.push(`${v.counts.missing} missing`);
    return chalk.yellow(bits.join(' · '));
  }
  return chalk.green('in sync');
}

export function registerStatusCommand(program: Command): void {
  const cmd = program
    .command('status')
    .description('Unified sync status across the fleet — what is drifted, missing, or behind, with an option to sync it.')
    .option('--json', 'Output the machine-readable UnifiedSyncStatus contract')
    .option('--yes', 'Reconcile everything detected (pull .system if behind + sync drifted/missing resources) without prompting')
    .option('--cwd <path>', 'Resolution cwd for project layer detection (default: process.cwd())');

  setHelpSections(cmd, {
    examples: `
      # Show what's out of sync; offer to fix it (interactive)
      agents status

      # Machine-readable status for the menu-bar / Agency
      agents status --json

      # Reconcile everything with no prompts (CI / scripts / the "kick it" path)
      agents status --yes
    `,
  });

  cmd.action(async (opts: StatusOptions, command: Command) => {
    // Centralized surface read (the human/agent split in one place). Note we still
    // pass the *raw* `opts.yes` to promptDriftSync below — it distinguishes an
    // explicit `--yes` (act) from a non-TTY shell (report only), so `surface.assumeYes`
    // (which conflates the two) would wrongly auto-reconcile in a plain pipe.
    const surface = resolveSurface(command);
    const cwd = opts.cwd ?? process.cwd();

    if (surface.json) {
      const status = await computeSyncStatus({ cwd });
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    const status = await computeSyncStatus({ cwd });

    // Human summary header (always) — the per-version readout.
    console.log(chalk.bold('Fleet sync status'));
    if (status.system.unknown) {
      console.log(`  ${'.system repo'.padEnd(28)} ${chalk.gray('freshness unknown (no upstream)')}`);
    } else if (status.system.behind > 0) {
      console.log(
        `  ${'.system repo'.padEnd(28)} ${chalk.yellow(`${status.system.behind} behind`)}`,
      );
    } else {
      console.log(`  ${'.system repo'.padEnd(28)} ${chalk.green('up to date')}`);
    }
    if (status.agents.length === 0) {
      console.log(chalk.gray('  (no installed agent versions)'));
    }
    for (const v of status.agents) {
      const label = `${agentName(v.agent)}@${v.version}${v.isDefault ? chalk.gray(' (default)') : ''}`;
      console.log(`  ${label.padEnd(28)} ${versionSummary(v)}`);
    }
    if (status.totals.orphan > 0) {
      console.log(
        chalk.gray(`  (${status.totals.orphan} orphan${status.totals.orphan === 1 ? '' : 's'} — run \`agents prune cleanup\`)`),
      );
    }

    // Hand off to the shared interactive/apply flow (summary already printed above).
    await promptDriftSync({ cwd, yes: opts.yes, status, quiet: true });
  });
}
