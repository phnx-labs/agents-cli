/**
 * `agents perf` — latency rollups over the disposable perf SQLite warehouse.
 *
 * Subcommands:
 *   agents perf              multi-section summary (commands + hooks + runs)
 *   agents perf hooks        per-hook p50/p99 + cache hit rates
 *   agents perf commands     slowest CLI command paths (from command.end)
 *   agents perf run          agent.run / perf.timing labels
 *
 * Soft-joins sessions.db via shared string keys (session_id, agent, machine) —
 * no foreign keys. Warehouse lives at ~/.agents/.cache/perf/perf.db (safe to wipe).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  aggregateSamples,
  perfDbPath,
  type PerfAggregateRow,
} from '../lib/perf/db.js';
import {
  formatMs,
  formatCacheColumn,
  DEFAULT_SLOW_HOOK_WARN_MS,
  loadHookFireEvents,
  aggregateHookProfile,
  type HookProfileRow,
} from '../lib/hooks/profile.js';

interface PerfGlobalOpts {
  days?: string;
  warnMs?: string;
  json?: boolean;
  limit?: string;
}

function parseDays(raw: string | undefined): number {
  const n = parseInt(raw ?? '7', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function parseWarnMs(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Map warehouse rows shaped like hook.fire into the existing HookProfileRow UI. */
function asHookRows(rows: PerfAggregateRow[]): HookProfileRow[] {
  return rows.map((r) => ({
    hook: r.label,
    n: r.n,
    p50Ms: r.p50Ms,
    p99Ms: r.p99Ms,
    meanMs: r.meanMs,
    maxMs: r.maxMs,
    cacheHitPct: r.cacheHitPct ?? 0,
    cacheStalePct: r.cacheStalePct ?? 0,
    cacheMissPct: r.cacheMissPct ?? 0,
    errorCount: r.errorCount ?? 0,
  }));
}

function printTable(
  headers: string[],
  widths: number[],
  lines: string[][],
  slowFlags: boolean[],
): void {
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
  const header = headers.map((h, i) => pad(h, widths[i])).join(' ');
  console.log(chalk.bold(header));
  console.log(chalk.gray('─'.repeat(header.length)));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].map((c, j) => pad(c, widths[j])).join(' ');
    console.log(slowFlags[i] ? chalk.yellow(line) : line);
  }
}

function renderHookTable(rows: HookProfileRow[], warnMs: number): void {
  if (rows.length === 0) {
    console.log(chalk.gray('No hook timing samples yet.'));
    console.log(chalk.gray(`Warehouse: ${perfDbPath()}`));
    console.log(chalk.gray('Hooks write via cache/matches shims into the spool; run a session or resync hooks.'));
    return;
  }
  const widths = { hook: 36, n: 5, p50: 7, p99: 7, mean: 7, max: 7, cache: 28 };
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
  const header = [
    pad('HOOK', widths.hook),
    pad('N', widths.n),
    pad('P50', widths.p50),
    pad('P99', widths.p99),
    pad('MEAN', widths.mean),
    pad('MAX', widths.max),
    pad('CACHE', widths.cache),
  ].join(' ');
  console.log(chalk.bold(header));
  console.log(chalk.gray('─'.repeat(header.length)));
  for (const r of rows) {
    const slow = r.p99Ms > warnMs;
    const cacheCol = formatCacheColumn(r);
    const warning = slow && r.cacheHitPct + r.cacheStalePct === 0 ? '  ← add cache: 5m' : '';
    const line = [
      pad(r.hook, widths.hook),
      pad(String(r.n), widths.n),
      pad(formatMs(r.p50Ms), widths.p50),
      pad(formatMs(r.p99Ms), widths.p99),
      pad(formatMs(r.meanMs), widths.mean),
      pad(formatMs(r.maxMs), widths.max),
      pad(cacheCol, widths.cache),
    ].join(' ') + warning;
    console.log(slow ? chalk.yellow(line) : line);
  }
}

function renderLabelTable(title: string, rows: PerfAggregateRow[], warnMs: number, limit: number): void {
  const sliced = rows.slice(0, limit);
  if (sliced.length === 0) {
    console.log(chalk.gray(`No ${title} samples yet.`));
    return;
  }
  const widths = [40, 5, 7, 7, 7, 7];
  printTable(
    ['LABEL', 'N', 'P50', 'P99', 'MEAN', 'MAX'],
    widths,
    sliced.map((r) => [
      r.label,
      String(r.n),
      formatMs(r.p50Ms),
      formatMs(r.p99Ms),
      formatMs(r.meanMs),
      formatMs(r.maxMs),
    ]),
    sliced.map((r) => r.p99Ms > warnMs),
  );
}

/**
 * Prefer SQLite samples; fall back to the legacy daily JSONL so existing
 * instrumentation still surfaces until shims are resynced.
 */
function loadHookProfile(days: number): HookProfileRow[] {
  const fromDb = asHookRows(aggregateSamples({ days, kinds: ['hook.fire'] }));
  if (fromDb.length > 0) return fromDb;
  return aggregateHookProfile(loadHookFireEvents(days));
}

function hooksAction(opts: PerfGlobalOpts): void {
  const days = parseDays(opts.days);
  const warnMs = parseWarnMs(opts.warnMs, DEFAULT_SLOW_HOOK_WARN_MS);
  const rows = loadHookProfile(days);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  renderHookTable(rows, warnMs);
}

function commandsAction(opts: PerfGlobalOpts): void {
  const days = parseDays(opts.days);
  const warnMs = parseWarnMs(opts.warnMs, 500);
  const limit = parseLimit(opts.limit, 40);
  const rows = aggregateSamples({ days, kinds: ['command.end'] });
  if (opts.json) {
    console.log(JSON.stringify(rows.slice(0, limit), null, 2));
    return;
  }
  renderLabelTable('command', rows, warnMs, limit);
}

function runAction(opts: PerfGlobalOpts): void {
  const days = parseDays(opts.days);
  const warnMs = parseWarnMs(opts.warnMs, 60_000);
  const limit = parseLimit(opts.limit, 40);
  const rows = aggregateSamples({ days, kinds: ['perf.timing'] });
  if (opts.json) {
    console.log(JSON.stringify(rows.slice(0, limit), null, 2));
    return;
  }
  renderLabelTable('run/timing', rows, warnMs, limit);
}

function summaryAction(opts: PerfGlobalOpts): void {
  const days = parseDays(opts.days);
  if (opts.json) {
    console.log(JSON.stringify({
      days,
      warehouse: perfDbPath(),
      hooks: loadHookProfile(days),
      commands: aggregateSamples({ days, kinds: ['command.end'] }).slice(0, 20),
      run: aggregateSamples({ days, kinds: ['perf.timing'] }).slice(0, 20),
    }, null, 2));
    return;
  }

  console.log(chalk.bold(`agents perf — last ${days} day${days === 1 ? '' : 's'}`));
  console.log(chalk.gray(`warehouse: ${perfDbPath()}  (disposable; soft-join sessions via session_id/agent/machine)`));
  console.log('');

  console.log(chalk.bold('Commands (slowest by p99)'));
  renderLabelTable('command', aggregateSamples({ days, kinds: ['command.end'] }), parseWarnMs(opts.warnMs, 500), 12);
  console.log('');

  console.log(chalk.bold('Hooks'));
  renderHookTable(loadHookProfile(days), parseWarnMs(opts.warnMs, DEFAULT_SLOW_HOOK_WARN_MS));
  console.log('');

  console.log(chalk.bold('Runs (perf.timing)'));
  renderLabelTable('run/timing', aggregateSamples({ days, kinds: ['perf.timing'] }), parseWarnMs(opts.warnMs, 60_000), 12);
}

function attachSharedOptions(cmd: Command): Command {
  return cmd
    .option('--days <n>', 'Days of samples to include', '7')
    .option('--warn-ms <n>', 'p99 above this is highlighted')
    .option('--limit <n>', 'Max rows in the table', '40')
    .option('--json', 'Emit JSON instead of a table');
}

/**
 * Commander binds a flag declared on both parent and child to the *parent*.
 * Merge so `agents perf commands --json` still sees json:true on the leaf.
 */
function leafOpts(cmd: Command): PerfGlobalOpts {
  const parent = cmd.parent && typeof cmd.parent.opts === 'function'
    ? (cmd.parent.opts() as PerfGlobalOpts)
    : {};
  return { ...parent, ...(cmd.opts() as PerfGlobalOpts) };
}

export function registerPerfCommand(program: Command): void {
  const perf = program
    .command('perf')
    .description('Latency rollups from the disposable perf warehouse (hooks, commands, runs)')
    .addHelpText('after', `
The warehouse is SQLite at ~/.agents/.cache/perf/perf.db — safe to delete.
Identity columns reuse sessions/events string shapes (session_id, agent, machine)
for soft cross-reference; there are no foreign keys.

Examples:
  agents perf                     # summary: commands + hooks + runs
  agents perf hooks               # per-hook p50/p99 + cache hit rate
  agents perf commands --days 30  # slowest CLI entrypoints
  agents perf run --json          # agent.run timings as JSON
  agents perf hooks --warn-ms 500
`);

  // Options live on the parent so `agents perf --json` and
  // `agents perf commands --json` both work (see leafOpts).
  attachSharedOptions(perf).action(function summary(this: Command) {
    summaryAction(this.opts() as PerfGlobalOpts);
  });

  perf.command('hooks').description('Per-hook timing + cache stats')
    .action(function hooks(this: Command) {
      hooksAction(leafOpts(this));
    });

  perf.command('commands').description('Slowest CLI command paths (command.end samples)')
    .action(function commands(this: Command) {
      commandsAction(leafOpts(this));
    });

  perf.command('run').description('agent.run / perf.timing label rollups')
    .action(function run(this: Command) {
      runAction(leafOpts(this));
    });
}
