/**
 * `agents activity` -- the agent-activity lane: a running stream of what agents
 * DID (plan created, PR opened, worktree created, sub-agent spawned, files
 * edited), read from the append-only per-session activity logs.
 *
 * Complements `agents feed` (what agents are WAITING on). Events are emitted at
 * hook time by 11-activity-log.py, so this reader never re-parses transcripts --
 * it tails the logs and collapses routine work to counts, surfacing milestones
 * individually and newest-first.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  collapseActivity,
  ensureActivityLogHook,
  formatActivityLine,
  readRecentActivity,
  styleForEvent,
  tierForEvent,
} from '../lib/activity.js';

/** Wire the activity-log hooks into each hooks-capable version's settings. */
async function installActivityHooks(): Promise<string[]> {
  const warnings: string[] = [];
  const hookInstall = ensureActivityLogHook();
  if (hookInstall.error) {
    warnings.push(hookInstall.error);
    return warnings;
  }
  const [{ iterHooksCapableVersions, parseHookManifest, registerHooksToSettings }, { getVersionHomePath }] = await Promise.all([
    import('../lib/hooks.js'),
    import('../lib/versions.js'),
  ]);
  const manifest = parseHookManifest({ warn: false });
  for (const { agent, version } of iterHooksCapableVersions({ agent: 'claude' })) {
    const result = registerHooksToSettings(agent, getVersionHomePath(agent, version), manifest);
    if (result.errors.length > 0) warnings.push(`${agent}@${version}: ${result.errors.join('; ')}`);
  }
  return warnings;
}

export function registerActivityCommand(program: Command): void {
  program
    .command('activity')
    .description('Recent agent activity -- plans, PRs, worktrees, sub-agents (newest first)')
    .option('--json', 'Emit the raw event list as JSON')
    .option('--all', 'Include routine activity (file edits) inline, not collapsed')
    .option('--milestones', 'Only milestone events (plans, PRs, worktrees, sub-agents)')
    .option('-n, --limit <n>', 'Cap the number of events shown', (v) => parseInt(v, 10), 40)
    .option('--since <minutes>', 'Only events within the last N minutes', (v) => parseInt(v, 10))
    .action(async (opts: { json?: boolean; all?: boolean; milestones?: boolean; limit: number; since?: number }) => {
      const warnings = await installActivityHooks();

      const sinceMs = typeof opts.since === 'number' && opts.since > 0
        ? Date.now() - opts.since * 60_000
        : undefined;
      let events = readRecentActivity({ sinceMs, limit: opts.limit });
      if (opts.milestones) events = events.filter((e) => tierForEvent(e.event) === 'milestone');

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
        return;
      }

      for (const w of warnings) process.stderr.write(chalk.yellow(`  ! ${w}\n`));

      if (events.length === 0) {
        process.stdout.write(chalk.gray('No recent agent activity. Events appear here as agents create plans, open PRs, and spawn sub-agents.\n'));
        return;
      }

      const { milestones, counts, subagentCount } = collapseActivity(events);

      process.stdout.write(chalk.bold('\n  recent activity\n'));
      const shown = opts.all ? events : milestones;
      for (const ev of shown) process.stdout.write(`${formatActivityLine(ev, { showHost: true })}\n`);

      if (!opts.all) {
        const parts = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([event, n]) => `${styleForEvent(event).label} ×${n}`);
        if (parts.length > 0) {
          process.stdout.write(chalk.gray(`\n  · ${parts.join('  ')}\n`));
        }
      }
      if (subagentCount > 0) {
        process.stdout.write(chalk.magenta(`\n  ⑂ ${subagentCount} sub-agent${subagentCount === 1 ? '' : 's'} spawned\n`));
      }
      process.stdout.write('\n');
    });
}
