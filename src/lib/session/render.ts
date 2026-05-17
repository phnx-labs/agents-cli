/**
 * Session rendering: summary, markdown conversation, and JSON output.
 *
 * Provides the display layer for `agents sessions <id>`. The summary renderer
 * produces a chalk-formatted activity overview (modified files, commands,
 * errors, final message). The markdown renderer emits a full conversation
 * transcript. Filtering by role and turn slicing is handled here as well.
 */

import chalk from 'chalk';
import type { SessionEvent } from './types.js';
import { summarizeToolUse } from './parse.js';
import { cleanSessionPrompt, extractSessionTopic } from './prompt.js';
import { renderMarkdown } from '../markdown.js';
import { redactSecrets } from '../redact.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Return absPath relative to cwd; fall back to ~/… then absolute.
 */
export function relativeToCwd(absPath: string, cwd?: string): string {
  if (cwd && (absPath === cwd || absPath.startsWith(cwd + '/'))) {
    const rel = absPath.slice(cwd.length + 1);
    return rel || '.';
  }
  const home = process.env.HOME || '';
  if (home && (absPath === home || absPath.startsWith(home + '/'))) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

/**
 * Wrap label in an OSC 8 hyperlink when the terminal supports it.
 * Degrades to plain label otherwise.
 */
export function linkPath(absPath: string, label: string): string {
  if (
    process.stdout.isTTY &&
    (process.env.TERM_PROGRAM ||
      process.env.WT_SESSION ||
      process.env.KITTY_WINDOW_ID ||
      process.env.WEZTERM_PANE)
  ) {
    return `\x1b]8;;file://${absPath}\x1b\\${label}\x1b]8;;\x1b\\`;
  }
  return label;
}

// ── Command grouping ──────────────────────────────────────────────────────────

/**
 * Unwrap wrapper prefixes to find the actual executable.
 */
export function unwrapCommand(cmd: string): string {
  const ssh = cmd.match(/^ssh\s+\S+\s+"(.+)"\s*(?:\|.*)?$/);
  if (ssh) return unwrapCommand(ssh[1]);
  const lead = cmd.match(/^(?:sudo|env\s+\S+=\S+|time)\s+(.+)/);
  if (lead) return unwrapCommand(lead[1]);
  // Strip shell-style leading env assignments: `PATH=/x CMD ...`, `FOO=bar BAR=baz CMD ...`
  const shellEnv = cmd.match(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+(\S.*)$/);
  if (shellEnv) return unwrapCommand(shellEnv[1]);
  const cd = cmd.match(/^cd\s+\S+\s*&&\s*(.+)/);
  if (cd) return unwrapCommand(cd[1]);
  const npx = cmd.match(/^npx\s+(.+)/);
  if (npx) return unwrapCommand(npx[1]);
  return cmd;
}

/**
 * Normalize a command so trivial flag/pipe variations collapse to the same key.
 */
export function normalizeForDedup(cmd: string): string {
  let s = cmd.trim();
  s = s.replace(/\s+-[a-zA-Z]+/g, '');
  s = s.replace(/\s+--[a-zA-Z][-a-zA-Z0-9]*(?:=\S+)?/g, '');
  s = s.replace(/\s*\|\s*(head|tail|wc|less|more|cat)(\s+\S+)?.*$/, '');
  s = s.replace(/\s*2>&1\s*$/, '');
  s = s.replace(/\s*;\s*echo\b.*$/, '');
  const home = process.env.HOME ?? '';
  if (home) {
    s = s.replace(new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '~');
  }
  return s.trim();
}

/** Command classification categories with signal levels for summary rendering. */
const CATEGORIES: Array<{
  name: string;
  match: (first: string) => boolean;
  signal: 'high' | 'mid' | 'low';
}> = [
  { name: 'Probes',     match: t => ['ls','cat','head','tail','wc','stat','file','which','tree','pwd'].includes(t),                          signal: 'low'  },
  { name: 'Search',     match: t => ['grep','rg','ag','fd','find'].includes(t),                                                               signal: 'low'  },
  { name: 'Build/test', match: t => ['make','cargo','pytest','go','bun','npm','pnpm','yarn','tsc','vitest','tsx','node','python','python3','jest'].includes(t), signal: 'high' },
  { name: 'Install',    match: t => ['brew','pip','apt','apk'].includes(t),                                                                    signal: 'high' },
  { name: 'VCS',        match: t => ['git','gh'].includes(t),                                                                                  signal: 'mid'  },
  { name: 'HTTP',       match: t => ['curl','wget','rush','http'].includes(t),                                                                 signal: 'mid'  },
  { name: 'Remote',     match: t => ['ssh','scp','rsync'].includes(t),                                                                         signal: 'mid'  },
  { name: 'Shell',      match: t => ['rm','mv','cp','mkdir','touch','echo','printf','chmod','ln','awk','sed','tee','xargs','for'].includes(t), signal: 'low'  },
  { name: 'Wait',       match: t => ['sleep','wait'].includes(t),                                                                              signal: 'low'  },
];

/** CLI tools whose subcommand (second token) is included in the bucket key. */
const TWO_LEVEL_TOKENS = new Set([
  'git','gh','bun','npm','cargo','docker','kubectl','rush','openclaw','pnpm','yarn',
]);

/**
 * Return the bucket key for a command (used for grouping within a category).
 */
export function bucketKey(cmd: string): string {
  const unwrapped = unwrapCommand(cmd);
  const tokens = unwrapped.trim().split(/\s+/);
  const first = tokens[0] ?? 'other';
  const isRemote = cmd.trim().startsWith('ssh ') || cmd.trim().startsWith('scp ');
  if (TWO_LEVEL_TOKENS.has(first) && tokens[1]) {
    const key = `${first} ${tokens[1]}`;
    return isRemote ? `ssh\u2192${key}` : key;
  }
  return isRemote ? `ssh\u2192${first}` : first;
}

function categoryOf(cmd: string): { name: string; signal: 'high' | 'mid' | 'low' } | null {
  const rawFirst = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  // Remote wrappers: classify as Remote regardless of inner command.
  if (['ssh', 'scp', 'rsync'].includes(rawFirst)) {
    return CATEGORIES.find(c => c.name === 'Remote') ?? null;
  }
  const unwrapped = unwrapCommand(cmd);
  const first = unwrapped.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return CATEGORIES.find(c => c.match(first)) ?? null;
}

interface CmdRun {
  normalized: string;
  raw: string;
  firstTs: number;
  lastTs: number;
  count: number;
}

/**
 * Collapse consecutive same-normalized commands within a 60-second window
 * when they appear 3+ times. Fewer than 3 stay as separate entries.
 */
export function collapseRetries(commands: Array<{ cmd: string; ts: number }>): CmdRun[] {
  const groups: CmdRun[] = [];
  for (const { cmd, ts } of commands) {
    const normalized = normalizeForDedup(unwrapCommand(cmd));
    const last = groups[groups.length - 1];
    if (last && last.normalized === normalized && ts - last.lastTs <= 60_000) {
      last.count++;
      last.lastTs = ts;
    } else {
      groups.push({ normalized, raw: cmd, firstTs: ts, lastTs: ts, count: 1 });
    }
  }
  // Expand groups with count < 3 back to individual entries
  const result: CmdRun[] = [];
  for (const g of groups) {
    if (g.count >= 3) {
      result.push(g);
    } else {
      for (let i = 0; i < g.count; i++) {
        result.push({ normalized: g.normalized, raw: g.raw, firstTs: g.firstTs, lastTs: g.lastTs, count: 1 });
      }
    }
  }
  return result;
}

// ── Stats rollup ──────────────────────────────────────────────────────────────

/** Aggregated statistics computed from a session's parsed events. */
export interface SessionStats {
  models: string[];
  userTurns: number;
  assistantTurns: number;
  toolCount: number;
  errorCount: number;
  outputTokens: number;
  cacheReadTokens: number;
  firstTs: number;
  lastTs: number;
}

/** Compute aggregate statistics (turns, tools, tokens, duration) from session events. */
export function computeSummaryStats(events: SessionEvent[]): SessionStats {
  const modelSet = new Set<string>();
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCount = 0;
  let errorCount = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();
    if (!isNaN(ts)) {
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    if (e.type === 'message') {
      if (e.role === 'user') userTurns++;
      else if (e.role === 'assistant') assistantTurns++;
    } else if (e.type === 'tool_use' && !e._local) {
      toolCount++;
    } else if (e.type === 'error') {
      errorCount++;
    } else if (e.type === 'usage') {
      if (e.model) modelSet.add(shortenModel(e.model));
      outputTokens += e.outputTokens ?? 0;
      cacheReadTokens += e.cacheReadTokens ?? 0;
    }
  }

  return {
    models: Array.from(modelSet),
    userTurns,
    assistantTurns,
    toolCount,
    errorCount,
    outputTokens,
    cacheReadTokens,
    firstTs: firstTs === Infinity ? 0 : firstTs,
    lastTs: lastTs === -Infinity ? 0 : lastTs,
  };
}

/** Strip the 'claude-' prefix and date suffix from a model identifier. */
function shortenModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** Format a token count as a human-readable string (e.g. 67.5K, 1.2M). */
function formatTokenCount(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : parseFloat(k.toFixed(1))) + 'K';
  }
  const m = n / 1_000_000;
  return (m >= 100 ? Math.round(m) : parseFloat(m.toFixed(1))) + 'M';
}

/** Format a duration in milliseconds as a human-readable string (e.g. '12 min', '2h 30min'). */
function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return 'under 1 min';
  if (totalMin < 60) return `${totalMin} min`;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hrs}h ${mins}min` : `${hrs}h`;
}

/**
 * Return the stats line for a session summary header.
 * e.g. "221 turns · 198 tools (10 errors) · 67.5M cached / 361K out · 12 min"
 */
export function renderSummaryHeader(stats: SessionStats): string {
  const turns = stats.userTurns + stats.assistantTurns;
  const parts: string[] = [];

  parts.push(`${turns} turn${turns !== 1 ? 's' : ''}`);

  if (stats.toolCount > 0) {
    const toolPart = stats.errorCount > 0
      ? `${stats.toolCount} tools (${stats.errorCount} error${stats.errorCount !== 1 ? 's' : ''})`
      : `${stats.toolCount} tools`;
    parts.push(toolPart);
  }

  if (stats.cacheReadTokens > 0 || stats.outputTokens > 0) {
    const tokenPart = stats.cacheReadTokens > 0
      ? `${formatTokenCount(stats.cacheReadTokens)} cached / ${formatTokenCount(stats.outputTokens)} out`
      : `${formatTokenCount(stats.outputTokens)} out`;
    parts.push(tokenPart);
  }

  if (stats.lastTs > stats.firstTs) {
    parts.push(formatDuration(stats.lastTs - stats.firstTs));
  }

  return parts.join(' · ');
}

// ── Prompt reference extraction ───────────────────────────────────────────────

/** Extract @-mentions, slash paths, and ~/... references from a prompt string. */
function extractReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/@[\w/.-]+/g)) refs.add(m[0]);
  for (const m of text.matchAll(/(?:^|\s)(\/[\w/.-]{3,})/gm)) refs.add(m[1]);
  for (const m of text.matchAll(/~\/[\w/.-]+/g)) refs.add(m[0]);
  return Array.from(refs);
}

// ── Command section renderer ──────────────────────────────────────────────────

interface BucketEntry {
  catName: string;
  catSignal: 'high' | 'mid' | 'low';
  key: string;
  count: number;
  samples: string[];
}

/** Render the Commands section of the summary, grouping by category and collapsing retries. */
function renderCommandsSection(
  cmds: Array<{ cmd: string; ts: number }>,
  lines: string[],
): void {
  if (cmds.length === 0) return;

  const runs = collapseRetries(cmds);

  // Group runs by category → key → {count, samples}
  const catMap = new Map<string, { signal: 'high' | 'mid' | 'low'; keys: Map<string, { count: number; samples: string[] }> }>();
  let otherCount = 0;
  const otherKeys = new Map<string, { count: number; samples: string[] }>();

  for (const run of runs) {
    const cat = categoryOf(run.raw);
    const key = bucketKey(run.raw);

    if (cat) {
      let catEntry = catMap.get(cat.name);
      if (!catEntry) {
        catEntry = { signal: cat.signal, keys: new Map() };
        catMap.set(cat.name, catEntry);
      }
      const existing = catEntry.keys.get(key) ?? { count: 0, samples: [] };
      existing.count += run.count;
      if (existing.samples.length < 5 && !existing.samples.some(s => sharesPrefix(s, run.raw, 30))) {
        existing.samples.push(run.raw);
      }
      catEntry.keys.set(key, existing);
    } else {
      otherCount += run.count;
      const existing = otherKeys.get(key) ?? { count: 0, samples: [] };
      existing.count += run.count;
      if (existing.samples.length < 3) existing.samples.push(run.raw);
      otherKeys.set(key, existing);
    }
  }

  // Total command count (sum of all run counts)
  const total = runs.reduce((sum, r) => sum + r.count, 0);
  lines.push(chalk.bold('Commands') + chalk.gray(` (${total})`));

  // Sort categories: high-signal first, then mid, then low, by total count desc. Other last.
  const SIGNAL_ORDER: Record<string, number> = { high: 0, mid: 1, low: 2 };
  const sortedCats = Array.from(catMap.entries()).sort((a, b) => {
    const sigA = SIGNAL_ORDER[a[1].signal] ?? 3;
    const sigB = SIGNAL_ORDER[b[1].signal] ?? 3;
    if (sigA !== sigB) return sigA - sigB;
    const countA = Array.from(a[1].keys.values()).reduce((s, v) => s + v.count, 0);
    const countB = Array.from(b[1].keys.values()).reduce((s, v) => s + v.count, 0);
    return countB - countA;
  });

  for (const [catName, catEntry] of sortedCats) {
    const catTotal = Array.from(catEntry.keys.values()).reduce((s, v) => s + v.count, 0);

    if (catEntry.signal === 'low') {
      // Single inline line: category name + top 5 first tokens
      const topTokens = Array.from(catEntry.keys.keys()).slice(0, 5).join(', ');
      lines.push(`  ${chalk.dim(catName)} ${chalk.gray(`(${catTotal})`)} ${chalk.gray('— ' + topTokens)}`);
    } else {
      lines.push(`  ${chalk.dim(catName)} ${chalk.gray(`(${catTotal})`)}`);
      const keysSorted = Array.from(catEntry.keys.entries()).sort((a, b) => b[1].count - a[1].count);
      const limit = catEntry.signal === 'high' ? Infinity : 3;
      let shown = 0;
      for (const [key, v] of keysSorted) {
        if (shown >= limit) break;
        if (catEntry.signal === 'mid') {
          // Mid signal: display the bucket key (e.g. ssh→openclaw browser) with aggregate count
          const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
          lines.push(`    ${chalk.cyan(truncateCmd(key, 80))}${countSuffix}`);
        } else {
          // High signal: display distinct raw sample commands
          const distinctSamples = pickDistinct(v.samples, 3);
          for (const sample of distinctSamples) {
            const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
            lines.push(`    ${chalk.cyan(truncateCmd(sample, 80))}${countSuffix}`);
          }
        }
        shown++;
      }
    }
  }

  if (otherCount > 0) {
    lines.push(`  ${chalk.dim('Other')} ${chalk.gray(`(${otherCount})`)}`);
    for (const [, v] of Array.from(otherKeys.entries()).slice(0, 5)) {
      const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
      lines.push(`    ${chalk.cyan(truncateCmd(v.samples[0] ?? '', 80))}${countSuffix}`);
    }
  }

  lines.push('');
}

function sharesPrefix(a: string, b: string, len: number): boolean {
  return a.slice(0, len) === b.slice(0, len);
}

function pickDistinct(samples: string[], max: number): string[] {
  const result: string[] = [];
  for (const s of samples) {
    if (result.length >= max) break;
    if (!result.some(r => sharesPrefix(r, s, 30))) result.push(s);
  }
  return result.length > 0 ? result : samples.slice(0, max);
}

function truncateCmd(cmd: string, max: number): string {
  return cmd.length <= max ? cmd : cmd.slice(0, max - 1) + '…';
}

// ── File grouping ─────────────────────────────────────────────────────────────

/** Group file paths by their parent directory, relative to cwd. */
function groupByParentDir(paths: Iterable<string>, cwd?: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const rel = relativeToCwd(p, cwd);
    const slashIdx = rel.lastIndexOf('/');
    const dir = slashIdx >= 0 ? rel.slice(0, slashIdx) : '.';
    const base = slashIdx >= 0 ? rel.slice(slashIdx + 1) : rel;
    const arr = groups.get(dir) ?? [];
    arr.push(base);
    groups.set(dir, arr);
  }
  return new Map(Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length));
}

/** Render grouped file paths as indented, clickable terminal lines. */
function renderFileGroup(lines: string[], groups: Map<string, string[]>, absPathMap: Map<string, string>): void {
  if (groups.size === 1) {
    const [dir, files] = Array.from(groups.entries())[0];
    for (const f of files) {
      const abs = absPathMap.get(dir === '.' ? f : `${dir}/${f}`) ?? '';
      const label = dir === '.' ? f : `${dir}/${f}`;
      lines.push('  ' + chalk.cyan(abs ? linkPath(abs, label) : label));
    }
  } else {
    for (const [dir, files] of groups) {
      lines.push(`  ${chalk.dim(dir + '/')}`);
      for (const f of files) {
        const abs = absPathMap.get(dir === '.' ? f : `${dir}/${f}`) ?? '';
        const label = f;
        lines.push('    ' + chalk.cyan(abs ? linkPath(abs, label) : label));
      }
    }
  }
}

// ── Main summary renderer ─────────────────────────────────────────────────────

/**
 * Render session as an activity summary.
 * Returns a chalk-formatted string (not markdown) for direct terminal output.
 */
export function renderSummary(events: SessionEvent[], cwd?: string): string {
  // ── Collect data in a single chronological pass ───────────────────────────

  let firstUserMessage = '';
  const attachments: Array<{ mediaType: string }> = [];
  let lastAssistantMessage = '';

  // File paths (absolute) for grouping — split by whether they're inside cwd
  const filesModifiedAbs = new Set<string>();
  const filesReadAbs = new Set<string>();
  const filesModifiedExternal = new Set<string>();

  // Commands with timestamps
  const cmdList: Array<{ cmd: string; ts: number }> = [];

  // Plan items
  const todoItems: string[] = [];
  let exitPlanContent: string | null = null;
  let planFilePath: string | null = null;

  // Subagent spawns
  const subagents: Array<{ description: string; subagentType: string }> = [];

  // Errors
  const errors: Array<{ tool: string; cmd?: string; content?: string }> = [];

  // Assistant message count (used to decide whether the session produced any narration)
  let assistantCount = 0;

  const isInsideCwd = (p: string): boolean => !!(cwd && p.startsWith(cwd + '/'));

  for (const event of events) {
    const ts = new Date(event.timestamp).getTime() || 0;

    if (event.type === 'tool_use') {
      if (event._local) continue;

      const tool = event.tool || '';
      const args = event.args || {};
      const p = event.path || args.file_path || args.path || '';

      if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool)) {
        if (p) filesReadAbs.add(p);
      } else if (['Write', 'Edit', 'write_file', 'edit_file', 'create_file', 'replace', 'patch'].includes(tool)) {
        if (p) {
          if (p.includes('.claude/plans/') && p.endsWith('.md')) {
            planFilePath = p;
          } else {
            (isInsideCwd(p) || !cwd ? filesModifiedAbs : filesModifiedExternal).add(p);
          }
        }
      }

      if (event.command) {
        const cmd = event.command.replace(/\n/g, ' ').trim();
        if (cmd) cmdList.push({ cmd, ts });
      }

      // Plan items: TodoWrite items + TaskCreate descriptions (project's task tracker)
      if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
        for (const item of args.todos) {
          const text = item.content || item.text || String(item);
          if (text && !todoItems.includes(text)) todoItems.push(text);
        }
      }
      if (tool === 'TaskCreate' && (args.description || args.prompt)) {
        const text = String(args.description || args.prompt || '').slice(0, 140);
        if (text && !todoItems.includes(text)) todoItems.push(text);
      }
      if (tool === 'ExitPlanMode') {
        exitPlanContent = args.result || args.plan || args.content || null;
      }

      // Subagent spawns
      if ((tool === 'Agent' || tool === 'Task') && (args.description || args.prompt)) {
        subagents.push({
          description: String(args.description || args.prompt || '').slice(0, 120),
          subagentType: String(args.subagent_type || ''),
        });
      }

    } else if (event.type === 'error') {
      errors.push({
        tool: event.tool || 'unknown',
        cmd: event.args?.command ? String(event.args.command).slice(0, 80) : undefined,
        content: event.content?.slice(0, 120),
      });

    } else if (event.type === 'message') {
      if (event.role === 'user') {
        if (!firstUserMessage) {
          const content = event.content || '';
          if (!/^\s*<local-command-caveat>/i.test(content)) {
            const topic = extractSessionTopic(content);
            if (topic) firstUserMessage = content;
          }
        }
      } else if (event.role === 'assistant' && event.content) {
        lastAssistantMessage = event.content;
        assistantCount++;
      }

    } else if (event.type === 'attachment') {
      attachments.push({ mediaType: event.mediaType || 'image/png' });
    }
  }

  // Dedupe: files in Modified should not appear in Read
  for (const p of filesModifiedAbs) filesReadAbs.delete(p);
  for (const p of filesModifiedExternal) filesReadAbs.delete(p);

  // Build abs→rel mapping for linkPath
  const buildAbsMap = (absSet: Set<string>): Map<string, string> => {
    const m = new Map<string, string>();
    for (const abs of absSet) {
      const rel = relativeToCwd(abs, cwd);
      m.set(rel, abs);
    }
    return m;
  };

  const modifiedAbsMap = buildAbsMap(filesModifiedAbs);
  const readAbsMap = buildAbsMap(filesReadAbs);

  // ── Render sections ───────────────────────────────────────────────────────

  const lines: string[] = [''];

  // 1. Prompt
  if (firstUserMessage) {
    const cleaned = cleanSessionPrompt(firstUserMessage);
    if (cleaned) {
      lines.push(chalk.bold('Prompt:') + ' ' + cleaned.split('\n')[0]);
      const secondLine = cleaned.split('\n')[1]?.trim();
      if (secondLine) lines.push('  ' + secondLine);

      const refs = extractReferences(cleaned);
      if (refs.length > 0) {
        lines.push(chalk.gray('  Referenced: ' + refs.join(', ')));
      }
    }
  }

  // Attachments (images/documents in the first user turn)
  if (attachments.length > 0) {
    const mediaTypes = [...new Set(attachments.map(a => a.mediaType))].join(', ');
    lines.push(chalk.gray(`  + ${attachments.length} screenshot${attachments.length !== 1 ? 's' : ''} (${mediaTypes})`));
  }

  if (firstUserMessage || attachments.length > 0) lines.push('');

  // 2. Plan
  if (todoItems.length > 0 || exitPlanContent || planFilePath) {
    lines.push(chalk.bold('Plan'));
    if (planFilePath) {
      const home = process.env.HOME ?? '';
      const displayPath = home && planFilePath.startsWith(home) ? planFilePath.replace(home, '~') : planFilePath;
      lines.push('  ' + chalk.cyan(displayPath));
    }
    if (exitPlanContent) {
      const planLines = exitPlanContent.split('\n').slice(0, 10);
      for (const l of planLines) lines.push('  ' + l);
    } else if (todoItems.length > 0) {
      for (const item of todoItems.slice(0, 20)) {
        lines.push('  · ' + item);
      }
    }
    lines.push('');
  }

  // 3. Subagents
  if (subagents.length > 0) {
    lines.push(chalk.bold('Subagents') + chalk.gray(` (${subagents.length})`));
    for (const s of subagents) {
      const typeSuffix = s.subagentType ? chalk.gray(` (${s.subagentType})`) : '';
      lines.push('  Task: ' + s.description + typeSuffix);
    }
    lines.push('');
  }

  // 4. Modified files
  if (filesModifiedAbs.size > 0) {
    lines.push(chalk.bold('Modified') + chalk.gray(` (${filesModifiedAbs.size})`));
    const groups = groupByParentDir(filesModifiedAbs, cwd);
    renderFileGroup(lines, groups, modifiedAbsMap);
    lines.push('');
  }

  // 4b. External edits (files edited outside the project root — typically /tmp)
  // Filter out plan files (already shown in Plan section)
  const externalNonPlan = [...filesModifiedExternal].filter(p => !(p.includes('.claude/plans/') && p.endsWith('.md')));
  if (externalNonPlan.length > 0) {
    const externalList = externalNonPlan.sort();
    const home = process.env.HOME ?? '';
    const display = externalList.slice(0, 3).map(p => home && p.startsWith(home) ? p.replace(home, '~') : p);
    const more = externalList.length > 3 ? chalk.gray(` +${externalList.length - 3} more`) : '';
    lines.push(chalk.gray(`External edits (${externalList.length}): ${display.join(', ')}${more}`));
    lines.push('');
  }

  // 5. Read files
  if (filesReadAbs.size > 0) {
    if (filesReadAbs.size <= 5) {
      lines.push(chalk.bold('Read') + chalk.gray(` (${filesReadAbs.size})`));
      const groups = groupByParentDir(filesReadAbs, cwd);
      renderFileGroup(lines, groups, readAbsMap);
    } else {
      lines.push(chalk.bold('Read') + chalk.gray(` ${filesReadAbs.size} other files`));
    }
    lines.push('');
  }

  // 6. Commands
  renderCommandsSection(cmdList, lines);

  // 7. Errors
  if (errors.length > 0) {
    const first = errors[0];
    const firstDesc = first.cmd
      ? `${first.tool} "${first.cmd.slice(0, 60)}"`
      : first.content
        ? `${first.tool}: ${first.content.slice(0, 60)}`
        : first.tool;
    lines.push(
      chalk.red(chalk.bold('Errors')) +
      chalk.gray(`: ${errors.length} failure${errors.length !== 1 ? 's' : ''} — first: ${firstDesc}`)
    );
    lines.push('');
  }

  // 9. Final message
  if (lastAssistantMessage) {
    const hasActivity = filesModifiedAbs.size > 0 || filesReadAbs.size > 0 || cmdList.length > 0;
    if (hasActivity || errors.length > 0) lines.push(chalk.gray('─'.repeat(60)));
    lines.push('');
    const truncated = lastAssistantMessage.length > 3000
      ? lastAssistantMessage.slice(0, 2997) + '...'
      : lastAssistantMessage;
    lines.push(renderMarkdown(truncated).trimEnd());
    lines.push('');
  } else if (
    filesModifiedAbs.size === 0 &&
    filesReadAbs.size === 0 &&
    cmdList.length === 0 &&
    assistantCount === 0
  ) {
    lines.push(chalk.gray('No activity recorded in this session.'));
    lines.push('');
  }

  return lines.join('\n');
}

// ── Event filters ─────────────────────────────────────────────────────────────

/** Allowed values for --include/--exclude role filters. */
export const VALID_ROLE_VALUES = ['user', 'assistant', 'thinking', 'tools'] as const;
/** A single role filter value derived from VALID_ROLE_VALUES. */
export type RoleFilter = typeof VALID_ROLE_VALUES[number];

/** Options for filtering session events by role and turn range. */
export interface FilterOptions {
  include?: RoleFilter[];
  exclude?: RoleFilter[];
  first?: number;
  last?: number;
}

/**
 * Parse a comma-separated role list (e.g. "user,assistant") into typed values.
 * Throws with a clear message listing valid values on any unknown entry.
 */
export function parseRoleList(raw: string, flag: string): RoleFilter[] {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`${flag} requires at least one role. Valid values: ${VALID_ROLE_VALUES.join(', ')}`);
  }
  for (const p of parts) {
    if (!VALID_ROLE_VALUES.includes(p as RoleFilter)) {
      throw new Error(`Invalid value "${p}" for ${flag}. Valid values: ${VALID_ROLE_VALUES.join(', ')}`);
    }
  }
  return parts as RoleFilter[];
}

function roleOfEvent(e: SessionEvent): RoleFilter | null {
  if (e.type === 'message' && e.role === 'user') return 'user';
  if (e.type === 'message' && e.role === 'assistant') return 'assistant';
  if (e.type === 'thinking') return 'thinking';
  if (e.type === 'tool_use' || e.type === 'tool_result') return 'tools';
  return null;
}

/**
 * Keep events whose role is in `include` (whitelist) or whose role is not in
 * `exclude` (blacklist). Non-role events (errors, usage, attachments, init,
 * result) are preserved unless explicitly constrained by `include` — that
 * matches the user model: "include user" means "only user".
 */
function applyRoleFilter(events: SessionEvent[], opts: FilterOptions): SessionEvent[] {
  if (opts.include && opts.include.length > 0) {
    const set = new Set(opts.include);
    return events.filter(e => {
      const role = roleOfEvent(e);
      return role !== null && set.has(role);
    });
  }
  if (opts.exclude && opts.exclude.length > 0) {
    const set = new Set(opts.exclude);
    return events.filter(e => {
      const role = roleOfEvent(e);
      return role === null || !set.has(role);
    });
  }
  return events;
}

/**
 * A "turn" starts at each user message. `--first N` keeps events through the
 * end of the Nth user turn; `--last N` keeps events from the start of the
 * (M-N+1)th user turn to the end. If the session has no user messages, every
 * assistant message counts as a turn instead.
 */
function applyTurnSlice(events: SessionEvent[], opts: FilterOptions): SessionEvent[] {
  if (opts.first === undefined && opts.last === undefined) return events;
  if (opts.first !== undefined && opts.last !== undefined) {
    throw new Error('--first and --last are mutually exclusive');
  }
  const n = (opts.first ?? opts.last)!;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Turn count must be a positive integer, got ${n}`);
  }

  const isTurnStart = (e: SessionEvent): boolean =>
    e.type === 'message' && e.role === 'user';
  const turnStartIdx: number[] = [];
  for (let i = 0; i < events.length; i++) if (isTurnStart(events[i])) turnStartIdx.push(i);

  // Fallback: no user messages — treat assistant messages as turn boundaries.
  if (turnStartIdx.length === 0) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'message' && events[i].role === 'assistant') turnStartIdx.push(i);
    }
  }
  if (turnStartIdx.length === 0) return events;

  if (opts.first !== undefined) {
    if (n >= turnStartIdx.length) return events;
    const endIdx = turnStartIdx[n]; // exclusive
    return events.slice(0, endIdx);
  }
  // --last
  if (n >= turnStartIdx.length) return events;
  const startIdx = turnStartIdx[turnStartIdx.length - n];
  return events.slice(startIdx);
}

/**
 * Apply include/exclude/first/last. Turn slicing runs first so role filters
 * operate on the sliced window (natural semantics: "last 3 turns, user only").
 */
export function filterEvents(events: SessionEvent[], opts: FilterOptions): SessionEvent[] {
  if (opts.include && opts.include.length > 0 && opts.exclude && opts.exclude.length > 0) {
    throw new Error('--include and --exclude are mutually exclusive');
  }
  const sliced = applyTurnSlice(events, opts);
  return applyRoleFilter(sliced, opts);
}

// ── Conversation renderers ────────────────────────────────────────────────────

/**
 * Build the conversation as a single markdown string: user / assistant
 * messages, inline thinking blocks, tool calls, and errors. Emitted in event
 * order so reasoning sits where it actually occurred relative to the assistant
 * reply.
 */
export interface RenderConversationMarkdownOptions {
  redact?: boolean;
}

export function renderConversationMarkdown(
  events: SessionEvent[],
  opts: RenderConversationMarkdownOptions = {},
): string {
  const parts: string[] = [];
  const shouldRedact = opts.redact !== false;
  const sanitize = (text: string): string => shouldRedact ? redactSecrets(text) : text;

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user') {
        parts.push(`## User\n\n${event.content ?? ''}`);
      } else if (event.role === 'assistant') {
        parts.push(`## Assistant\n\n${event.content ?? ''}`);
      }
    } else if (event.type === 'thinking') {
      if (event.content) parts.push(`### Thinking\n\n${event.content}`);
    } else if (event.type === 'tool_use') {
      const tool = event.tool || 'unknown';
      if (event.command) {
        parts.push(`### Tool: ${tool}\n\n\`\`\`bash\n${sanitize(event.command)}\n\`\`\``);
      } else if (event.path) {
        parts.push(`### Tool: ${tool}\n\n\`${shortenPathTrace(event.path)}\``);
      } else {
        const summary = summarizeToolUse(tool, event.args);
        parts.push(`### Tool: ${tool}\n\n${summary}`);
      }
    } else if (event.type === 'tool_result') {
      if (event.content) {
        const truncated = event.content.length > 2000 ? event.content.slice(0, 2000) + '\n…' : event.content;
        const body = sanitize(truncated);
        parts.push(`### Tool Result\n\n\`\`\`\n${body}\n\`\`\``);
      }
    } else if (event.type === 'error') {
      parts.push(`### Error\n\n${event.content || event.tool || 'Unknown error'}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Render session as JSON (normalized events).
 */
export function renderJson(events: SessionEvent[]): string {
  return JSON.stringify(events, null, 2);
}

/** Replace the home directory prefix with ~ for trace display. */
function shortenPathTrace(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
