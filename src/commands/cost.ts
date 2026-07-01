/**
 * Cost command — roll up $ spend and wall-clock duration across the local,
 * cross-agent session index.
 *
 * This is the read side of issue #323. Cost and duration are computed and
 * persisted at scan time (see src/lib/session/discover.ts + db.ts); this
 * command only queries and renders them — a pure SQLite/CLI win, no server,
 * no telemetry. Distinct from `agents usage`, which reports live rate-limit /
 * quota status per agent and is left untouched.
 */
import type { Command } from 'commander';
import { addHostOption } from '../lib/hosts/option.js';
import chalk from 'chalk';

import { discoverSessions, parseTimeFilter } from '../lib/session/discover.js';
import {
  queryUsageRollup,
  topSessionsByCost,
  type UsageRollupGroup,
  type QueryOptions,
} from '../lib/session/db.js';
import { formatUsd, PRICING_VERSION } from '../lib/pricing/index.js';
import { formatDuration } from '../lib/session/render.js';

interface CostOptions {
  json?: boolean;
  since?: string;
  by?: string;
}

export function registerCostCommand(program: Command): void {
  addHostOption(program.command('cost'))
    .description('Roll up $ cost and duration across local agent sessions')
    .option('--json', 'Output the rollup as JSON')
    .option('--since <time>', 'Only sessions newer than this (e.g., 7d, 4w, or ISO date)')
    .option('--by <dimension>', 'Group the breakdown by: agent (default), project, or day')
    .addHelpText('after', `
Examples:
  agents cost                   Daily histogram + top sessions + per-agent breakdown
  agents cost --since 30d       Last 30 days only
  agents cost --by project      Break down by project instead of agent
  agents cost --by day --json   Machine-readable daily rollup

Cost is computed offline from a versioned per-model price table (${PRICING_VERSION}).
`)
    .action(async (options: CostOptions) => {
      await costAction(options);
    });
}

/** Map the --by flag to a rollup group, rejecting unknown values. */
function resolveGroup(by: string | undefined): UsageRollupGroup {
  if (by === undefined) return 'agent';
  if (by === 'agent' || by === 'project' || by === 'day') return by;
  console.error(chalk.red('error: --by must be one of: agent, project, day'));
  process.exit(1);
}

async function costAction(options: CostOptions): Promise<void> {
  const sinceMs = options.since ? parseTimeFilter(options.since) : undefined;

  // Ensure the index is fresh (and migrated to v6) before we read costs.
  await discoverSessions({ all: true, since: options.since, limit: 1 });

  const filter: QueryOptions = {};
  if (typeof sinceMs === 'number') filter.sinceMs = sinceMs;

  const groupBy = resolveGroup(options.by);

  const daily = queryUsageRollup({ ...filter, groupBy: 'day' });
  const breakdown = queryUsageRollup({ ...filter, groupBy });
  const top = topSessionsByCost(10, filter);

  const totalCost = breakdown.reduce((s, r) => s + r.costUsd, 0);
  const totalSessions = breakdown.reduce((s, r) => s + r.sessionCount, 0);
  const totalDuration = breakdown.reduce((s, r) => s + r.durationMs, 0);

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          pricingVersion: PRICING_VERSION,
          since: options.since ?? null,
          totals: { costUsd: totalCost, sessionCount: totalSessions, durationMs: totalDuration },
          daily,
          breakdown: { by: groupBy, rows: breakdown },
          topSessions: top.map(t => ({
            id: t.meta.id,
            shortId: t.meta.shortId,
            agent: t.meta.agent,
            project: t.meta.project ?? null,
            topic: t.meta.topic ?? t.meta.label ?? null,
            costUsd: t.costUsd,
            durationMs: t.durationMs,
            timestamp: t.meta.timestamp,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (totalSessions === 0) {
    console.log(chalk.gray('No sessions with cost data found. Run `agents sessions --all` to index, then retry.'));
    return;
  }

  const out: string[] = [];

  out.push(chalk.bold('Cost') + chalk.gray(`  ·  pricing ${PRICING_VERSION}${options.since ? `  ·  since ${options.since}` : ''}`));
  out.push(
    `  ${chalk.green(formatUsd(totalCost))} across ${totalSessions} session${totalSessions !== 1 ? 's' : ''}` +
      (totalDuration > 0 ? chalk.gray(`  ·  ${formatDuration(totalDuration)} total`) : ''),
  );
  out.push('');

  // Daily histogram (unicode block sparkline, zero deps).
  if (daily.length > 0) {
    out.push(chalk.bold('Daily'));
    out.push(renderDailyHistogram(daily));
    out.push('');
  }

  // Top sessions by cost.
  if (top.length > 0) {
    out.push(chalk.bold('Top sessions by cost'));
    const costW = Math.max(...top.map(t => formatUsd(t.costUsd).length), 4);
    for (const t of top) {
      const cost = formatUsd(t.costUsd).padStart(costW);
      const dur = t.durationMs > 0 ? formatDuration(t.durationMs) : '—';
      const label = t.meta.label || t.meta.topic || '(untitled)';
      const proj = t.meta.project ? chalk.gray(` ${t.meta.project}`) : '';
      out.push(
        `  ${chalk.green(cost)}  ${chalk.gray(t.meta.shortId)}  ${chalk.cyan(t.meta.agent.padEnd(7))} ${truncate(label, 48)}` +
          proj +
          chalk.gray(`  ${dur}`),
      );
    }
    out.push('');
  }

  // Per-agent / per-project / per-day breakdown.
  const groupLabel = groupBy === 'agent' ? 'agent' : groupBy === 'project' ? 'project' : 'day';
  out.push(chalk.bold(`By ${groupLabel}`));
  const keyW = Math.max(...breakdown.map(r => r.key.length), groupLabel.length);
  const costW2 = Math.max(...breakdown.map(r => formatUsd(r.costUsd).length), 4);
  for (const r of breakdown) {
    const cost = formatUsd(r.costUsd).padStart(costW2);
    const dur = r.durationMs > 0 ? formatDuration(r.durationMs) : '—';
    out.push(
      `  ${r.key.padEnd(keyW)}  ${chalk.green(cost)}  ${chalk.gray(`${r.sessionCount} session${r.sessionCount !== 1 ? 's' : ''}`)}  ${chalk.gray(dur)}`,
    );
  }

  console.log(out.join('\n'));
}

/** Eight levels of vertical block characters for sparkline rendering. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Render a per-day cost histogram as a unicode sparkline plus a labeled list. */
function renderDailyHistogram(daily: Array<{ key: string; costUsd: number }>): string {
  // Daily comes back cost-desc; show it chronologically for the sparkline.
  const sorted = [...daily].sort((a, b) => a.key.localeCompare(b.key));
  const max = Math.max(...sorted.map(d => d.costUsd), 0);
  const spark = sorted
    .map(d => {
      if (max <= 0 || d.costUsd <= 0) return BLOCKS[0];
      const idx = Math.min(BLOCKS.length - 1, Math.round((d.costUsd / max) * (BLOCKS.length - 1)));
      return BLOCKS[idx];
    })
    .join('');

  const lines: string[] = [`  ${chalk.green(spark)}`];
  // Show the most expensive days as a short list under the sparkline.
  const topDays = [...daily].slice(0, 7);
  const costW = Math.max(...topDays.map(d => formatUsd(d.costUsd).length), 4);
  for (const d of topDays) {
    lines.push(`  ${chalk.gray(d.key)}  ${chalk.green(formatUsd(d.costUsd).padStart(costW))}`);
  }
  return lines.join('\n');
}

/** Truncate a string to n chars with an ellipsis. */
function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}
