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
import { parseSession, sanitizeForTerminal, SNAPSHOT_TODO_TOOLS } from '../lib/session/parse.js';
import { safeTeamText } from '../lib/session/team-filter.js';
import { cleanSessionPrompt, extractSessionTopic, isSyntheticUserMessage } from '../lib/session/prompt.js';
import { linkPath, linkUrl, relativeToCwd, shortenModel } from '../lib/session/render.js';
import { linearIssueUrl } from '../lib/session/linear.js';
import { extractTodoProgress, WORKTREE_RE } from '../lib/session/state.js';
import { renderMarkdown } from '../lib/markdown.js';
import { itemPicker } from '../lib/picker.js';
import { createMemoryCache } from '../lib/memory-cache.js';
import { classifyFileChanges, changeCounts, toolHistogram, detectTestResult } from '../lib/session/digest.js';
import { extractArtifacts, extractHooks, extractLinks, extractRepos, extractSkills } from '../lib/session/highlights.js';
import { getSessionPlugins, readSessionPreviewCache, writeSessionPreviewCache, readSessionContent, readArchivedSessionPreview } from '../lib/session/db.js';
/** A session whose transcript FILE is on another machine (folded in over the
 * live cross-machine fan-out): its `filePath` is on that peer's disk, so the
 * preview can't parse it locally — it shows metadata + a "resume there" note
 * instead. Keys off `_remote`, not the machine tag, so locally-readable synced
 * mirrors still parse their file normally.
 *
 * This is the READ rule and only the read rule. Whether a session may be
 * RESUMED here is a different question with a different answer — a mirror is
 * readable but not resumable — and `sessionOwnerDevice`
 * (lib/session/resume-owner.ts) is the single place that answers it (RUSH-2022). */
function transcriptOnPeerOf(session: SessionMeta): string | undefined {
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
    // A remote row's meta is peer-supplied JSON that parseRemoteList hands over
    // unsanitized, and both of these reach the preview pane — so an escape
    // sequence in a peer's plan text or path list would otherwise hit our TTY.
    plan: clean(s.plan),
    spawnedTeam: clean(s.spawnedTeam),
    recentDirectoriesTouched: s.recentDirectoriesTouched?.map(sanitizeForTerminal),
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
  /** Lines the caller printed above the prompt (hidden-session footer). */
  linesAbovePrompt?: number;
}

const previewCache = createMemoryCache<string, string>({
  max: 256,
  ttlMs: 5 * 60_000,
});

function previewCacheKey(session: SessionMeta, remote: string | undefined): string {
  let fileStamp = '';
  if (!remote && session.filePath) {
    try {
      const stat = fs.statSync(session.filePath);
      fileStamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      fileStamp = 'missing';
    }
  }
  // The transcript stamp invalidates derived activity. Metadata that can change
  // independently (label/ticket/PR/live scanner enrichment) also rides the key.
  return JSON.stringify([
    remote ?? '', session.id, fileStamp, session.lastActivity, session.label,
    session.topic, session.ticketId, session.prUrl, session.messageCount,
    session.tokenCount, session.model, session.todos, session.plan,
    session.recentDirectoriesTouched, session.skillsUsed,
  ]);
}

export function clearPreviewMemoryCacheForTest(): void {
  previewCache.clear();
}

export function loadSessionPreviewDigest(session: SessionMeta): {
  digest?: SessionPreviewDigest;
  events: SessionEvent[];
  error?: string;
} {
  if (!session.filePath || !fs.existsSync(session.filePath)) {
    // File gone, but an archived session (RUSH-2436) keeps its last-computed
    // digest in the DB — serve that so the picker preview still shows its turns
    // instead of a bare "not indexed here" note. No events to replay.
    const archived = readArchivedSessionPreview<SessionPreviewDigest>(session.id);
    if (archived) {
      archived.plugins = getSessionPlugins(session.id);
      return { digest: archived, events: [] };
    }
    return { events: [] };
  }
  const safe = sanitizeMeta(session);
  let events: SessionEvent[] = [];
  let sourceStamp: fs.Stats;
  try {
    sourceStamp = fs.statSync(session.filePath);
  } catch (err: any) {
    return { events, error: sanitizeForTerminal(err?.message ?? String(err)) };
  }
  let digest = readSessionPreviewCache<SessionPreviewDigest>(session.id, {
    fileMtimeMs: sourceStamp.mtimeMs,
    fileSize: sourceStamp.size,
  });
  if (!digest) {
    try {
      events = parseSession(session.filePath, session.agent);
      digest = buildSessionPreviewDigest(events, safe);
      writeSessionPreviewCache({
        id: session.id,
        fileMtimeMs: sourceStamp.mtimeMs,
        fileSize: sourceStamp.size,
        preview: digest,
      });
    } catch (err: any) {
      return { events, error: sanitizeForTerminal(err?.message ?? String(err)) };
    }
  }
  digest.plugins = getSessionPlugins(session.id);
  return { digest, events };
}

/** Build a cached multi-line preview string for display in the session picker. */
export function buildPreview(session: SessionMeta): string {
  const remote = transcriptOnPeerOf(session);
  const cacheKey = previewCacheKey(session, remote);
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

  // No transcript on disk — either an archived session (file gone, user turns
  // still in the DB — RUSH-2436), a live session not indexed locally, or a
  // synthesized entry (e.g. `sessions go`). Show the header + a clean note.
  if (!session.filePath || !fs.existsSync(session.filePath)) {
    const archivedContent = readSessionContent(session.id);
    if (archivedContent && archivedContent.trim() !== '') {
      const note = '  ' + chalk.yellow('archived — transcript file removed; served from the local DB');
      const { digest } = loadSessionPreviewDigest(session);
      const body = digest ? formatCompactPreview(digest, safe) : formatMetaOnlyBody(safe);
      const output = [formatHeader(safe, []), '', note, body].filter(Boolean).join('\n');
      previewCache.set(cacheKey, output);
      return output;
    }
    const note = '  ' + chalk.gray('Live session — full transcript not indexed here.');
    const metaBody = formatMetaOnlyBody(safe);
    const output = [formatHeader(safe, []), '', note, metaBody].filter(Boolean).join('\n');
    previewCache.set(cacheKey, output);
    return output;
  }

  const { digest, events, error: parseError } = loadSessionPreviewDigest(session);

  const header = formatHeader(safe, events);
  const body = parseError
    ? '  ' + chalk.red(`Failed to parse session: ${parseError}`)
    : formatCompactPreview(digest!, safe);
  const output = [header, '', body].filter(Boolean).join('\n');
  previewCache.set(cacheKey, output);
  return output;
}

function displayAgent(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

const DOT = chalk.gray(' · ');

function formatHeader(session: SessionMeta, events: SessionEvent[]): string {
  const model = extractModel(events) || session.model;
  const { createdAgo, lastActiveAgo, duration } = extractTiming(session, events);
  const totalMessages = session.messageCount ?? countMessages(events);
  const totalTokens = session.tokenCount;

  // Line 1: Agent v version · shortId · model · account
  const line1: string[] = [];
  line1.push(chalk.gray(`${displayAgent(session.agent)}${session.version ? ` v${session.version}` : ''}`));
  if (session.shortId) line1.push(chalk.dim(session.shortId));
  if (model) line1.push(chalk.bold.white(shortenModel(model)));
  if (session.account) line1.push(chalk.gray(session.account));

  // Line 2: cwd · project · branch · created X ago · last active Y ago · lasted Z
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
  if (createdAgo) line2.push(chalk.gray('created ') + chalk.white(createdAgo + ' ago'));
  if (lastActiveAgo) line2.push(chalk.gray('last active ') + chalk.white(lastActiveAgo + ' ago'));
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
/**
 * The session's place in a team, from whichever end it sits at: the orchestrator
 * that ran `agents teams create` (from the scan-derived `spawnedTeam`), or a
 * teammate (from its `meta.json`, via `classifyTeamSession`). Empty for a session
 * with no team involvement, which is the overwhelming majority.
 *
 * Deliberately no live teammate counts: tallying a team means reading every
 * record under the teams-agents dir, which runs to thousands of files on a busy
 * machine — far too much for a pane that repaints as the cursor moves. The line
 * names the command that does report them instead.
 */
export function formatTeamLineage(session: SessionMeta): string {
  const origin = session.teamOrigin;
  if (origin) {
    const team = safeTeamText(origin.team);
    const handleName = safeTeamText(origin.handle);
    const mode = safeTeamText(origin.mode);
    const parent = safeTeamText(origin.parentSessionId);
    const parts = [chalk.white(team ?? 'team')];
    const handle = handleName ? `teammate ${handleName}` : 'teammate';
    parts.push(chalk.white(mode ? `${handle} (${mode})` : handle));
    if (parent) {
      parts.push(chalk.gray('spawned by ') + chalk.white(parent.slice(0, 8)));
    }
    return parts.join(chalk.gray(' · '));
  }
  const spawned = safeTeamText(session.spawnedTeam);
  if (spawned) {
    return (
      chalk.gray('spawned team ') +
      chalk.white(spawned) +
      chalk.gray(` · agents teams status ${spawned}`)
    );
  }
  return '';
}

function formatMetaOnlyBody(session: SessionMeta): string {
  const lines: string[] = [];
  if (session.topic) {
    lines.push(chalk.cyan('Prompt: ') + chalk.white(truncate(session.topic.trim(), (process.stdout.columns || 80) - 12)));
  }
  const teamLine = formatTeamLineage(session);
  if (teamLine) {
    lines.push(chalk.cyan('Team:   ') + teamLine);
  }
  const compact = formatTodoCompact(session.todos);
  if (compact) {
    lines.push(chalk.cyan('Todos: ') + chalk.white(compact));
  }
  const termWidth = process.stdout.columns || 80;
  for (const l of session.todos?.items?.length ? renderTodos(session.todos.items, termWidth) : []) {
    lines.push(l);
  }
  const dirs = session.recentDirectoriesTouched?.slice(0, DIRS_TOUCHED_MAX) ?? [];
  if (dirs.length) {
    lines.push(chalk.cyan('Dirs:   ') + chalk.white(dirs.join(chalk.gray(' · '))));
  }
  // `plan` is the whole ExitPlanMode markdown, not a path — summarize it. The
  // pane is height-clamped anyway, so pasting the blob would just push every
  // other line out of view.
  const planLines = session.plan?.trim() ? session.plan.trim().split('\n') : [];
  if (planLines.length) {
    const head = truncate(planLines[0].replace(/^#+\s*/, ''), termWidth - 20);
    lines.push(chalk.cyan('Plan:   ') + chalk.white(head) + chalk.gray(` · ${planLines.length} lines`));
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

/** Shortest span worth reporting as a separate last-activity field — matches the
 * listing's rule, so the pane and the row agree on what counts as a one-shot. */
const TIMING_SPAN_MIN_MS = 60_000;

/**
 * The three timing facts the header reports: when the session was created, when
 * it was last active, and how long it ran. Reads the parsed transcript when
 * there is one and otherwise the indexed `SessionMeta`, so a remote or
 * unindexed session — which has no local transcript to parse — still reports
 * them instead of silently dropping the whole line.
 *
 * `lastActive` and `lasted` are omitted for a session whose whole life was under
 * a minute: there they just restate `created`.
 */
export function extractTiming(
  session: Pick<SessionMeta, 'timestamp' | 'lastActivity' | 'durationMs'>,
  events: SessionEvent[],
): { createdAgo?: string; lastActiveAgo?: string; duration?: string } {
  const firstMs = Date.parse(events[0]?.timestamp ?? session.timestamp);
  if (Number.isNaN(firstMs)) return {};
  const createdAgo = humanDuration(Math.max(0, Date.now() - firstMs));

  const lastMs = Date.parse(
    events[events.length - 1]?.timestamp ?? session.lastActivity ?? session.timestamp,
  );
  if (Number.isNaN(lastMs)) return { createdAgo };
  // A scan-persisted duration beats the timestamp subtraction when there are no
  // events to read, because `lastActivity` may have fallen back to file mtime.
  const spanMs = events.length === 0 && session.durationMs !== undefined
    ? session.durationMs
    : Math.max(0, lastMs - firstMs);
  if (spanMs < TIMING_SPAN_MIN_MS) return { createdAgo };
  return {
    createdAgo,
    lastActiveAgo: humanDuration(Math.max(0, Date.now() - lastMs)),
    duration: humanDuration(spanMs),
  };
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

export interface SessionPreviewDigest {
  schemaVersion: 1;
  firstUser: string;
  lastAssistant: string;
  filesRead: number;
  toolCalls: number;
  planFile: string;
  todos?: TodoProgress;
  subAgentCount: number;
  toolTags: string[];
  changes: ReturnType<typeof changeCounts>;
  dirs: string[];
  repos: string[];
  artifacts: ReturnType<typeof extractArtifacts>;
  skills: ReturnType<typeof extractSkills>;
  plugins: string[];
  hooks: ReturnType<typeof extractHooks>;
  links: ReturnType<typeof extractLinks>;
  errorCount: number;
  firstError?: string;
  toolHistogram: ReturnType<typeof toolHistogram>;
  test: ReturnType<typeof detectTestResult>;
}

/** Fold a harness-normalized event stream into the stable preview data model. */
export function buildSessionPreviewDigest(events: SessionEvent[], session: SessionMeta): SessionPreviewDigest {
  let firstUser = '';
  let lastAssistant = '';
  const filesRead = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let toolCalls = 0;
  let planFile = '';
  /** Latest checklist from the transcript (Claude TodoWrite / Codex update_plan). */
  let latestTodos: TodoProgress | undefined;
  let subAgentCount = 0;
  const toolTags = new Set<string>();
  // usedBrowser/usedComputer are computed at scan time from a sessionId-scoped
  // events-log read (session/db.ts detectToolUsage), NOT a transcript regex —
  // undefined means a legacy row this scanner hasn't computed the field for
  // yet, so only THEN does classifySessionTool's transcript-derived guess run
  // below (mirrors directoriesTouched's prefer-persisted/fall-back-to-derived
  // pattern for recentDirectoriesTouched).
  const knownToolUsage = session.usedBrowser !== undefined;

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user' && !event._synthetic && !firstUser && event.content) {
        if (!SYSTEM_MESSAGE_PATTERNS.some(p => p.test(event.content!))) {
          firstUser = event.content;
        }
      }
      if (event.role === 'assistant' && event.content) {
        lastAssistant = event.content;
      }
    } else if (event.type === 'tool_use' && !event._local) {
      const tool = event.tool || '';
      const command = event.command || '';
      if (!knownToolUsage) {
        for (const tag of classifySessionTool(tool, command)) toolTags.add(tag);
      }
      if (isSubAgentTool(tool, command)) subAgentCount++;
      const p = event.path || event.args?.file_path || event.args?.path || '';
      if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool) && p) {
        filesRead.add(p);
      }
      if (!planFile && p && /\/plans\/[^/]+\.md$/.test(p)) {
        planFile = p;
      }
      // Every harness's checklist-snapshot tool (Claude TodoWrite, Kimi TodoList,
      // Codex update_plan, …) — the same registry the state engine folds through
      // extractTodoProgress. Prefer the most recent write.
      if (SNAPSHOT_TODO_TOOLS.has(tool)) {
        const progress = extractTodoProgress(event.args);
        if (progress) latestTodos = progress;
      }
      if (tool) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      toolCalls++;
    }
  }

  // Persisted field wins when computed — it comes from real browser.navigate/
  // browser.screenshot/computer.action events, not a fuzzy tool-name regex.
  if (session.usedBrowser) toolTags.add('browser');
  if (session.usedComputer) toolTags.add('computer');

  // Prefer the transcript-derived list when we just re-parsed the file (freshest
  // checklist write); fall back to SessionMeta.todos for rows where the scan/
  // fan-out attached progress but the event stream has no TodoWrite yet.
  const todos: TodoProgress | undefined = latestTodos ?? session.todos;

  const changes = classifyFileChanges(events);
  const chg = changeCounts(changes);

  const errorEvents = events.filter(e => e.type === 'error');
  return {
    schemaVersion: 1,
    firstUser,
    lastAssistant,
    filesRead: filesRead.size,
    toolCalls,
    planFile,
    todos,
    subAgentCount,
    toolTags: [...toolTags],
    changes: chg,
    dirs: directoriesTouched(session, events, changes),
    repos: extractRepos(events, session.cwd),
    artifacts: extractArtifacts(changes),
    skills: extractSkills(events),
    plugins: getSessionPlugins(session.id),
    hooks: extractHooks(events),
    links: extractLinks(events),
    errorCount: errorEvents.length,
    firstError: errorEvents[0]?.tool,
    toolHistogram: toolHistogram(toolCounts, 4),
    test: detectTestResult(events),
  };
}

function formatCompactPreview(digest: SessionPreviewDigest, session: SessionMeta): string {
  const {
    firstUser, lastAssistant, filesRead, toolCalls, planFile, todos,
    subAgentCount, toolTags, changes: chg, dirs, repos, artifacts, skills, plugins,
    hooks, links, errorCount, firstError, toolHistogram: hist, test,
  } = digest;

  const lines: string[] = [];
  const termWidth = process.stdout.columns || 80;

  // Originating user prompt (first non-system user turn).
  if (firstUser) {
    const first = extractSessionTopic(firstUser) || cleanSessionPrompt(firstUser).split('\n').find(l => l.trim()) || '';
    if (first) {
      lines.push(chalk.cyan('Prompt: ') + chalk.white(truncate(first.trim(), termWidth - 12)));
    }
  } else if (session.topic && !isSyntheticUserMessage(session.topic)) {
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
  // Width-capped: a long Dirs line used to wrap and swamp the whole pane.
  if (dirs.length) {
    lines.push(chalk.cyan('Dirs:    ') + joinWidthCapped(dirs, termWidth - 12));
  }

  // Repos worked in (basename of each `.git` root under the touched paths).
  if (repos.length) {
    lines.push(chalk.cyan('Repos:   ') + chalk.white(repos.slice(0, 4).join(chalk.gray(' · '))));
  }

  const teamLine = formatTeamLineage(session);
  if (teamLine) {
    lines.push(chalk.cyan('Team:    ') + teamLine);
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
  if (filesRead) activity.push(chalk.gray(`${filesRead} read`));
  if (toolCalls) activity.push(chalk.gray(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`));
  if (activity.length) {
    lines.push(chalk.cyan('Changes:  ') + activity.join(chalk.gray(' · ')));
  }

  // Documents the session produced (`.agents/artifacts|plans|reports`, other
  // *.md/*.html creations) — the files a human browses later, named + clickable.
  if (artifacts.length) {
    const shown = artifacts.slice(0, 5).map(a => linkPath(a.path, a.basename));
    const more = artifacts.length > 5 ? chalk.gray(` · +${artifacts.length - 5} more`) : '';
    lines.push(chalk.cyan('Artifacts: ') + shown.join(chalk.gray(' · ')) + more);
  }

  // Skills invoked (plugin skills included — they ride the same Skill tool).
  if (skills.length) {
    const shown = skills.slice(0, 5).map(s => chalk.white(s.name) + (s.count > 1 ? chalk.gray(` ×${s.count}`) : ''));
    const more = skills.length > 5 ? chalk.gray(` · +${skills.length - 5} more`) : '';
    lines.push(chalk.cyan('Skills:  ') + shown.join(chalk.gray(' · ')) + more);
  }

  if (plugins.length) {
    lines.push(chalk.cyan('Plugins: ') + chalk.white(plugins.slice(0, 5).join(chalk.gray(' · '))));
  }

  // Hooks fired (Claude transcripts record firings; other harnesses don't).
  if (hooks.length) {
    const shown = hooks.slice(0, 4).map(h =>
      chalk.white(h.name) + (h.count > 1 ? chalk.gray(` ×${h.count}`) : '') + (h.failed ? chalk.red(` (${h.failed} failed)`) : ''));
    const more = hooks.length > 4 ? chalk.gray(` · +${hooks.length - 4} more`) : '';
    lines.push(chalk.cyan('Hooks:   ') + shown.join(chalk.gray(' · ')) + more);
  }

  // Links mentioned in the conversation — clickable (OSC 8), tracker-classified.
  if (links.length) {
    const shown = links.slice(0, 5).map(l => chalk.blue(linkUrl(l.url, l.label)));
    const more = links.length > 5 ? chalk.gray(` · +${links.length - 5} more`) : '';
    lines.push(chalk.cyan('Links:   ') + shown.join(chalk.gray(' · ')) + more);
  }

  // Error tally, mirroring the full summary's Errors section in one line.
  if (errorCount) {
    lines.push(chalk.cyan('Errors:  ') + chalk.red(`${errorCount} failure${errorCount === 1 ? '' : 's'}`) + chalk.gray(` — first: ${firstError || 'unknown'}`));
  }

  const metadata = [
    ...toolTags,
    subAgentCount ? `${subAgentCount} sub-agent${subAgentCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  if (metadata.length) {
    lines.push(chalk.cyan('Meta:     ') + chalk.gray(metadata.join(' · ')));
  }

  // Tool mix (top 4) — what kind of work this was.
  if (hist.length) {
    lines.push(chalk.cyan('Tools:    ') + chalk.gray(hist.map(h => `${h.tool} ${h.count}`).join(' · ')));
  }

  // Last test/build verdict.
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

function classifySessionTool(tool: string, command: string): string[] {
  const toolName = tool.toLowerCase();
  const commandUses = (surface: 'browser' | 'computer') => (
    new RegExp(`\\b(?:agents|ag)\\b[^\\n;&|]*\\b${surface}\\b`).test(command.toLowerCase())
  );
  const tags: string[] = [];
  if (/browser|webfetch|websearch/.test(toolName) || commandUses('browser')) tags.push('browser');
  if (/computer/.test(toolName) || commandUses('computer')) tags.push('computer');
  return tags;
}

function isSubAgentTool(tool: string, command: string): boolean {
  if (/^(Agent|Task)$/i.test(tool)) return true;
  return /\b(?:agents|ag)\b[^\n;&|]*\b(?:run|cloud\s+run|teams\s+(?:add|start))\b/.test(command);
}

/**
 * Unique directories the session touched, compact and human-readable.
 * Prefer `session.recentDirectoriesTouched` — the scan records it on the row, so
 * it is present for remote rows whose transcript we can't parse here — otherwise
 * derive from the file-change + tool paths already available.
 */
export function directoriesTouched(
  session: SessionMeta,
  events: SessionEvent[],
  changes: ReturnType<typeof classifyFileChanges>,
): string[] {
  const fromMeta = session.recentDirectoriesTouched;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
    // The scan stores ABSOLUTE paths, so they go through the same relativizer the
    // derived branch below uses — otherwise adopting this field (which a remote row
    // needs, having no transcript to derive from) would turn every local preview's
    // `Dirs:` line from `src/lib · docs` into a column of full home-rooted paths.
    const seen = new Set<string>();
    for (const raw of fromMeta) {
      const dir = relativizeDir(sanitizeForTerminal(String(raw).trim()), session.cwd);
      if (dir) seen.add(dir);
      if (seen.size >= DIRS_TOUCHED_MAX) break;
    }
    if (seen.size > 0) return [...seen];
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
 * Claude names its per-project transcript store `~/.claude/projects/<slug>`, where
 * `<slug>` is the cwd with every `/` AND `.` replaced by `-` — so `/Users/me/app`
 * → `-Users-me-app` and `.agents/worktrees/x` → `--agents-worktrees-x`. That slug
 * leaks into transcript paths as a leading segment (`<slug>/<session-id>/…`).
 *
 * The encoding is LOSSY and irreversible (`-`, `/`, and `.` all collapse to `-`),
 * so we never try to decode it back to a path. Instead we ENCODE the comparison
 * targets (cwd, the worktree marker) into the same slug space and match there. See
 * {@link relativizeDir}. `encodeClaudeSlug` mirrors Claude's own transform.
 */
function encodeClaudeSlug(absPath: string): string {
  return absPath.replace(/[/.]/g, '-');
}

/** The `.agents/worktrees/<name>` marker, Claude-slug-encoded (`/.` → `--`). */
const SLUG_WORKTREE_RE = /--agents-worktrees-(.+)$/;

/**
 * Join display tokens with ` · `, stopping before the line exceeds `maxWidth`
 * and appending `… +N more` for the rest. Keeps the Dirs line on one row.
 */
function joinWidthCapped(items: string[], maxWidth: number): string {
  const sep = ' · ';
  let out = '';
  let shown = 0;
  for (const item of items) {
    const next = shown === 0 ? item : out + sep + item;
    if (shown > 0 && next.length > maxWidth) break;
    out = next;
    shown++;
  }
  const remaining = items.length - shown;
  const suffix = remaining > 0 ? ` … +${remaining} more` : '';
  return chalk.white(out) + (suffix ? chalk.gray(suffix) : '');
}

/** Relativize a file path to its parent dir, short enough for one preview line. */
export function relativizeDir(filePath: string, cwd?: string): string | undefined {
  const norm = filePath.replace(/\\/g, '/');
  if (!norm || norm.includes('node_modules') || norm.includes('/.git/') || norm.includes('/plans/')) {
    return undefined;
  }
  // agents-cli internals — version homes, session/run archives, the bare
  // worktree container/root — are never meaningful "directories the user works
  // in". Cwd is exempt: a session running inside such a dir keeps its own paths.
  const normBase = cwd?.replace(/\\/g, '/').replace(/\/$/, '');
  const underCwd = normBase && (norm === normBase || norm.startsWith(normBase + '/'));
  if (!underCwd && (norm.includes('/.agents/.history/') || /\/\.agents\/worktrees(\/[^/]+)?\/?$/.test(norm))) {
    return undefined;
  }
  let dir = path.posix.dirname(norm);

  // Claude project-slug form: a leading `-`-segment (`-home-me-…`) that carries
  // the cwd, lossily encoded. Handle it in SLUG SPACE — never lossy-decode to a
  // fake path. The slug is the first path segment; any real `/`-subdirs after it
  // are Claude's internal storage (`<session-id>/scratchpad|tasks`), not code.
  if (dir.startsWith('-')) {
    const slash = dir.indexOf('/');
    const slug = slash === -1 ? dir : dir.slice(0, slash);
    // CWD FIRST: if the slug is (or is under) this session's own cwd, the leaked
    // path is Claude's internal projects-storage scratch (`<id>/scratchpad`) —
    // not a meaningful code dir — so drop it like node_modules. Precedence over
    // the worktree collapse so a session editing its OWN worktree isn't relabeled.
    if (cwd) {
      const cwdSlug = encodeClaudeSlug(cwd.replace(/\\/g, '/').replace(/\/$/, ''));
      if (slug === cwdSlug || slug.startsWith(cwdSlug + '-')) return undefined;
    }
    // Only a DIFFERENT worktree than cwd reaches here: a worktree encodes its
    // `/.agents/worktrees/<name>` marker as `--agents-worktrees-<name>`, so
    // collapse to the worktree name to disambiguate. (The name may contain `-`;
    // we can't losslessly re-split it, so show the whole encoded remainder.)
    const wtSlug = slug.match(SLUG_WORKTREE_RE);
    if (wtSlug) return `⧉ ${wtSlug[1]}`;
    // An unattributable slug: don't invent a `/`-joined fake path. Show only the
    // trailing `-`-group as a minimal, honest token.
    const segs = slug.split('-').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : undefined;
  }

  // CWD FIRST for real paths too: strip the session-cwd prefix so a session
  // editing its OWN worktree renders the concise relative remainder (`src/lib`),
  // not the longer `⧉ <slug>/…` collapse.
  if (cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (dir === base) return '.';
    if (dir.startsWith(base + '/')) return dir.slice(base.length + 1);
  }
  // No cwd match. If the dir is in a (different) git worktree, collapse to the
  // worktree NAME + in-worktree remainder to disambiguate; else home→`~` + trim.
  const wt = dir.match(WORKTREE_RE);
  if (wt) {
    const after = dir.slice(dir.indexOf(wt[0]) + wt[0].length).replace(/^\//, '');
    return after ? `⧉ ${wt[1]}/${after}` : `⧉ ${wt[1]}`;
  }
  // Collapse home prefix.
  const home = (process.env.HOME || '').replace(/\\/g, '/');
  if (home && dir.startsWith(home + '/')) dir = '~' + dir.slice(home.length);
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
    linesAbovePrompt: config.linesAbovePrompt,
  });
  if (!picked) return null;
  return { session: picked.item, action: 'resume' };
}
