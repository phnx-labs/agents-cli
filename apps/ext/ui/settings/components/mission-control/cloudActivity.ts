/**
 * Parse the cloud-run `summary` NDJSON stream into a typed sequence of events
 * the feed component can render as cards.
 *
 * Input format (as produced by rush-cloud wrappers):
 *   1. Plain-text preamble lines:
 *        [t+0s] entered wrapper (pod ready)
 *        [t+17s] fetch done
 *        HEAD is now at ...
 *      These lines come from the wrapper shell before the agent is spawned.
 *   2. JSONL lines emitted by the Claude CLI (`claude -p --output-format
 *      stream-json`), one event per line.
 *
 * The stream can be truncated mid-line (the API caps summary length), so the
 * parser tolerates unparseable tails by skipping them.
 */

export interface PreambleMeta {
  agentCli: string;
  cliVersion?: string;
  model?: string;
  repo?: string;
  branch?: string;
  user?: string;
}

export interface PreambleEvent {
  kind: 'preamble';
  text: string;
  tSec?: number;
  /** Parsed fields when the line is the agent banner. */
  meta?: PreambleMeta;
  /** True when the line is the noisy metrics summary (turns/tools/tokens). */
  isMetric?: boolean;
}

export interface SystemEvent {
  kind: 'system';
  subtype: string;
  summary: string;
}

export interface ThinkingEvent {
  kind: 'thinking';
  text: string;
}

export interface AssistantEvent {
  kind: 'assistant';
  text: string;
}

export interface ToolUseEvent {
  kind: 'tool-use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  kind: 'tool-result';
  id: string;
  content: string;
  isError: boolean;
}

export interface UserMessageEvent {
  kind: 'user';
  text: string;
}

export interface ResultEvent {
  kind: 'result';
  subtype: string;
  durationMs?: number;
  numTurns?: number;
  totalCostUsd?: number;
}

export type CloudEvent =
  | PreambleEvent
  | SystemEvent
  | ThinkingEvent
  | AssistantEvent
  | ToolUseEvent
  | ToolResultEvent
  | UserMessageEvent
  | ResultEvent;

function parseOneLine(trimmed: string, events: CloudEvent[]): void {
  if (!trimmed) return;
  if (trimmed[0] !== '{') {
    events.push(parsePreambleLine(trimmed));
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return;
  }
  appendClaudeEvent(events, raw);
}

export function parseCloudSummary(summary: string | null | undefined): CloudEvent[] {
  if (!summary) return [];
  const events: CloudEvent[] = [];
  for (const line of summary.split(/\r\n|\n/)) {
    parseOneLine(line.trim(), events);
  }
  return events;
}

// Incremental parser for the live streaming feed. cloud_summary is append-only
// NDJSON and appendClaudeEvent only ever pushes (never mutates earlier events),
// so already-parsed complete lines never need re-parsing. We commit complete
// lines (up to the last '\n') into the cache and only parse the bytes appended
// since last time; the trailing partial line (no '\n' yet) is parsed fresh each
// call onto a copy, so a half-written record is picked up once it completes.
// Result is identical to parseCloudSummary at every step (see test).
export interface CloudParseCache {
  committedChars: number;
  events: CloudEvent[];
}

export function emptyCloudParseCache(): CloudParseCache {
  return { committedChars: 0, events: [] };
}

export function parseCloudSummaryIncremental(
  summary: string | null | undefined,
  cache: CloudParseCache,
): CloudEvent[] {
  const s = summary ?? '';
  const committedEnd = s.lastIndexOf('\n') + 1; // [0, committedEnd) are complete lines

  // Reuse the cache only if it's still a prefix of the current complete region
  // (append-only). Boundary sentinel: the cached cut must still sit right after
  // a newline. Otherwise the buffer was replaced/truncated -> full reparse.
  const reusable =
    cache.committedChars <= committedEnd &&
    (cache.committedChars === 0 || s.charCodeAt(cache.committedChars - 1) === 0x0a);
  if (!reusable) {
    cache.committedChars = 0;
    cache.events = [];
  }

  if (committedEnd > cache.committedChars) {
    const chunk = s.slice(cache.committedChars, committedEnd);
    for (const line of chunk.split('\n')) parseOneLine(line.trim(), cache.events);
    cache.committedChars = committedEnd;
  }

  // Always return a fresh array, even on the no-tail path. Callers (e.g. React's
  // useMemo in CloudActivityFeed) key downstream recomputation off this return
  // value's identity; handing back the live cache.events reference would keep
  // that identity stable across calls even as its contents grow via push(),
  // freezing the rendered feed on whatever it first committed.
  const tail = s.slice(committedEnd).trim();
  if (!tail) return cache.events.slice();
  const withTail = cache.events.slice();
  parseOneLine(tail, withTail);
  return withTail;
}

const PREAMBLE_AGENTS = new Set(['claude', 'codex', 'gemini', 'antigravity', 'grok', 'kimi', 'droid', 'cursor', 'opencode']);

function parsePreambleLine(line: string): PreambleEvent {
  const m = line.match(/^\[t\+(\d+)s\]\s*(.*)$/);
  const text = m ? m[2].trim() : line;
  const tSec = m ? Number(m[1]) : undefined;
  const meta = parseAgentBannerLine(text);
  if (meta) return { kind: 'preamble', text, tSec, meta };
  if (isMetricLine(text)) return { kind: 'preamble', text, tSec, isMetric: true };
  return { kind: 'preamble', text, tSec };
}

/**
 * Match the wrapper banner line:
 *   "claude 2.1.118 opus-4-7, swarmify (main) Apr 24 10:18 (1 hour ago) · muqsit"
 * Capture the parts the UI wants (model, repo, branch, user) and drop the
 * version/date/time which the UI shows elsewhere.
 */
function parseAgentBannerLine(line: string): PreambleMeta | undefined {
  const m = line.match(
    /^([a-z][a-z0-9-]*)\s+(\d+(?:\.\d+)+)\s+(\S+?),\s+([^\s(]+)(?:\s+\(([^)]+)\))?\s+[A-Z][a-z]+\s+\d+(?:\s+\d{1,2}:\d{2})?(?:\s*\([^)]+\))?(?:\s*·\s*(\S+))?\s*$/,
  );
  if (!m) return undefined;
  const cli = m[1];
  if (!PREAMBLE_AGENTS.has(cli)) return undefined;
  return {
    agentCli: cli,
    cliVersion: m[2],
    model: m[3],
    repo: m[4],
    branch: m[5],
    user: m[6],
  };
}

function isMetricLine(line: string): boolean {
  return /^\d+\s+turns?\s*·\s*\d+\s+tools?\b/.test(line);
}

function appendClaudeEvent(events: CloudEvent[], raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const r = raw as Record<string, unknown>;
  const type = r.type;

  if (type === 'system') {
    const subtype = typeof r.subtype === 'string' ? r.subtype : 'system';
    events.push({ kind: 'system', subtype, summary: summarizeSystem(subtype, r) });
    return;
  }

  if (type === 'assistant') {
    const msg = r.message as Record<string, unknown> | undefined;
    const content = Array.isArray(msg?.content) ? (msg!.content as unknown[]) : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'thinking') {
        const text = typeof b.thinking === 'string' ? b.thinking : '';
        if (text.trim()) events.push({ kind: 'thinking', text });
      } else if (b.type === 'text') {
        const text = typeof b.text === 'string' ? b.text : '';
        if (text.trim()) events.push({ kind: 'assistant', text });
      } else if (b.type === 'tool_use') {
        const id = typeof b.id === 'string' ? b.id : '';
        const name = typeof b.name === 'string' ? b.name : 'tool';
        const input = (b.input && typeof b.input === 'object')
          ? (b.input as Record<string, unknown>)
          : {};
        events.push({ kind: 'tool-use', id, name, input });
      }
    }
    return;
  }

  if (type === 'user') {
    const msg = r.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result') {
          events.push({
            kind: 'tool-result',
            id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
            content: flattenToolResultContent(b.content),
            isError: b.is_error === true,
          });
        }
      }
      return;
    }
    if (typeof content === 'string' && content.trim()) {
      events.push({ kind: 'user', text: content });
    }
    return;
  }

  if (type === 'result') {
    const subtype = typeof r.subtype === 'string' ? r.subtype : 'done';
    events.push({
      kind: 'result',
      subtype,
      durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : undefined,
      numTurns: typeof r.num_turns === 'number' ? r.num_turns : undefined,
      totalCostUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
    });
    return;
  }
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>;
      if (typeof it.text === 'string') parts.push(it.text);
    }
  }
  return parts.join('\n');
}

function summarizeSystem(subtype: string, r: Record<string, unknown>): string {
  if (subtype === 'init') {
    const model = typeof r.model === 'string' ? r.model : '';
    const tools = Array.isArray(r.tools) ? (r.tools as unknown[]).length : 0;
    const cwd = typeof r.cwd === 'string' ? r.cwd : '';
    const parts: string[] = ['Session started'];
    if (model) parts.push(model);
    if (tools) parts.push(`${tools} tools`);
    if (cwd) parts.push(cwd);
    return parts.join(' \u00b7 ');
  }
  if (subtype === 'hook_started') {
    const name = typeof r.hook_name === 'string' ? r.hook_name : 'hook';
    return `Hook started: ${name}`;
  }
  if (subtype === 'hook_response') {
    const name = typeof r.hook_name === 'string' ? r.hook_name : 'hook';
    const outcome = typeof r.outcome === 'string' ? r.outcome : '';
    return outcome ? `Hook ${name}: ${outcome}` : `Hook ${name}`;
  }
  return subtype;
}

/**
 * Format a tool-use event as a compact single-line summary.
 * The renderer uses this for the card header; the body renders the
 * tool-specific details (diff, command, etc.).
 */
export function toolHeadline(e: ToolUseEvent): string {
  const i = e.input;
  switch (e.name) {
    case 'Read': {
      const path = pickString(i, ['file_path', 'path']);
      return path ? `Read ${shortPath(path)}` : 'Read';
    }
    case 'Glob': {
      const pattern = pickString(i, ['pattern']);
      return pattern ? `Glob ${pattern}` : 'Glob';
    }
    case 'Grep': {
      const pattern = pickString(i, ['pattern']);
      const glob = pickString(i, ['glob']);
      if (pattern && glob) return `Grep ${pattern} in ${glob}`;
      return pattern ? `Grep ${pattern}` : 'Grep';
    }
    case 'Edit': {
      const path = pickString(i, ['file_path']);
      return path ? `Edit ${shortPath(path)}` : 'Edit';
    }
    case 'Write': {
      const path = pickString(i, ['file_path']);
      return path ? `Write ${shortPath(path)}` : 'Write';
    }
    case 'Bash': {
      const cmd = pickString(i, ['command']);
      return cmd ? `$ ${oneLine(cmd, 80)}` : 'Bash';
    }
    case 'Task': {
      const desc = pickString(i, ['description']);
      return desc ? `Spawn agent: ${desc}` : 'Spawn agent';
    }
    case 'WebFetch': {
      const url = pickString(i, ['url']);
      return url ? `Fetch ${url}` : 'Web fetch';
    }
    case 'WebSearch': {
      const q = pickString(i, ['query']);
      return q ? `Search "${q}"` : 'Web search';
    }
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? (i.todos as unknown[]).length : 0;
      return `Update todos (${todos})`;
    }
    case 'NotebookEdit': {
      const path = pickString(i, ['notebook_path', 'file_path']);
      return path ? `Notebook ${shortPath(path)}` : 'Notebook edit';
    }
    default:
      return e.name;
  }
}

export interface DiffRow {
  kind: 'del' | 'add' | 'ctx';
  text: string;
}

/**
 * Produce a very simple line-by-line diff for Edit tool inputs.
 * We don't align unchanged context — agents rarely share context between
 * `old_string` and `new_string`, so a flat "old lines in red, new lines in
 * green" render is both honest and compact. Callers display these rows under
 * the Edit card.
 */
export function simpleDiff(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const common = longestCommonPrefixLen(oldLines, newLines);
  for (let i = 0; i < common; i++) rows.push({ kind: 'ctx', text: oldLines[i] });
  for (let i = common; i < oldLines.length; i++) rows.push({ kind: 'del', text: oldLines[i] });
  for (let i = common; i < newLines.length; i++) rows.push({ kind: 'add', text: newLines[i] });
  return rows;
}

function longestCommonPrefixLen(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function pickString(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function shortPath(path: string, maxLen = 60): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return '\u2026' + path.slice(path.length - (maxLen - 1));
  return parts[0] + '/\u2026/' + parts.slice(-2).join('/');
}

function oneLine(s: string, maxLen: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen - 1) + '\u2026';
}
