/**
 * Interactive session picker and preview renderer.
 *
 * Powers the fuzzy-searchable session list shown by `agents sessions` in a TTY.
 * Builds a compact preview for each session (prompt, activity summary, last
 * response) and delegates to the generic `itemPicker` for the interactive UI.
 */
import fs from 'node:fs';
import chalk from 'chalk';
import type { SessionEvent, SessionMeta } from '../lib/session/types.js';
import { parseSession, sanitizeForTerminal } from '../lib/session/parse.js';
import { cleanSessionPrompt, extractSessionTopic } from '../lib/session/prompt.js';
import { linkPath, relativeToCwd } from '../lib/session/render.js';
import { renderMarkdown } from '../lib/markdown.js';
import { itemPicker } from '../lib/picker.js';
import { classifyFileChanges, changeCounts, toolHistogram, detectTestResult } from '../lib/session/digest.js';
/** A session whose transcript lives on another machine (folded in over the live
 * cross-machine fan-out): its `filePath` is on that peer's disk, so the preview
 * can't parse it locally — it shows metadata + a "resume there" note instead.
 * Keys off `_remote`, not the machine tag, so locally-readable synced mirrors
 * still parse their file normally. */
function remoteMachineOf(session: SessionMeta): string | undefined {
  return session._remote ? session.machine : undefined;
}

/**
 * SessionMeta originates in discover.ts (gitBranch, cwd, label, etc. read from
 * untrusted session files). parseSession sanitizes event payloads at its
 * chokepoint, but meta fields bypass that path. Strip terminal escapes here
 * before any meta string reaches a TTY.
 */
function sanitizeMeta(s: SessionMeta): SessionMeta {
  const clean = (v: string | undefined) => (v == null ? v : sanitizeForTerminal(v));
  return {
    ...s,
    id: sanitizeForTerminal(s.id),
    shortId: sanitizeForTerminal(s.shortId),
    filePath: sanitizeForTerminal(s.filePath),
    cwd: clean(s.cwd),
    project: clean(s.project),
    gitBranch: clean(s.gitBranch),
    version: clean(s.version),
    account: clean(s.account),
    topic: clean(s.topic),
    label: clean(s.label),
  };
}

export interface PickedSession {
  session: SessionMeta;
  action: 'resume' | 'view';
}

export interface SessionPickerConfig {
  message: string;
  /** Dim hint line shown under the header (filters/flags tip). */
  subtitle?: string;
  sessions: SessionMeta[];
  filter: (query: string) => SessionMeta[];
  labelFor: (s: SessionMeta, query: string) => string;
  pageSize?: number;
  initialSearch?: string;
  /** Verb shown on the Enter key in the footer (default 'resume'). */
  enterHint?: string;
}

const previewCache = new Map<string, string>();

/** Build a cached multi-line preview string for display in the session picker. */
export function buildPreview(session: SessionMeta): string {
  const remote = remoteMachineOf(session);
  const cacheKey = remote ? `${remote}:${session.id}` : session.id;
  const cached = previewCache.get(cacheKey);
  if (cached) return cached;

  const safe = sanitizeMeta(session);

  // Remote session: the transcript is on the peer's disk, so there is nothing to
  // parse here. Show the metadata header (agent, cwd, msgs, tokens — all carried
  // over in the fan-out) plus where it lives and how to open it.
  if (remote) {
    const note = '  ' + chalk.gray(`on `) + chalk.bold.white(remote)
      + chalk.gray(` — enter to resume there, or space then enter to read it over SSH`);
    const output = [formatHeader(safe, []), '', note].join('\n');
    previewCache.set(cacheKey, output);
    return output;
  }

  // No transcript on disk — a live session not indexed locally, or a synthesized
  // entry (e.g. `sessions go`). Show the header + a clean note, not a parse error.
  if (!session.filePath || !fs.existsSync(session.filePath)) {
    const note = '  ' + chalk.gray('Live session — full transcript not indexed here.');
    const output = [formatHeader(safe, []), '', note].filter(Boolean).join('\n');
    previewCache.set(cacheKey, output);
    return output;
  }

  let events: SessionEvent[] = [];
  let parseError: string | undefined;
  try {
    events = parseSession(session.filePath, session.agent);
  } catch (err: any) {
    parseError = sanitizeForTerminal(err?.message ?? String(err));
  }

  const header = formatHeader(safe, events);
  const body = parseError
    ? '  ' + chalk.red(`Failed to parse session: ${parseError}`)
    : formatCompactPreview(events, safe);
  const output = [header, '', body].filter(Boolean).join('\n');
  previewCache.set(cacheKey, output);
  return output;
}

function displayAgent(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

const DOT = chalk.gray(' · ');

function formatHeader(session: SessionMeta, events: SessionEvent[]): string {
  const model = extractModel(events);
  const { startedAgo, duration } = extractTiming(events);
  const totalMessages = session.messageCount ?? countMessages(events);
  const totalTokens = session.tokenCount;

  // Line 1: Agent v version · model · account
  const line1: string[] = [];
  line1.push(chalk.gray(`${displayAgent(session.agent)}${session.version ? ` v${session.version}` : ''}`));
  if (model) line1.push(chalk.bold.white(model));
  if (session.account) line1.push(chalk.gray(session.account));

  // Line 2: cwd · branch · started X ago · lasted Y
  const line2: string[] = [];
  if (session.cwd) {
    const label = relativeToCwd(session.cwd);
    line2.push(chalk.bold.white(linkPath(session.cwd, label)));
  }
  if (session.gitBranch) line2.push(chalk.cyan(session.gitBranch));
  if (startedAgo) line2.push(chalk.gray('started ') + chalk.white(startedAgo + ' ago'));
  if (duration) line2.push(chalk.gray('lasted ') + chalk.white(duration));

  // Line 3: N msgs · T tokens · [label ·] uuid
  const line3: string[] = [];
  if (totalMessages !== undefined) {
    line3.push(chalk.bold.white(String(totalMessages)) + chalk.gray(` msg${totalMessages === 1 ? '' : 's'}`));
  }
  if (totalTokens !== undefined) {
    line3.push(chalk.bold.white(formatTokens(totalTokens)) + chalk.gray(' tokens'));
  }
  if (session.label) line3.push(chalk.white(session.label));
  line3.push(chalk.gray(linkPath(session.filePath, session.id)));

  return [
    line1.join(DOT),
    line2.join(DOT),
    line3.join(DOT),
  ].join('\n');
}

function extractModel(events: SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const m = events[i].model;
    if (events[i].type === 'usage' && m) return m;
  }
  for (const e of events) {
    if (e.type === 'init' && e.model) return e.model;
  }
  return undefined;
}

function extractTiming(events: SessionEvent[]): { startedAgo?: string; duration?: string } {
  if (events.length === 0) return {};
  const firstMs = Date.parse(events[0].timestamp);
  const lastMs = Date.parse(events[events.length - 1].timestamp);
  if (Number.isNaN(firstMs)) return {};
  const ago = humanDuration(Math.max(0, Date.now() - firstMs));
  const dur = Number.isNaN(lastMs) ? undefined : humanDuration(Math.max(0, lastMs - firstMs));
  return { startedAgo: ago, duration: dur };
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

function countMessages(events: SessionEvent[]): number {
  return events.filter(e => e.type === 'message').length;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  const v = n / 1_000_000;
  return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')) + 'm';
}

/** Patterns that indicate a user message is system context, not a real prompt. */
const SYSTEM_MESSAGE_PATTERNS = [
  /^\s*<environment_context>/i,
  /^\s*<system-reminder>/i,
  /^\s*<permissions\s/i,
  /^\s*<collaboration_mode>/i,
  /^\s*<local-command-caveat>/i,
  /^\s*# AGENTS\.md instructions for\b/i,
  /^\s*<command-(message|name|args)>/i,
];

/** Strip XML/HTML tags and clean up content for display. */
function stripTags(text: string): string {
  // Remove complete tag pairs with their content for known system tags
  let cleaned = text.replace(/<(system-reminder|environment_context|permissions[^>]*)>[\s\S]*?<\/\1>/gi, '');
  // Remove remaining XML-like tags
  cleaned = cleaned.replace(/<\/?[a-z_-]+[^>]*>/gi, '');
  return cleaned;
}

const LAST_RESPONSE_MAX_LINES = 15;
const LAST_RESPONSE_MAX_LINES_WITH_TODOS = 8;
const TODOS_MAX_ITEMS = 5;

interface TodoItem {
  content?: string;
  text?: string;
  status?: string;
}

function formatCompactPreview(events: ReturnType<typeof parseSession>, session: SessionMeta): string {
  let firstUser = '';
  let lastAssistant = '';
  const filesRead = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let toolCalls = 0;
  let planFile = '';
  let latestTodos: TodoItem[] | null = null;

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user' && !firstUser && event.content) {
        if (!SYSTEM_MESSAGE_PATTERNS.some(p => p.test(event.content!))) {
          firstUser = event.content;
        }
      }
      if (event.role === 'assistant' && event.content) {
        lastAssistant = event.content;
      }
    } else if (event.type === 'tool_use' && !event._local) {
      const tool = event.tool || '';
      const p = event.path || event.args?.file_path || event.args?.path || '';
      if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool) && p) {
        filesRead.add(p);
      }
      if (!planFile && p && /\/plans\/[^/]+\.md$/.test(p)) {
        planFile = p;
      }
      if (tool === 'TodoWrite' && Array.isArray(event.args?.todos)) {
        latestTodos = event.args.todos as TodoItem[];
      }
      if (tool) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      toolCalls++;
    }
  }

  // Digest signals folded into the preview: change lifecycle, tool mix, tests.
  const changes = classifyFileChanges(events);
  const chg = changeCounts(changes);

  const lines: string[] = [];
  const termWidth = process.stdout.columns || 80;

  if (firstUser) {
    const first = extractSessionTopic(firstUser) || cleanSessionPrompt(firstUser).split('\n').find(l => l.trim()) || '';
    if (first) {
      lines.push(chalk.cyan('Prompt: ') + chalk.white(truncate(first.trim(), termWidth - 12)));
    }
  }

  const activity: string[] = [];
  const changed = chg.created + chg.modified + chg.deleted;
  if (changed) {
    const parts = [
      chg.created ? chalk.green(`+${chg.created}`) : '',
      chg.modified ? chalk.yellow(`~${chg.modified}`) : '',
      chg.deleted ? chalk.red(`−${chg.deleted}`) : '',
    ].filter(Boolean).join(' ');
    activity.push(`${parts} ${chalk.gray('changed')}`);
  }
  if (filesRead.size) activity.push(chalk.gray(`${filesRead.size} read`));
  if (toolCalls) activity.push(chalk.gray(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`));
  if (activity.length) {
    lines.push(chalk.cyan('Changes:  ') + activity.join(chalk.gray(' · ')));
  }

  // Tool mix (top 4) — what kind of work this was.
  const hist = toolHistogram(toolCounts, 4);
  if (hist.length) {
    lines.push(chalk.cyan('Tools:    ') + chalk.gray(hist.map(h => `${h.tool} ${h.count}`).join(' · ')));
  }

  // Last test/build verdict.
  const test = detectTestResult(events);
  if (test?.ok) {
    const bits = [
      test.passed !== undefined ? chalk.green(`${test.passed} pass`) : '',
      test.failed ? chalk.red(`${test.failed} fail`) : '',
    ].filter(Boolean).join(chalk.gray(' · '));
    const mark = test.failed ? chalk.red('✗') : chalk.green('✓');
    lines.push(chalk.cyan('Tests:    ') + `${mark} ${test.runner}${bits ? ' ' + bits : ''}`);
  }

  if (planFile) {
    const basename = planFile.split('/').pop() || planFile;
    lines.push(chalk.cyan('Plan: ') + chalk.white(linkPath(planFile, basename)));
  }

  const todosRendered = latestTodos ? renderTodos(latestTodos, termWidth) : [];
  if (todosRendered.length > 0) {
    lines.push(chalk.cyan('Todos:'));
    for (const l of todosRendered) lines.push('  ' + l);
  }

  if (lastAssistant) {
    const maxLines = todosRendered.length > 0 ? LAST_RESPONSE_MAX_LINES_WITH_TODOS : LAST_RESPONSE_MAX_LINES;
    const rendered = renderLastResponse(lastAssistant, maxLines);
    if (rendered.length > 0) {
      lines.push('');
      lines.push(chalk.cyan('Last response:'));
      for (const l of rendered) lines.push('  ' + l);
    }
  }

  if (lines.length === 0) {
    lines.push(chalk.gray('No activity recorded in this session.'));
  }

  return lines.map(l => '  ' + l).join('\n');
}

function renderLastResponse(content: string, maxLines: number = LAST_RESPONSE_MAX_LINES): string[] {
  const cleaned = stripTags(content).trim();
  if (!cleaned) return [];

  let rendered: string;
  try {
    rendered = renderMarkdown(cleaned);
  } catch {
    rendered = cleaned;
  }

  const all = rendered.replace(/\s+$/, '').split('\n');
  // Drop leading/trailing empty lines
  while (all.length && !all[0].trim()) all.shift();
  while (all.length && !all[all.length - 1].trim()) all.pop();

  if (all.length <= maxLines) return all;
  const shown = all.slice(0, maxLines);
  const more = all.length - maxLines;
  shown.push(chalk.gray(`… (${more} more line${more === 1 ? '' : 's'})`));
  return shown;
}

function renderTodos(todos: TodoItem[], termWidth: number): string[] {
  const out: string[] = [];
  const shown = todos.slice(0, TODOS_MAX_ITEMS);
  // Outer body indent (2) + inner '  ' (2) + marker (3) + space (1) = 8
  const maxText = Math.max(20, termWidth - 8);
  for (const item of shown) {
    const rawText = (item.content || item.text || '').trim();
    if (!rawText) continue;
    const text = truncate(rawText, maxText);
    const status = item.status || 'pending';
    let marker: string;
    let textOut: string;
    if (status === 'completed') {
      marker = chalk.green('[x]');
      textOut = chalk.gray(text);
    } else if (status === 'in_progress') {
      marker = chalk.yellow('[>]');
      textOut = chalk.white(text);
    } else {
      marker = chalk.gray('[ ]');
      textOut = chalk.white(text);
    }
    out.push(marker + ' ' + textOut);
  }
  if (todos.length > TODOS_MAX_ITEMS) {
    const more = todos.length - TODOS_MAX_ITEMS;
    out.push(chalk.gray(`… (${more} more)`));
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Show an interactive session picker and return the selected session with its action (resume or view). */
export async function sessionPicker(config: SessionPickerConfig): Promise<PickedSession | null> {
  const picked = await itemPicker<SessionMeta>({
    message: config.message,
    subtitle: config.subtitle,
    items: config.sessions,
    filter: config.filter,
    labelFor: config.labelFor,
    buildPreview,
    shortIdFor: (s) => s.shortId,
    pageSize: config.pageSize,
    initialSearch: config.initialSearch,
    emptyMessage: 'No sessions match.',
    enterHint: config.enterHint ?? 'resume',
  });
  if (!picked) return null;
  return { session: picked.item, action: 'resume' };
}
