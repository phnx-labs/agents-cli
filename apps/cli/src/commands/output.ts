/**
 * Output command — productivity: token *burn* vs shipped *output*.
 *
 * `agents cost` answers "what did we burn?" (dollars + duration). This joins that
 * burn to what actually shipped — real generated (output) tokens plus PRs and
 * commits across every git identity — so you can see burn-vs-output and ratios
 * like $/PR and output-tokens/$. Pure SQLite + local git/gh, no server, no
 * telemetry — the same offline spirit as `cost`.
 *
 * Why not just show `token_count`? Because that number sums cache-read/-write
 * context re-counted every turn and is dominated by cheap re-reads (often ~100x
 * the real generation). `output_tokens` (scanned per-agent into the session DB)
 * is the honest "work produced" signal, and it is what this command leads with.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';

import { addHostOption } from '../lib/hosts/option.js';
import { discoverSessions, parseTimeFilter } from '../lib/session/discover.js';
import { queryUsageRollup, type UsageRollupGroup, type QueryOptions } from '../lib/session/db.js';
import { formatUsd, PRICING_VERSION } from '../lib/pricing/index.js';
import { formatDuration } from '../lib/session/render.js';
import { terminalWidth, truncateToWidth, padToWidth } from '../lib/session/width.js';
import { collectGitOutput, type GitOutputSummary } from '../lib/output/git-output.js';

interface OutputOptions {
  json?: boolean;
  since?: string;
  by?: string;
  reposDir?: string;
  author?: string[];
  login?: string[];
  prs?: boolean; // commander sets `prs: false` for --no-prs
}

export function registerOutputCommand(program: Command): void {
  addHostOption(program.command('output'))
    .description('Productivity rollup — token burn vs shipped output (PRs, commits) across agents')
    .option('--json', 'Output the rollup as JSON')
    .option('--since <time>', 'Only sessions/commits newer than this (default 7d)')
    .option('--by <dimension>', 'Group the burn/output breakdown by: agent (default), project, or day')
    .option('--repos-dir <dir>', 'Root scanned for git repos (default ~/src)')
    .option('--author <email...>', 'Count commits by these author emails (default: your git identities)')
    .option('--login <login...>', 'Count PRs for these GitHub logins (default: current gh user)')
    .option('--no-prs', 'Skip the GitHub PR lookup (commits only)')
    .addHelpText('after', `
Examples:
  agents output                       Last 7 days: burn, output tokens, PRs, commits, ratios
  agents output --since 30d           Last 30 days
  agents output --by day --json       Machine-readable daily burn/output rollup
  agents output --repos-dir ~/work    Scan a different repo root for commits
  agents output --login me --login alt-account   Count PRs across multiple accounts

Burn (cost) is computed offline from a versioned per-model price table (${PRICING_VERSION}).
Output tokens are the real generated tokens — NOT the cache-inflated total token count.
`)
    .action(async (options: OutputOptions) => {
      await outputAction(options);
    });
}

function resolveGroup(by: string | undefined): UsageRollupGroup {
  if (by === undefined) return 'agent';
  if (by === 'agent' || by === 'project' || by === 'day') return by;
  console.error(chalk.red('error: --by must be one of: agent, project, day'));
  process.exit(1);
}

/** Compact token formatter: 38.6M, 4.1K, 10.6B. */
function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

async function outputAction(options: OutputOptions): Promise<void> {
  const since = options.since ?? '7d';
  const sinceMs = parseTimeFilter(since);

  // Ensure the index is fresh (and migrated to v12 so output_tokens is populated)
  // before we read the rollup.
  await discoverSessions({ all: true, since, limit: 1 });

  const filter: QueryOptions = { sinceMs };
  const groupBy = resolveGroup(options.by);
  const breakdown = queryUsageRollup({ ...filter, groupBy });

  const totals = breakdown.reduce(
    (acc, r) => {
      acc.costUsd += r.costUsd;
      acc.outputTokens += r.outputTokens;
      acc.tokenCount += r.tokenCount;
      acc.sessionCount += r.sessionCount;
      acc.durationMs += r.durationMs;
      return acc;
    },
    { costUsd: 0, outputTokens: 0, tokenCount: 0, sessionCount: 0, durationMs: 0 },
  );

  const reposDir = options.reposDir ?? path.join(os.homedir(), 'src');
  const git = await collectGitOutput({
    reposDir,
    sinceMs,
    authors: options.author,
    logins: options.login,
    includePrs: options.prs !== false,
  });

  const prsTotal = git.prsOpened + git.prsMerged;
  const ratios = {
    costPerPr: prsTotal > 0 ? totals.costUsd / prsTotal : null,
    costPerCommit: git.commits > 0 ? totals.costUsd / git.commits : null,
    outputTokensPerUsd: totals.costUsd > 0 ? totals.outputTokens / totals.costUsd : null,
  };

  // Agents whose CLIs record no cost — surfaced so the burn number stays honest.
  const uncosted = breakdown.filter(r => groupBy === 'agent' && r.costUsd === 0).map(r => r.key);

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          pricingVersion: PRICING_VERSION,
          since,
          burn: {
            costUsd: totals.costUsd,
            outputTokens: totals.outputTokens,
            tokenCount: totals.tokenCount,
            sessionCount: totals.sessionCount,
            durationMs: totals.durationMs,
          },
          output: {
            commits: git.commits,
            prsOpened: git.prsOpened,
            prsMerged: git.prsMerged,
            reposScanned: git.reposScanned,
            byAuthor: git.byAuthor,
            authors: git.authors,
            logins: git.logins,
            ghAvailable: git.ghAvailable,
          },
          ratios,
          breakdown: { by: groupBy, rows: breakdown },
          notCounted: {
            uncostedAgents: uncosted,
            ghAvailable: git.ghAvailable,
            note: 'Cloud runs (Rush/Codex/Factory) and unreachable machines are not included; run with --host <name> per machine.',
          },
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const out: string[] = [];
  out.push(chalk.bold('Output') + chalk.gray(`  ·  pricing ${PRICING_VERSION}  ·  since ${since}`));
  out.push(
    '  ' +
      `${chalk.green(formatUsd(totals.costUsd))} burned` +
      chalk.gray('  ·  ') +
      `${chalk.cyan(formatCompact(totals.outputTokens))} output tokens` +
      chalk.gray('  ·  ') +
      `${chalk.yellow(String(prsTotal))} PRs ${chalk.gray(`(${git.prsMerged} merged)`)}` +
      chalk.gray('  ·  ') +
      `${chalk.yellow(String(git.commits))} commits`,
  );
  // Burn-vs-output ratios.
  const ratioParts: string[] = [];
  if (ratios.costPerPr !== null) ratioParts.push(`${formatUsd(ratios.costPerPr)}/PR`);
  if (ratios.costPerCommit !== null) ratioParts.push(`${formatUsd(ratios.costPerCommit)}/commit`);
  if (ratios.outputTokensPerUsd !== null) ratioParts.push(`${formatCompact(Math.round(ratios.outputTokensPerUsd))} out-tok/$`);
  if (ratioParts.length > 0) out.push(chalk.gray('  ' + ratioParts.join('  ·  ')));
  out.push('');

  if (totals.sessionCount === 0) {
    out.push(chalk.gray('No sessions with cost data found. Run `agents sessions --all` to index, then retry.'));
    console.log(out.join('\n'));
    return;
  }

  // Burn/output breakdown table.
  const groupLabel = groupBy;
  out.push(chalk.bold(`By ${groupLabel}`));
  const cols = terminalWidth();
  const burnW = Math.max(...breakdown.map(r => formatUsd(r.costUsd).length), 4);
  const outW = Math.max(...breakdown.map(r => formatCompact(r.outputTokens).length), 6);
  const sessW = Math.max(...breakdown.map(r => String(r.sessionCount).length), 3);
  const fixedW = 2 + 2 + burnW + 2 + outW + 2 + sessW + 8;
  const keyW = Math.max(8, Math.min(Math.max(...breakdown.map(r => r.key.length), groupLabel.length), cols - fixedW));
  out.push(
    '  ' +
      chalk.gray(padToWidth('', keyW)) +
      '  ' +
      chalk.gray(padToWidth('burn', burnW)) +
      '  ' +
      chalk.gray(padToWidth('output', outW)) +
      '  ' +
      chalk.gray('sessions'),
  );
  for (const r of breakdown) {
    out.push(
      '  ' +
        padToWidth(truncateToWidth(r.key, keyW), keyW) +
        '  ' +
        chalk.green(padToWidth(formatUsd(r.costUsd), burnW)) +
        '  ' +
        chalk.cyan(padToWidth(formatCompact(r.outputTokens), outW)) +
        '  ' +
        chalk.gray(padToWidth(String(r.sessionCount), sessW)),
    );
  }
  out.push('');

  // Shipped-work detail.
  out.push(chalk.bold('Shipped'));
  out.push(
    `  ${chalk.yellow(String(git.commits))} commits across ${git.reposScanned} repos` +
      chalk.gray(`  (authors: ${git.authors.length > 0 ? git.authors.join(', ') : 'none detected'})`),
  );
  if (git.ghAvailable) {
    out.push(
      `  ${chalk.yellow(String(git.prsOpened))} PRs opened, ${chalk.yellow(String(git.prsMerged))} merged` +
        chalk.gray(`  (logins: ${git.logins.join(', ')})`),
    );
  } else {
    out.push(chalk.gray('  PRs: gh unavailable or unauthed — not counted'));
  }
  out.push('');

  // Honesty footer.
  const notes: string[] = [];
  if (uncosted.length > 0) notes.push(`no price table for: ${uncosted.join(', ')} (burn undercounts)`);
  notes.push('cloud runs (Rush/Codex/Factory) and unreachable machines not counted — use --host <name> per machine');
  out.push(chalk.gray('not counted: ' + notes.join('  ·  ')));
  if (totals.durationMs > 0) out.push(chalk.gray(`agent wall-clock: ${formatDuration(totals.durationMs)}`));

  console.log(out.join('\n'));
}
