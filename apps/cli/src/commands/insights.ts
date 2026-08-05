/**
 * Insights command — how you actually work, split by the account that did the work.
 *
 * The behavioural sibling of the existing rollups, and deliberately not a duplicate of
 * any of them:
 *
 *   agents cost      what you spent            ($ and duration)
 *   agents output    what shipped              (burn vs PRs and commits)
 *   agents usage     live quota headroom       (rate-limit windows, right now)
 *   agents trends    aggregate distributions   (harness mix, tools-per-session, token ratios)
 *   agents sessions  browse individual work    (search, resume, render)
 *   agents insights  HOW you work              (tools, friction, rhythm, per account)
 *
 * The closest neighbour is `agents trends`, and the boundary is the data path: trends
 * reads counters — `tool_scan_ledger` call counts and the analytics warehouse — to
 * produce distributions ("how many tool calls per session, by harness"). This reads
 * transcript CONTENT through `parseSession` to produce behaviour ("which tools, which
 * languages, where it went wrong, when you were working"), and splits all of it by
 * account, a dimension trends does not have. They overlap in spirit on tool and model
 * mix; they do not read the same store or answer the same question.
 *
 * Modelled on Claude Code's `/insights`, with the difference that motivated it: that
 * command reads one account's directory, while `balanced` rotation sprays sessions
 * across every signed-in account. This reads the whole index and reports the accounts
 * apart — see lib/session/claude-accounts.ts for how a transcript is attributed.
 *
 * The deterministic report makes zero network calls. `--narrative` is opt-in and adds
 * the coaching prose by piping the AGGREGATE (never raw transcripts) through a headless
 * `claude -p`.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { addHostOption } from '../lib/hosts/option.js';
import { setHelpSections } from '../lib/help.js';
import { discoverSessions, parseTimeFilter } from '../lib/session/discover.js';
import {
  querySessions,
  readSessionInsights,
  writeSessionInsights,
  clearSessionInsights,
  type QueryOptions,
} from '../lib/session/db.js';
import { parseSession } from '../lib/session/parse.js';
import {
  computeInsightFacets,
  mergeFacets,
  newFacetAccumulator,
  detectOverlap,
  percentile,
  bucketGaps,
  topEntries,
  type InsightFacets,
  type SessionSpan,
} from '../lib/session/insights.js';
import { formatUsd } from '../lib/pricing/index.js';
import { formatDuration } from '../lib/session/render.js';
import { terminalWidth, truncateToWidth, stringWidth, padToWidth } from '../lib/session/width.js';
import type { SessionMeta } from '../lib/session/types.js';

const execFileAsync = promisify(execFile);

interface InsightsOptions {
  json?: boolean;
  since?: string;
  account?: string;
  agent?: string;
  by?: string;
  refresh?: boolean;
  narrative?: boolean;
  minMessages?: string;
}

/** One reported group — an account by default, else an agent/project/day. */
interface GroupReport {
  key: string;
  label: string;
  plan: string | null;
  sessions: number;
  costUsd: number;
  durationMs: number;
  outputTokens: number;
  facets: InsightFacets;
}

type GroupDim = 'account' | 'agent' | 'project' | 'day';

function resolveGroup(by: string | undefined): GroupDim {
  if (by === undefined) return 'account';
  if (by === 'account' || by === 'agent' || by === 'project' || by === 'day') return by;
  console.error(chalk.red('error: --by must be one of: account, agent, project, day'));
  process.exit(1);
}

/**
 * Sessions too short to say anything about how you work. Mirrors the filter
 * `/insights` applies (under 2 user messages, under a minute) so the two reports
 * count comparable populations. The dropped count is always reported, never silent.
 */
function isSubstantive(m: SessionMeta, minMessages: number): boolean {
  if ((m.messageCount ?? 0) < minMessages) return false;
  if ((m.durationMs ?? 0) < 60_000) return false;
  return true;
}

function groupKeyFor(m: SessionMeta, dim: GroupDim): string {
  switch (dim) {
    case 'account': return m.accountKey ?? `unattributed:${m.agent}`;
    case 'agent': return m.agent;
    case 'project': return m.project || '(no project)';
    case 'day': return m.timestamp.slice(0, 10);
  }
}

function groupLabelFor(m: SessionMeta, dim: GroupDim, key: string): string {
  if (dim !== 'account') return key;
  if (m.accountOrg && m.account) return `${m.accountOrg} <${m.account}>`;
  return key;
}

/**
 * Load facets for every in-scope session, parsing only what the cache does not
 * already hold. A cold first run parses every transcript once; after that only files
 * whose (mtime, size) changed are re-read.
 */
async function collectFacets(
  rows: SessionMeta[],
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, InsightFacets>> {
  const cached = readSessionInsights<InsightFacets>(rows.map((r) => r.id));
  const stale = rows.filter((r) => !cached.has(r.id) && r.filePath);
  if (stale.length === 0) return cached;

  const fresh: Array<{ id: string; facets: InsightFacets }> = [];
  let done = 0;
  for (const row of stale) {
    try {
      const events = parseSession(row.filePath!, row.agent);
      const facets = computeInsightFacets(events);
      cached.set(row.id, facets);
      fresh.push({ id: row.id, facets });
    } catch {
      // A transcript that has been deleted or is unreadable contributes nothing.
      // It is still counted in the session totals from its indexed row.
    }
    done++;
    if (done % 25 === 0) onProgress(done, stale.length);
    // Persist in batches so an interrupted cold run does not lose everything.
    if (fresh.length >= 200) {
      writeSessionInsights(fresh.splice(0, fresh.length));
    }
  }
  if (fresh.length > 0) writeSessionInsights(fresh);
  onProgress(stale.length, stale.length);
  return cached;
}

function buildGroups(
  rows: SessionMeta[],
  facetsById: Map<string, InsightFacets>,
  dim: GroupDim,
): GroupReport[] {
  const byKey = new Map<string, GroupReport>();
  for (const m of rows) {
    const key = groupKeyFor(m, dim);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        label: groupLabelFor(m, dim, key),
        plan: null,
        sessions: 0,
        costUsd: 0,
        durationMs: 0,
        outputTokens: 0,
        facets: newFacetAccumulator(),
      };
      byKey.set(key, g);
    }
    g.sessions++;
    g.costUsd += m.costUsd ?? 0;
    g.durationMs += m.durationMs ?? 0;
    g.outputTokens += m.outputTokens ?? 0;
    const f = facetsById.get(m.id);
    if (f) mergeFacets(g.facets, f);
  }
  return [...byKey.values()].sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));
}

/** A compact bar for a count relative to the row maximum. */
function bar(count: number, max: number, width: number): string {
  if (max <= 0) return '';
  const filled = Math.max(1, Math.round((count / max) * width));
  return '█'.repeat(filled);
}

function renderCounts(
  title: string,
  entries: Array<{ name: string; count: number }>,
  out: string[],
): void {
  if (entries.length === 0) return;
  out.push('');
  out.push(chalk.bold(title));
  const nameW = Math.max(...entries.map((e) => stringWidth(e.name)));
  const countW = Math.max(...entries.map((e) => String(e.count).length));
  const max = Math.max(...entries.map((e) => e.count));
  const barW = Math.max(6, Math.min(28, terminalWidth() - nameW - countW - 8));
  for (const e of entries) {
    out.push(
      `  ${padToWidth(e.name, nameW)}  ${chalk.cyan(String(e.count).padStart(countW))}  ` +
      chalk.gray(bar(e.count, max, barW)),
    );
  }
}

function renderHours(hours: number[], out: string[]): void {
  const total = hours.reduce((a, b) => a + b, 0);
  if (total === 0) return;
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...hours);
  const spark = hours
    .map((h) => (h === 0 ? ' ' : blocks[Math.min(blocks.length - 1, Math.floor((h / max) * (blocks.length - 1)))]))
    .join('');
  out.push('');
  out.push(chalk.bold('When you work') + chalk.gray('  (local time)'));
  out.push(`  ${chalk.cyan(spark)}`);
  out.push(`  ${chalk.gray('0h'.padEnd(6))}${chalk.gray('6h'.padEnd(6))}${chalk.gray('12h'.padEnd(6))}${chalk.gray('18h'.padEnd(5))}${chalk.gray('23h')}`);
}

function renderReport(groups: GroupReport[], dim: GroupDim, meta: ReportMeta): void {
  const out: string[] = [];
  const scope = meta.since ? `last ${meta.since}` : 'all time';
  out.push(chalk.bold('Insights') + chalk.gray(`  ${scope} · ${meta.analyzed} of ${meta.scanned} sessions`));

  if (groups.length === 0) {
    out.push('');
    out.push(chalk.gray('  No sessions in scope. Try a wider --since, or run `agents sessions --all` to index.'));
    console.log(out.join('\n'));
    return;
  }

  // Per-group table — the headline, and the thing no sibling command produces.
  out.push('');
  out.push(chalk.bold(`By ${dim}`));
  const labelW = Math.min(
    Math.max(...groups.map((g) => stringWidth(g.label)), 5),
    Math.max(20, terminalWidth() - 46),
  );
  const sessW = Math.max(...groups.map((g) => String(g.sessions).length), 3);
  for (const g of groups) {
    const cost = g.costUsd > 0 ? formatUsd(g.costUsd) : '—';
    const dur = g.durationMs > 0 ? formatDuration(g.durationMs) : '—';
    out.push(
      `  ${padToWidth(truncateToWidth(g.label, labelW), labelW)}  ` +
      `${chalk.gray(String(g.sessions).padStart(sessW))} ${chalk.gray('sess')}  ` +
      `${chalk.green(padToWidth(cost, 9))}  ${chalk.gray(dur)}`,
    );
  }

  // Everything below is the whole scope folded together; per-group detail is in --json.
  const all = newFacetAccumulator();
  for (const g of groups) mergeFacets(all, g.facets);

  renderCounts('Top tools', topEntries(all.toolCounts, 8), out);
  renderCounts('Languages', topEntries(all.languages, 6), out);
  renderCounts('Models', topEntries(all.models, 6), out);

  // Friction — the section that earns the command.
  const gaps = all.responseGaps;
  out.push('');
  out.push(chalk.bold('Friction'));
  out.push(`  ${padToWidth('interruptions', 18)}  ${chalk.cyan(String(all.interruptions))}` +
    chalk.gray('   turns you cut short'));
  out.push(`  ${padToWidth('tool errors', 18)}  ${chalk.cyan(String(all.errorCount))}`);
  if (gaps.length > 0) {
    out.push(`  ${padToWidth('your reply time', 18)}  ` +
      chalk.cyan(`p50 ${Math.round(percentile(gaps, 50))}s`) + chalk.gray(` · p90 ${Math.round(percentile(gaps, 90))}s`));
  }
  const errs = topEntries(all.errorCategories, 6);
  if (errs.length > 0) {
    for (const e of errs) out.push(`    ${chalk.gray('·')} ${padToWidth(e.name, 16)} ${chalk.gray(String(e.count))}`);
  }

  // Output
  out.push('');
  out.push(chalk.bold('What you changed'));
  out.push(`  ${chalk.green('+' + all.linesAdded)} ${chalk.red('-' + all.linesRemoved)} ${chalk.gray('lines')}  ·  ` +
    chalk.gray(`${all.filesCreated} created, ${all.filesModified} modified, ${all.filesDeleted} deleted`));
  out.push(`  ${chalk.gray(`${all.gitCommits} commits · ${all.gitPushes} pushes`)}`);

  renderHours(all.messageHours, out);

  // Concurrency — direct evidence that a single-account view would be wrong.
  if (meta.overlap.overlappingPairs > 0) {
    out.push('');
    out.push(chalk.bold('Parallel sessions'));
    out.push(`  ${chalk.cyan(String(meta.overlap.sessionsInvolved))} ${chalk.gray('sessions ran alongside another')}`);
    // Pairs, not sessions — stated as pairs so the two numbers are not read as a
    // subset of each other.
    const crossNote = meta.overlap.crossAccountPairs > 0
      ? `, ${meta.overlap.crossAccountPairs} of them across two different accounts`
      : '';
    out.push(chalk.gray(`  ${meta.overlap.overlappingPairs} overlapping pairs${crossNote}`));
  }

  if (meta.filteredOut > 0) {
    out.push('');
    out.push(chalk.gray(`  ${meta.filteredOut} sessions excluded as too short (under ${meta.minMessages} messages or 1 minute).`));
  }
  out.push('');
  out.push(chalk.gray('  `agents insights --by project` to see it per repo'));
  out.push(chalk.gray('  `agents insights --narrative` for a written read on what to change'));
  console.log(out.join('\n'));
}

interface ReportMeta {
  since?: string;
  scanned: number;
  analyzed: number;
  filteredOut: number;
  minMessages: number;
  overlap: ReturnType<typeof detectOverlap>;
}

/**
 * The opt-in coaching layer. Pipes the AGGREGATE through a headless `claude -p` — never
 * raw transcripts, unlike `/insights`, which ships session text to the API. Reuses
 * whatever account the shim resolves, so there is no API key handling here.
 */
async function renderNarrative(payload: unknown): Promise<void> {
  const prompt = [
    'You are reading a developer\'s own coding-session telemetry, already aggregated.',
    'Write a short, direct read for them. Four sections, 2-3 sentences each:',
    '1. What is working — the patterns worth keeping.',
    '2. What is costing you — split into the assistant\'s fault vs your own workflow.',
    '3. Quick wins — concrete, tied to a number in the data.',
    '4. Worth trying — one more ambitious workflow change.',
    'Be specific and cite the numbers. No preamble, no flattery, no bullet padding.',
    '',
    JSON.stringify(payload),
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('claude', ['-p', prompt], {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    console.log('');
    console.log(chalk.bold('Narrative'));
    console.log(stdout.trim().split('\n').map((l) => `  ${l}`).join('\n'));
  } catch (err) {
    const msg = (err as { code?: string }).code === 'ENOENT'
      ? 'claude is not on PATH'
      : ((err as Error).message ?? 'unknown error');
    console.error('');
    console.error(chalk.red(`✗ narrative unavailable: ${msg}`));
    console.error(chalk.gray('  The report above is complete; only the written section was skipped.'));
  }
}

async function insightsAction(options: InsightsOptions): Promise<void> {
  const dim = resolveGroup(options.by);
  const minMessages = Number.parseInt(options.minMessages ?? '2', 10);
  if (!Number.isFinite(minMessages) || minMessages < 0) {
    console.error(chalk.red('error: --min-messages must be a non-negative integer'));
    process.exit(1);
  }
  const since = options.since ?? '30d';
  const sinceMs = since === 'all' ? undefined : parseTimeFilter(since);

  // Refresh the index first, exactly as `agents cost` does, so a report never silently
  // describes a stale picture of disk.
  await discoverSessions({ all: true, since: since === 'all' ? undefined : since, limit: 1 });
  if (options.refresh) clearSessionInsights();

  const filter: QueryOptions = { sinceMs };
  if (options.agent) filter.agent = options.agent as QueryOptions['agent'];
  const scanned = querySessions(filter);

  const wanted = options.account?.toLowerCase();
  const inScope = scanned.filter((m) => {
    if (!wanted) return true;
    return [m.accountKey, m.account, m.accountOrg]
      .some((v) => v?.toLowerCase().includes(wanted));
  });

  const substantive = inScope.filter((m) => isSubstantive(m, minMessages));
  const filteredOut = inScope.length - substantive.length;

  const isTty = process.stdout.isTTY && !options.json;
  const facetsById = await collectFacets(substantive, (done, total) => {
    if (isTty && done < total) process.stderr.write(`\rReading transcripts ${done}/${total}…`);
    else if (isTty) process.stderr.write('\r'.padEnd(40) + '\r');
  });

  const spans: SessionSpan[] = substantive.map((m) => {
    const start = new Date(m.timestamp).getTime();
    return {
      id: m.id,
      accountKey: m.accountKey ?? `unattributed:${m.agent}`,
      startMs: start,
      endMs: start + (m.durationMs ?? 0),
    };
  });
  const overlap = detectOverlap(spans);
  const groups = buildGroups(substantive, facetsById, dim);

  if (options.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      window: { since: since === 'all' ? null : since },
      scanned: inScope.length,
      analyzed: substantive.length,
      filteredOut,
      minMessages,
      by: dim,
      overlap,
      groups: groups.map((g) => ({
        key: g.key,
        label: g.label,
        sessions: g.sessions,
        costUsd: g.costUsd,
        durationMs: g.durationMs,
        outputTokens: g.outputTokens,
        ...g.facets,
        responseGapP50: Math.round(percentile(g.facets.responseGaps, 50)),
        responseGapP90: Math.round(percentile(g.facets.responseGaps, 90)),
        responseGapBuckets: bucketGaps(g.facets.responseGaps),
        // The raw sample is large and uninteresting once bucketed.
        responseGaps: undefined,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    if (options.narrative) await renderNarrative(payload);
    return;
  }

  renderReport(groups, dim, {
    since: since === 'all' ? undefined : since,
    scanned: inScope.length,
    analyzed: substantive.length,
    filteredOut,
    minMessages,
    overlap,
  });

  if (options.narrative) {
    await renderNarrative(groups.map((g) => ({
      account: g.label, sessions: g.sessions, costUsd: g.costUsd,
      topTools: topEntries(g.facets.toolCounts, 8),
      languages: topEntries(g.facets.languages, 6),
      errorCategories: topEntries(g.facets.errorCategories, 6),
      interruptions: g.facets.interruptions,
      linesAdded: g.facets.linesAdded, linesRemoved: g.facets.linesRemoved,
      gitCommits: g.facets.gitCommits,
      replyP50s: Math.round(percentile(g.facets.responseGaps, 50)),
    })));
  }
}

export function registerInsightsCommand(program: Command): void {
  const cmd = addHostOption(program.command('insights'))
    .description('How you work — tools, friction, and rhythm, split by the account that did the work')
    .option('--json', 'Output the full report as JSON')
    .option('--since <time>', 'Window: 7d, 4w, 3mo, an ISO date, or "all" (default 30d)')
    .option('--by <dimension>', 'Group by: account (default), agent, project, or day')
    .option('--account <match>', 'Only sessions whose account key, email, or org contains this')
    .option('--agent <id>', 'Only one harness (claude, codex, droid, …)')
    .option('--min-messages <n>', 'Skip sessions under this many messages (default 2)')
    .option('--refresh', 'Discard cached facets and re-read every transcript')
    .option('--narrative', 'Add a written read on the numbers via a headless `claude -p`')
    .action(async (options: InsightsOptions) => {
      await insightsAction(options);
    });

  setHelpSections(cmd, {
    examples: `
      # Last 30 days, split by Claude account — the default
      agents insights

      # Which repo is eating the time
      agents insights --by project --since 90d

      # One account only, all of its history
      agents insights --account "Turing Labs" --since all

      # Machine-readable, for a dashboard or a slash command
      agents insights --json

      # Add a written read on what to change
      agents insights --narrative
    `,
    notes: `
      Answers "how do you work". For "what did it cost" use \`agents cost\`, for "what
      shipped" use \`agents output\`, for live quota use \`agents usage\`.

      The first run parses every in-scope transcript and caches the result; later runs
      re-read only files that changed. \`--refresh\` forces a full re-read.

      Account attribution is Claude-only today. Sessions from other harnesses group
      under \`unattributed:<agent>\`.

      Everything except \`--narrative\` is local and makes no network calls.
    `,
  });
}
