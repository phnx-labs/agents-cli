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
 *
 * `--all-hosts` fans the same rollup across every online device (`ag devices`)
 * over SSH and merges — one fleet-wide burn-vs-output view.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { addHostOption } from '../lib/hosts/option.js';
import { discoverSessions, parseTimeFilter } from '../lib/session/discover.js';
import { queryUsageRollup, type UsageRollupGroup, type QueryOptions } from '../lib/session/db.js';
import { formatUsd, PRICING_VERSION } from '../lib/pricing/index.js';
import { formatDuration } from '../lib/session/render.js';
import { terminalWidth, truncateToWidth, padToWidth } from '../lib/session/width.js';
import { collectGitOutput } from '../lib/output/git-output.js';
import { loadDevices } from '../lib/devices/registry.js';
import { machineId } from '../lib/session/sync/config.js';

const execFileAsync = promisify(execFile);

interface OutputOptions {
  json?: boolean;
  since?: string;
  by?: string;
  reposDir?: string;
  author?: string[];
  login?: string[];
  prs?: boolean; // commander sets `prs: false` for --no-prs
  allHosts?: boolean;
}

interface RollupRow {
  key: string;
  costUsd: number;
  durationMs: number;
  sessionCount: number;
  tokenCount: number;
  outputTokens: number;
}

interface BurnTotals {
  costUsd: number;
  outputTokens: number;
  tokenCount: number;
  sessionCount: number;
  durationMs: number;
}

interface GitOut {
  commits: number;
  /** Deduped commit SHAs — unioned across machines under --all-hosts. */
  commitShas: string[];
  prsOpened: number;
  prsMerged: number;
  reposScanned: number;
  ghAvailable: boolean;
  authors: string[];
  logins: string[];
}

/** One machine's productivity payload — the `--json` shape, reused across the fleet. */
interface OutputPayload {
  machine: string;
  pricingVersion: string;
  since: string;
  burn: BurnTotals;
  output: GitOut;
  breakdown: { by: string; rows: RollupRow[] };
  uncostedAgents: string[];
  /** Set when a remote machine could not be reached / did not support the command. */
  error?: string;
}

export function registerOutputCommand(program: Command): void {
  addHostOption(program.command('output'))
    .description('Productivity rollup — token burn vs shipped output (PRs, commits) across agents')
    .option('--json', 'Output the rollup as JSON')
    .option('--since <time>', 'Only sessions/commits newer than this: 1h, 24h, 7d, 4w, 1mo, 1y, or ISO date (default 7d)')
    .option('--by <dimension>', 'Group the burn/output breakdown by: agent (default), project, or day')
    .option('--repos-dir <dir>', 'Root scanned for git repos (default ~/src)')
    .option('--author <email...>', 'Count commits by these author emails (default: your git identities)')
    .option('--login <login...>', 'Count PRs for these GitHub logins (default: current gh user)')
    .option('--no-prs', 'Skip the GitHub PR lookup (commits only)')
    .option('--all-hosts', 'Aggregate across every online device (ag devices) over SSH')
    .addHelpText('after', `
Examples:
  agents output                       Last 7 days: burn, output tokens, PRs, commits, ratios
  agents output --since 24h           Last 24 hours
  agents output --since 1mo           Last month  (units: 1h 24h 7d 4w 1mo 1y, or ISO date)
  agents output --all-hosts           Fleet-wide, folding in every online machine
  agents output --by day --json       Machine-readable daily burn/output rollup

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

function emptyBurn(): BurnTotals {
  return { costUsd: 0, outputTokens: 0, tokenCount: 0, sessionCount: 0, durationMs: 0 };
}

function sumBurn(rows: RollupRow[]): BurnTotals {
  return rows.reduce((acc, r) => {
    acc.costUsd += r.costUsd;
    acc.outputTokens += r.outputTokens;
    acc.tokenCount += r.tokenCount;
    acc.sessionCount += r.sessionCount;
    acc.durationMs += r.durationMs;
    return acc;
  }, emptyBurn());
}

/** Compute this machine's payload from the local session DB + git. */
async function computeLocalPayload(options: OutputOptions, includePrs: boolean): Promise<OutputPayload> {
  const since = options.since ?? '7d';
  const sinceMs = parseTimeFilter(since);

  // Ensure the index is fresh (and migrated to v12 so output_tokens is populated).
  await discoverSessions({ all: true, since, limit: 1 });

  const filter: QueryOptions = { sinceMs };
  const groupBy = resolveGroup(options.by);
  const breakdown = queryUsageRollup({ ...filter, groupBy }) as RollupRow[];
  const burn = sumBurn(breakdown);

  const reposDir = options.reposDir ?? path.join(os.homedir(), 'src');
  const git = await collectGitOutput({
    reposDir,
    sinceMs,
    authors: options.author,
    logins: options.login,
    includePrs,
  });

  return {
    machine: machineId(),
    pricingVersion: PRICING_VERSION,
    since,
    burn,
    output: {
      commits: git.commits,
      commitShas: git.commitShas,
      prsOpened: git.prsOpened,
      prsMerged: git.prsMerged,
      reposScanned: git.reposScanned,
      ghAvailable: git.ghAvailable,
      authors: git.authors,
      logins: git.logins,
    },
    breakdown: { by: groupBy, rows: breakdown },
    uncostedAgents: groupBy === 'agent' ? breakdown.filter(r => r.costUsd === 0).map(r => r.key) : [],
  };
}

/** Fetch one remote device's payload by re-invoking `agents output --json --host <name>`. */
async function fetchRemotePayload(device: string, options: OutputOptions): Promise<OutputPayload> {
  const args = ['output', '--json', '--no-prs', '--host', device, '--since', options.since ?? '7d'];
  if (options.by) args.push('--by', options.by);
  if (options.reposDir) args.push('--repos-dir', options.reposDir);
  for (const a of options.author ?? []) args.push('--author', a);
  try {
    const { stdout } = await execFileAsync('agents', args, {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as OutputPayload;
    parsed.machine = parsed.machine || device;
    return parsed;
  } catch (err: any) {
    return {
      machine: device,
      pricingVersion: PRICING_VERSION,
      since: options.since ?? '7d',
      burn: emptyBurn(),
      output: { commits: 0, commitShas: [], prsOpened: 0, prsMerged: 0, reposScanned: 0, ghAvailable: false, authors: [], logins: [] },
      breakdown: { by: resolveGroup(options.by), rows: [] },
      uncostedAgents: [],
      error: (err?.stderr || err?.message || 'unreachable').toString().split('\n')[0].slice(0, 120),
    };
  }
}

async function outputAction(options: OutputOptions): Promise<void> {
  const includePrs = options.prs !== false;

  if (!options.allHosts) {
    const payload = await computeLocalPayload(options, includePrs);
    if (options.json) {
      process.stdout.write(JSON.stringify(withRatios(payload, [payload]), null, 2) + '\n');
      return;
    }
    renderSingle(payload);
    return;
  }

  // Fleet: local payload + every online device, folded in over SSH.
  const self = machineId();
  const registry = await loadDevices();
  const remotes = Object.values(registry)
    .filter(d => d.tailscale?.online && d.name !== self)
    .map(d => d.name);

  if (!options.json) console.error(chalk.gray(`Folding in ${remotes.length} online device${remotes.length !== 1 ? 's' : ''}…`));

  // PRs are global (gh search by author, not machine-bound) — compute once, locally.
  const local = await computeLocalPayload(options, includePrs);
  const remotePayloads = await Promise.all(remotes.map(d => fetchRemotePayload(d, options)));
  const machines = [local, ...remotePayloads];

  if (options.json) {
    process.stdout.write(JSON.stringify(withRatios(mergeMachines(machines, options), machines), null, 2) + '\n');
    return;
  }
  renderFleet(machines, options);
}

/** Merge per-machine payloads into a combined one (burn + commits summed; PRs local-only). */
function mergeMachines(machines: OutputPayload[], options: OutputOptions): OutputPayload {
  const burn = emptyBurn();
  const byKey = new Map<string, RollupRow>();
  // Union commit SHAs across machines: shared repos (cloned on several boxes)
  // expose the same commits to `git log` on each, so summing counts would
  // multi-count. A commit's SHA is its global identity — union, don't add.
  const allShas = new Set<string>();
  const uncosted = new Set<string>();
  for (const m of machines) {
    burn.costUsd += m.burn.costUsd;
    burn.outputTokens += m.burn.outputTokens;
    burn.tokenCount += m.burn.tokenCount;
    burn.sessionCount += m.burn.sessionCount;
    burn.durationMs += m.burn.durationMs;
    for (const s of m.output.commitShas) allShas.add(s);
    for (const a of m.uncostedAgents) uncosted.add(a);
    for (const r of m.breakdown.rows) {
      const cur = byKey.get(r.key) ?? { key: r.key, costUsd: 0, durationMs: 0, sessionCount: 0, tokenCount: 0, outputTokens: 0 };
      cur.costUsd += r.costUsd;
      cur.durationMs += r.durationMs;
      cur.sessionCount += r.sessionCount;
      cur.tokenCount += r.tokenCount;
      cur.outputTokens += r.outputTokens;
      byKey.set(r.key, cur);
    }
  }
  const rows = [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
  // PRs from the local machine only (machines[0]) — gh search is not machine-scoped.
  const localGit = machines[0].output;
  return {
    machine: 'fleet',
    pricingVersion: PRICING_VERSION,
    since: options.since ?? '7d',
    burn,
    output: { ...localGit, commits: allShas.size, commitShas: [...allShas] },
    breakdown: { by: resolveGroup(options.by), rows },
    uncostedAgents: [...uncosted],
  };
}

/** Attach burn-vs-output ratios to a payload for JSON output. */
function withRatios(payload: OutputPayload, machines: OutputPayload[]): unknown {
  const prsTotal = payload.output.prsOpened + payload.output.prsMerged;
  return {
    ...payload,
    ratios: {
      costPerPr: prsTotal > 0 ? payload.burn.costUsd / prsTotal : null,
      costPerCommit: payload.output.commits > 0 ? payload.burn.costUsd / payload.output.commits : null,
      outputTokensPerUsd: payload.burn.costUsd > 0 ? payload.burn.outputTokens / payload.burn.costUsd : null,
    },
    machines: machines.length > 1 ? machines.map(m => ({ machine: m.machine, burn: m.burn, commits: m.output.commits, error: m.error })) : undefined,
  };
}

/** Shared header line: burned · output tokens · PRs · commits, plus ratios. */
function headerLines(payload: OutputPayload): string[] {
  const prsTotal = payload.output.prsOpened + payload.output.prsMerged;
  const out: string[] = [];
  out.push(
    '  ' +
      `${chalk.green(formatUsd(payload.burn.costUsd))} burned` +
      chalk.gray('  ·  ') +
      `${chalk.cyan(formatCompact(payload.burn.outputTokens))} output tokens` +
      chalk.gray('  ·  ') +
      `${chalk.yellow(String(prsTotal))} PRs ${chalk.gray(`(${payload.output.prsMerged} merged)`)}` +
      chalk.gray('  ·  ') +
      `${chalk.yellow(String(payload.output.commits))} commits`,
  );
  const ratios: string[] = [];
  if (prsTotal > 0) ratios.push(`${formatUsd(payload.burn.costUsd / prsTotal)}/PR`);
  if (payload.output.commits > 0) ratios.push(`${formatUsd(payload.burn.costUsd / payload.output.commits)}/commit`);
  if (payload.burn.costUsd > 0) ratios.push(`${formatCompact(Math.round(payload.burn.outputTokens / payload.burn.costUsd))} out-tok/$`);
  if (ratios.length > 0) out.push(chalk.gray('  ' + ratios.join('  ·  ')));
  return out;
}

/** Render the per-group burn/output table. */
function renderBreakdown(rows: RollupRow[], groupBy: string): string[] {
  const out: string[] = [chalk.bold(`By ${groupBy}`)];
  if (rows.length === 0) return out;
  const cols = terminalWidth();
  const burnW = Math.max(...rows.map(r => formatUsd(r.costUsd).length), 4);
  const outW = Math.max(...rows.map(r => formatCompact(r.outputTokens).length), 6);
  const sessW = Math.max(...rows.map(r => String(r.sessionCount).length), 3);
  const fixedW = 2 + 2 + burnW + 2 + outW + 2 + sessW + 8;
  const keyW = Math.max(8, Math.min(Math.max(...rows.map(r => r.key.length), groupBy.length), cols - fixedW));
  out.push('  ' + chalk.gray(padToWidth('', keyW)) + '  ' + chalk.gray(padToWidth('burn', burnW)) + '  ' + chalk.gray(padToWidth('output', outW)) + '  ' + chalk.gray('sessions'));
  for (const r of rows) {
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
  return out;
}

function renderSingle(payload: OutputPayload): void {
  const out: string[] = [];
  out.push(chalk.bold('Output') + chalk.gray(`  ·  pricing ${payload.pricingVersion}  ·  since ${payload.since}`));
  out.push(...headerLines(payload));
  out.push('');
  if (payload.burn.sessionCount === 0) {
    out.push(chalk.gray('No sessions with cost data found. Run `agents sessions --all` to index, then retry.'));
    console.log(out.join('\n'));
    return;
  }
  out.push(...renderBreakdown(payload.breakdown.rows, payload.breakdown.by));
  out.push('');
  out.push(chalk.bold('Shipped'));
  out.push(`  ${chalk.yellow(String(payload.output.commits))} commits across ${payload.output.reposScanned} repos` + chalk.gray(`  (authors: ${payload.output.authors.length > 0 ? payload.output.authors.join(', ') : 'none detected'})`));
  if (payload.output.ghAvailable) {
    out.push(`  ${chalk.yellow(String(payload.output.prsOpened))} PRs opened, ${chalk.yellow(String(payload.output.prsMerged))} merged` + chalk.gray(`  (logins: ${payload.output.logins.join(', ')})`));
  } else {
    out.push(chalk.gray('  PRs: gh unavailable or unauthed — not counted'));
  }
  out.push('');
  out.push(chalk.gray(notCountedLine(payload.uncostedAgents)));
  if (payload.burn.durationMs > 0) out.push(chalk.gray(`agent wall-clock: ${formatDuration(payload.burn.durationMs)}`));
  console.log(out.join('\n'));
}

function renderFleet(machines: OutputPayload[], options: OutputOptions): void {
  const merged = mergeMachines(machines, options);
  const out: string[] = [];
  out.push(chalk.bold('Output') + chalk.gray(`  ·  fleet (${machines.length} machines)  ·  pricing ${merged.pricingVersion}  ·  since ${merged.since}`));
  out.push(...headerLines(merged));
  out.push('');

  // By machine.
  out.push(chalk.bold('By machine'));
  const nameW = Math.max(...machines.map(m => m.machine.length), 7);
  const burnW = Math.max(...machines.map(m => formatUsd(m.burn.costUsd).length), 4);
  for (const m of machines) {
    const note = m.error ? chalk.red(`  (${m.error})`) : '';
    out.push(
      '  ' +
        padToWidth(m.machine, nameW) +
        '  ' +
        chalk.green(padToWidth(formatUsd(m.burn.costUsd), burnW)) +
        '  ' +
        chalk.cyan(padToWidth(formatCompact(m.burn.outputTokens), 7)) +
        '  ' +
        chalk.gray(`${m.burn.sessionCount} sessions, ${m.output.commits} commits`) +
        note,
    );
  }
  out.push('');
  out.push(...renderBreakdown(merged.breakdown.rows, merged.breakdown.by));
  out.push('');
  out.push(chalk.gray(notCountedLine(merged.uncostedAgents)));
  console.log(out.join('\n'));
}

function notCountedLine(uncosted: string[]): string {
  const notes: string[] = [];
  if (uncosted.length > 0) notes.push(`no price table for: ${[...new Set(uncosted)].join(', ')} (burn undercounts)`);
  notes.push('cloud runs (Rush/Codex/Factory) not counted');
  return 'not counted: ' + notes.join('  ·  ');
}
