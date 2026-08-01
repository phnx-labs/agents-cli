/**
 * Interactive session picker and preview renderer.
 *
 * Powers the fuzzy-searchable session list shown by `agents sessions` in a TTY.
 * Builds a compact preview for each session (prompt, activity summary, last
 * response) and delegates to the generic `itemPicker` for the interactive UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { truncate, humanDuration } from '../lib/format.js';
import type { SessionEvent, SessionMeta, TodoProgress } from '../lib/session/types.js';
import { parseSession, sanitizeForTerminal } from '../lib/session/parse.js';
import { cleanSessionPrompt, extractSessionTopic } from '../lib/session/prompt.js';
import { linkPath, linkUrl, relativeToCwd } from '../lib/session/render.js';
import { linearIssueUrl } from '../lib/session/linear.js';
import { extractTodoProgress, WORKTREE_RE } from '../lib/session/state.js';
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
 * Compact checklist tally for list rows and previews (RUSH-2045).
 * Example: `✓6/8 · A5 wiring runner`. Empty string when there is no list.
 * Consumes `SessionMeta.todos` / `ActiveSession.todos` as populated by the
 * state engine — does not re-parse transcripts.
 */
export function formatTodoCompact(todos?: Pick<TodoProgress, 'done' | 'total' | 'activeForm'> | null): string {
  if (!todos || !Number.isFinite(todos.total) || todos.total < 1) return '';
  const done = Number.isFinite(todos.done) ? Math.max(0, todos.done) : 0;
  const tally = `✓${done}/${todos.total}`;
  const step = todos.activeForm?.replace(/\s+/g, ' ').trim();
  return step ? `${tally} · ${step}` : tally;
}

/**
 * Best-effort GitHub repo URL from a checkout path shaped like
 * `…/github.com/<owner>/<repo>/…`. Used to make the project name clickable
 * when no Linear project URL is available.
 */
export function githubRepoUrlFromCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const norm = cwd.replace(/\\/g, '/');
  const m = norm.match(/\/github\.com\/([^/]+\/[^/]+)/);
  return m ? `https://github.com/${m[1]}` : undefined;
}

/**
 * SessionMeta originates in discover.ts (gitBranch, cwd, label, etc. read from
 * untrusted session files). parseSession sanitizes event payloads at its
 * chokepoint, but meta fields bypass that path. Strip terminal escapes here
 * before any meta string reaches a TTY.
 */
function sanitizeMeta(s: SessionMeta): SessionMeta {
  const clean = (v: string | undefined) => (v == null ? v : sanitizeForTerminal(v));
  const todos = s.todos
    ? {
        ...s.todos,
        activeForm: clean(s.todos.activeForm),
        items: s.todos.items.map((it) => ({
          ...it,
          content: sanitizeForTerminal(it.content),
          activeForm: clean(it.activeForm),
        })),
      }
    : s.todos;
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
    ticketId: clean(s.ticketId),
    prUrl: clean(s.prUrl),
    todos,
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
    const metaBody = formatMetaOnlyBody(safe);
    const output = [formatHeader(safe, []), '', note, metaBody].filter(Boolean).join('\n');
    previewCache.set(cacheKey, output);
    return output;
  }

  // No transcript on disk — a live session not indexed locally, or a synthesized
  // entry (e.g. `sessions go`). Show the header + a clean note, not a parse error.
  if (!session.filePath || !fs.existsSync(session.filePath)) {
    const note = '  ' + chalk.gray('Live session — full transcript not indexed here.');
    const metaBody = formatMetaOnlyBody(safe);
    const output = [formatHeader(safe, []), '', note, metaBody].filter(Boolean).join('\n');
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

  // Line 1: Agent v version · shortId · model · account
  const line1: string[] = [];
  line1.push(chalk.gray(`${displayAgent(session.agent)}${session.version ? ` v${session.version}` : ''}`));
  if (session.shortId) line1.push(chalk.dim(session.shortId));
  if (model) line1.push(chalk.bold.white(model));
  if (session.account) line1.push(chalk.gray(session.account));

  // Line 2: cwd · project · branch · started X ago · lasted Y
  // Project is clickable: Linear issue URL is for tickets (line 4); for the
  // project name prefer a GitHub repo URL derived from the checkout path.
  const line2: string[] = [];
  if (session.cwd) {
    const label = relativeToCwd(session.cwd);
    line2.push(chalk.bold.white(linkPath(session.cwd, label)));
  }
  if (session.project) {
    const repoUrl = githubRepoUrlFromCwd(session.cwd);
    line2.push(chalk.cyan(repoUrl ? linkUrl(repoUrl, session.project) : session.project));
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
  if (session.filePath) line3.push(chalk.gray(linkPath(session.filePath, session.id)));
  else line3.push(chalk.gray(session.id));

  // Line 4: ticket + PR — clickable when a URL is resolvable (OSC 8 hyperlink),
  // plain text otherwise. Only rendered when the session carries either.
  const line4: string[] = [];
  if (session.ticketId) {
    const url = linearIssueUrl(session.ticketId);
    line4.push(chalk.blue(url ? linkUrl(url, session.ticketId) : session.ticketId));
  }
  if (session.prUrl) {
    const label = session.prNumber ? `PR#${session.prNumber}` : 'PR';
    line4.push(chalk.blue(linkUrl(session.prUrl, label)));
  }

  return [
    line1.join(DOT),
    line2.join(DOT),
    line3.join(DOT),
    ...(line4.length ? [line4.join(DOT)] : []),
  ].join('\n');
}

/**
 * Body lines available from SessionMeta alone (no transcript parse) — used for
 * remote / unindexed sessions so checklist progress still surfaces when the
 * parser teammate (or a prior scan) has populated `session.todos`.
 */
function formatMetaOnlyBody(session: SessionMeta): string {
  const lines: string[] = [];
  if (session.topic) {
    lines.push(chalk.cyan('Prompt: ') + chalk.white(truncate(session.topic.trim(), (process.stdout.columns || 80) - 12)));
  }
  const compact = formatTodoCompact(session.todos);
  if (compact) {
    lines.push(chalk.cyan('Todos: ') + chalk.white(compact));
  }
  if (lines.length === 0) return '';
  return lines.map(l => '  ' + l).join('\n');
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
const DIRS_TOUCHED_MAX = 5;

/** Optional dirs-touched field the parser teammate may attach; we prefer it. */
type SessionMetaWithDirs = SessionMeta & { dirsTouched?: string[] };

function formatCompactPreview(events: ReturnType<typeof parseSession>, session: SessionMeta): string {
  let firstUser = '';
  let lastAssistant = '';
  const filesRead = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let toolCalls = 0;
  let planFile = '';
  /** Latest checklist from the transcript (Claude TodoWrite / Codex update_plan). */
  let latestTodos: TodoProgress | undefined;

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
      // Claude TodoWrite (`todos`) and Codex update_plan (`plan`) — same source as
      // extractTodoProgress in the state engine. Prefer the most recent write.
      if (tool === 'TodoWrite' || tool === 'update_plan') {
        const progress = extractTodoProgress(event.args);
        if (progress) latestTodos = progress;
      }
      if (tool) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      toolCalls++;
    }
  }

  // Prefer the transcript-derived list when we just re-parsed the file (freshest
  // checklist write); fall back to SessionMeta.todos for rows where the scan/
  // fan-out attached progress but the event stream has no TodoWrite yet.
  const todos: TodoProgress | undefined = latestTodos ?? session.todos;

  // Digest signals folded into the preview: change lifecycle, tool mix, tests.
  const changes = classifyFileChanges(events);
  const chg = changeCounts(changes);

  const lines: string[] = [];
  const termWidth = process.stdout.columns || 80;

  // Originating user prompt (first non-system user turn).
  if (firstUser) {
    const first = extractSessionTopic(firstUser) || cleanSessionPrompt(firstUser).split('\n').find(l => l.trim()) || '';
    if (first) {
      lines.push(chalk.cyan('Prompt: ') + chalk.white(truncate(first.trim(), termWidth - 12)));
    }
  } else if (session.topic) {
    lines.push(chalk.cyan('Prompt: ') + chalk.white(truncate(session.topic.trim(), termWidth - 12)));
  }

  // Compact checklist: ✓done/total · current step (RUSH-2045).
  const compact = formatTodoCompact(todos);
  if (compact) {
    lines.push(chalk.cyan('Todos: ') + chalk.white(compact));
  }
  const todosRendered = todos?.items?.length ? renderTodos(todos.items, termWidth) : [];
  if (todosRendered.length > 0) {
    for (const l of todosRendered) lines.push('  ' + l);
  }

  // Recent activity = directories touched (not raw tool calls). Prefer a
  // parser-supplied dirsTouched when present; else derive from event paths.
  const dirs = directoriesTouched(session as SessionMetaWithDirs, events, changes);
  if (dirs.length) {
    lines.push(chalk.cyan('Dirs:    ') + chalk.white(dirs.join(chalk.gray(' · '))));
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

  if (lastAssistant) {
    const maxLines = todosRendered.length > 0 || compact ? LAST_RESPONSE_MAX_LINES_WITH_TODOS : LAST_RESPONSE_MAX_LINES;
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

/**
 * Unique directories the session touched, compact and human-readable.
 * Prefer `session.dirsTouched` when the parser teammate has populated it;
 * otherwise derive from file-change + tool paths already available here.
 */
export function directoriesTouched(
  session: SessionMetaWithDirs,
  events: SessionEvent[],
  changes: ReturnType<typeof classifyFileChanges>,
): string[] {
  const fromMeta = session.dirsTouched;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
    return fromMeta
      .map((d) => sanitizeForTerminal(String(d).trim()))
      .filter(Boolean)
      .slice(0, DIRS_TOUCHED_MAX);
  }

  const counts = new Map<string, number>();
  const bump = (raw: string) => {
    const dir = relativizeDir(raw, session.cwd);
    if (!dir) return;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  };
  for (const ch of changes) bump(ch.path);
  for (const event of events) {
    if (event.type !== 'tool_use' || event._local) continue;
    const p = event.path || event.args?.file_path || event.args?.path || '';
    if (p) bump(p);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d]) => d)
    .slice(0, DIRS_TOUCHED_MAX);
}

/**
 * Claude encodes a session's cwd into its `~/.claude/projects/<slug>` dir name by
 * replacing every `/` with `-`, so a path like `/Users/me/src/app` becomes the
 * slug `-Users-me-src-app`. That slug then leaks into transcript paths verbatim.
 * Decode the KNOWN root prefix (`-Users-<user>-` / `-home-<user>-` / `-var-…`)
 * back to an absolute path so it can be relativized like any other. The rest of
 * the slug is left with its `-` intact — real dir names can contain `-`, so a
 * blanket `-`→`/` would corrupt them; best-effort by design. Returns the input
 * unchanged when it isn't a recognizable slug.
 */
function decodeClaudeSlug(dir: string): string {
  if (!dir.startsWith('-')) return dir;
  // The slug is the LEADING path segment; a leaked form can carry real subdirs
  // after it (`<slug>/<id>/scratchpad`), so decode only that first segment and
  // keep the rest verbatim.
  const slash = dir.indexOf('/');
  const head = slash === -1 ? dir : dir.slice(0, slash);
  const tail = slash === -1 ? '' : dir.slice(slash); // includes the leading `/`
  const m = head.match(/^-(Users|home)-([^-]+)-(.*)$/);
  if (m) return `/${m[1]}/${m[2]}/${m[3].replace(/-/g, '/')}${tail}`;
  const mv = head.match(/^-(var|opt|tmp|srv|mnt)-(.*)$/);
  if (mv) return `/${mv[1]}/${mv[2].replace(/-/g, '/')}${tail}`;
  return dir;
}

/** Relativize a file path to its parent dir, short enough for one preview line. */
export function relativizeDir(filePath: string, cwd?: string): string | undefined {
  const norm = filePath.replace(/\\/g, '/');
  if (!norm || norm.includes('node_modules') || norm.includes('/.git/') || norm.includes('/plans/')) {
    return undefined;
  }
  let dir = path.posix.dirname(norm);
  // Decode a Claude project-slug (`-Users-me-…`) into an absolute path first so the
  // cwd/home/trim logic below can simplify it like any real path.
  dir = decodeClaudeSlug(dir);
  // Inside a git worktree, show the worktree NAME + the in-worktree remainder,
  // not the noisy `.agents/worktrees/<slug>/` prefix.
  const wt = dir.match(WORKTREE_RE);
  if (wt) {
    const after = dir.slice(dir.indexOf(wt[0]) + wt[0].length).replace(/^\//, '');
    return after ? `⧉ ${wt[1]}/${after}` : `⧉ ${wt[1]}`;
  }
  if (cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (dir === base) return '.';
    if (dir.startsWith(base + '/')) dir = dir.slice(base.length + 1);
  }
  // Collapse home prefix.
  const home = (process.env.HOME || '').replace(/\\/g, '/');
  if (home && dir.startsWith(home + '/')) dir = '~' + dir.slice(home.length);
  // A slug we couldn't decode to an absolute path is still one giant `-`-joined
  // segment; trim it to its last 3 `-` groups so it stops rendering in full.
  if (dir.startsWith('-') && !dir.includes('/')) {
    const segs = dir.split('-').filter(Boolean);
    if (segs.length > 3) dir = segs.slice(-3).join('/');
  }
  // Drop ultra-deep absolute noise; keep last 3 segments.
  const parts = dir.split('/').filter(Boolean);
  if (parts.length > 3 && dir.startsWith('/')) dir = parts.slice(-3).join('/');
  return dir || undefined;
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

function renderTodos(todos: Array<{ content?: string; text?: string; status?: string }>, termWidth: number): string[] {
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
