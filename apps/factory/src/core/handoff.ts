import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { todoProgressFromCli, type TodoProgress } from './session.activity';

export interface SessionToolStats {
  toolCalls: number;
  filesEdited: number;
  filesRead: number;
  recentFiles: string[];
  /** Live checklist progress from the CLI's `session.todos` (RUSH-1503); undefined
   *  when the session wrote no todo list or an older CLI omitted the field. */
  todos?: TodoProgress;
}

export interface HandoffMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HandoffContext {
  fromAgent: string;
  messages: HandoffMessage[];
  planContent?: string;
  planPath?: string;
}

const CLAUDE_PLANS_DIR = path.join(homedir(), '.claude', 'plans');

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function getFileStats(filePath: string): Promise<{ path: string; mtime: Date } | null> {
  try {
    const stats = await fs.stat(filePath);
    return { path: filePath, mtime: stats.mtime };
  } catch {
    return null;
  }
}

export async function findRecentClaudePlan(): Promise<{ path: string; content: string } | null> {
  const files = await safeReaddir(CLAUDE_PLANS_DIR);
  if (files.length === 0) return null;

  const stats = await Promise.all(files.map(getFileStats));
  const validStats = stats.filter((s): s is { path: string; mtime: Date } => s !== null);

  if (validStats.length === 0) return null;

  validStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const mostRecent = validStats[0];

  try {
    const content = await fs.readFile(mostRecent.path, 'utf-8');
    return { path: mostRecent.path, content };
  } catch {
    return null;
  }
}

interface AgentsCliSessionEvent {
  type: string;
  role?: string;
  content?: string;
  text?: string;
}

function runAgentsSessions(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('agents', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function getSessionSummaryViaAgentsCli(
  sessionId: string,
  cwd?: string
): Promise<string | null> {
  try {
    const stdout = await runAgentsSessions(['sessions', sessionId], cwd);
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function getSessionMessagesViaAgentsCli(
  sessionId: string,
  maxMessages: number = 10,
  cwd?: string
): Promise<HandoffMessage[]> {
  try {
    const turns = Math.max(1, Math.ceil(maxMessages / 2));
    const stdout = await runAgentsSessions(
      ['sessions', sessionId, '--json', '--last', String(turns), '--include', 'user,assistant'],
      cwd
    );
    // 1.20.51+ emits { session, events }; older CLIs emit a bare event array.
    const parsed = JSON.parse(stdout);
    const events: AgentsCliSessionEvent[] = Array.isArray(parsed) ? parsed : (parsed.events ?? []);
    const messages: HandoffMessage[] = [];
    for (const ev of events) {
      if (ev.type !== 'message') continue;
      if (ev.role !== 'user' && ev.role !== 'assistant') continue;
      const content = typeof ev.content === 'string' ? ev.content : ev.text;
      if (!content || !content.trim()) continue;
      messages.push({ role: ev.role, content });
    }
    return messages.slice(-maxMessages);
  } catch {
    return [];
  }
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_diff', 'write_file', 'edit_file']);
const FILE_READ_TOOLS = new Set(['Read', 'read_file', 'ReadFile']);

async function computeSessionToolStats(
  sessionId: string,
  cwd?: string
): Promise<SessionToolStats> {
  const stdout = await runAgentsSessions(
    ['sessions', sessionId, '--json', '--include', 'tools'],
    cwd
  );
  // 1.20.51+ emits { session, events }; older CLIs emit a bare event array.
  const parsedStats = JSON.parse(stdout);
  const events: Array<{ type: string; tool?: string; args?: Record<string, unknown> }> = Array.isArray(
    parsedStats
  )
    ? parsedStats
    : (parsedStats.events ?? []);
  // Live checklist rides the SAME CLI call (RUSH-1503): `session.todos` is the
  // state engine's computed checklist, so the panel no longer re-parses the tail.
  const todos = Array.isArray(parsedStats)
    ? undefined
    : (todoProgressFromCli(parsedStats.session?.todos) ?? undefined);
  const toolUses = events.filter(ev => ev.type === 'tool_use');
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  const recentFiles: string[] = [];

  for (const ev of toolUses) {
    if (!ev.tool || !ev.args) continue;
    const filePath = (ev.args.file_path ?? ev.args.path ?? ev.args.filePath) as string | undefined;
    if (typeof filePath !== 'string') continue;
    if (FILE_EDIT_TOOLS.has(ev.tool)) {
      editedFiles.add(filePath);
    } else if (FILE_READ_TOOLS.has(ev.tool)) {
      readFiles.add(filePath);
    }
    if (!recentFiles.includes(filePath)) recentFiles.push(filePath);
  }

  return {
    toolCalls: toolUses.length,
    filesEdited: editedFiles.size,
    filesRead: readFiles.size,
    recentFiles: recentFiles.slice(-20),
    todos,
  };
}

interface ToolStatsCacheEntry {
  mtimeMs: number;
  size: number;
  stats: SessionToolStats;
}

// Tool-stats are read by the agentPanel 4s poll, per window. The session
// transcript only grows when the agent acts, so cache the result keyed by the
// session file's mtime+size and re-shell out only when it actually changed.
// An in-flight guard coalesces concurrent callers onto one subprocess so a slow
// `agents sessions` call can't stack across ticks (#94).
const toolStatsCache = new Map<string, ToolStatsCacheEntry>();
const toolStatsInFlight = new Map<string, Promise<SessionToolStats>>();

// Exported for tests. `compute` is the real work (shelling out to the agents
// CLI in production); the cache and in-flight machinery are exercised directly.
export async function getCachedToolStats(
  sessionId: string,
  sessionFilePath: string | undefined,
  compute: () => Promise<SessionToolStats>,
): Promise<SessionToolStats> {
  let key: { mtimeMs: number; size: number } | undefined;
  if (sessionFilePath) {
    try {
      const st = await fs.stat(sessionFilePath);
      key = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      key = undefined;
    }
    if (key) {
      const cached = toolStatsCache.get(sessionId);
      if (cached && cached.mtimeMs === key.mtimeMs && cached.size === key.size) {
        return cached.stats;
      }
    }
  }

  const inflight = toolStatsInFlight.get(sessionId);
  if (inflight) return inflight;

  const p = compute()
    .then((stats) => {
      if (key) toolStatsCache.set(sessionId, { ...key, stats });
      return stats;
    })
    .finally(() => {
      if (toolStatsInFlight.get(sessionId) === p) toolStatsInFlight.delete(sessionId);
    });
  toolStatsInFlight.set(sessionId, p);
  return p;
}

export async function getSessionToolStatsViaAgentsCli(
  sessionId: string,
  cwd?: string,
  sessionFilePath?: string,
): Promise<SessionToolStats> {
  try {
    return await getCachedToolStats(
      sessionId,
      sessionFilePath,
      () => computeSessionToolStats(sessionId, cwd),
    );
  } catch {
    return { toolCalls: 0, filesEdited: 0, filesRead: 0, recentFiles: [] };
  }
}

export interface ContinueContext {
  originalTask: string | null;
  lastResponse: string | null;
  recentFiles: string[];
  toolCalls: number;
  filesEdited: number;
  filesRead: number;
}

export function formatContinuePrompt(ctx: ContinueContext): string {
  const parts: string[] = [];

  parts.push('Continue working on this task from a previous session.');

  if (ctx.originalTask) {
    const task = ctx.originalTask.length > 500
      ? ctx.originalTask.slice(0, 500) + '...'
      : ctx.originalTask;
    parts.push('');
    parts.push('<original_task>');
    parts.push(task);
    parts.push('</original_task>');
  }

  if (ctx.recentFiles.length > 0 || ctx.toolCalls > 0) {
    parts.push('');
    parts.push('<session_activity>');
    parts.push(`${ctx.filesEdited} files edited, ${ctx.filesRead} files read, ${ctx.toolCalls} tool calls`);
    if (ctx.recentFiles.length > 0) {
      parts.push(`Recent files: ${ctx.recentFiles.slice(0, 20).join(', ')}`);
    }
    parts.push('</session_activity>');
  }

  if (ctx.lastResponse) {
    const response = ctx.lastResponse.length > 2000
      ? ctx.lastResponse.slice(0, 2000) + '...'
      : ctx.lastResponse;
    parts.push('');
    parts.push('<last_response>');
    parts.push(response);
    parts.push('</last_response>');
  }

  parts.push('');
  parts.push('Read the recently edited files to understand current state, then continue where the previous session left off.');

  return parts.join('\n');
}

export function formatHandoffPrompt(context: HandoffContext): string {
  const parts: string[] = [];

  parts.push(`Please take over this task from ${context.fromAgent}.`);

  if (context.messages.length > 0) {
    parts.push('\n\n<recent_messages>');
    for (const msg of context.messages) {
      const roleName = msg.role === 'user' ? 'User' : 'Assistant';
      const truncated = msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content;
      parts.push(`${roleName}: ${truncated}`);
    }
    parts.push('</recent_messages>');
  }

  if (context.planContent) {
    parts.push('\n\n<current_plan>');
    parts.push(context.planContent);
    parts.push('</current_plan>');
  }

  return parts.join('\n');
}
