import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { homedir } from 'os';
import type { Dirent, Stats } from 'fs';
import { AgentSession } from '../core/sessions';
import { runAgents } from '../core/agentsBin';
import type { SqlJsStatic } from 'sql.js';

// Cached SQL.js instance (lazy-loaded)
let sqlJsPromise: Promise<SqlJsStatic | null> | null = null;

async function getSqlJs(): Promise<SqlJsStatic | null> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      try {
        const initSqlJs = (await import('sql.js')).default;
        return await initSqlJs();
      } catch {
        return null;
      }
    })();
  }
  return sqlJsPromise;
}

const SESSION_EXTENSIONS = new Set(['.jsonl', '.json', '.txt']);
const MAX_PREVIEW_CHARS = 240;

async function safeReaddir(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function readHeadLines(filePath: string, maxLines: number): Promise<string[]> {
  const lines: string[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.trim()) {
        lines.push(line);
        if (lines.length >= maxLines) break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return lines;
}

// Read the last `maxLines` non-empty lines without loading the whole file.
// Opens the file, seeks backward in 64KB chunks from EOF until enough lines collected.
export async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  const CHUNK_SIZE = 64 * 1024;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const { size: fileSize } = await handle.stat();
    if (fileSize === 0) return [];

    let position = fileSize;
    let buffer = '';
    let collected: string[] = [];

    while (position > 0 && collected.length <= maxLines) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      await handle.read(chunk, 0, readSize, position);
      buffer = chunk.toString('utf-8') + buffer;
      collected = buffer.split(/\r?\n/).filter(l => l.trim());
    }

    return collected.slice(-maxLines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizePreview(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PREVIEW_CHARS - 3)}...`;
}

const SYNTHETIC_TAG_PREFIXES = [
  '<local-command-caveat',
  '<local-command-stdout',
  '<local-command-stderr',
  '<command-name',
  '<command-message',
  '<command-args',
  '<bash-input',
  '<bash-stdout',
  '<bash-stderr',
  '<system-reminder',
  '<permissions instructions',
  '<user-prompt-submit-hook',
  '<task-notification',
  '<persisted-output',
];

function isSyntheticCommandText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  for (const prefix of SYNTHETIC_TAG_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  const stripped = trimmed.replace(/<[^>]*>/g, '').trim();
  if (!stripped) return true;
  if (lower.startsWith('caveat: the messages below')) return true;
  if (lower.startsWith('# agents.md instructions for ') && lower.includes('<instructions>')) return true;
  if (lower.startsWith('<environment_context>')) return true;
  if (lower.startsWith('<turn_aborted>')) return true;
  if (lower.startsWith('<image ')) return true;
  return false;
}

function extractTextFromJson(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return null;

  const obj = value as Record<string, unknown>;
  const keys = ['content', 'text', 'message', 'prompt', 'input'];
  for (const key of keys) {
    const candidate = obj[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (Array.isArray(candidate)) {
      const parts = candidate
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && 'text' in entry) {
            const text = (entry as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }
  }

  if (obj.delta && typeof obj.delta === 'object' && obj.delta) {
    const delta = obj.delta as Record<string, unknown>;
    if (typeof delta.text === 'string' && delta.text.trim()) return delta.text;
  }

  return null;
}

function extractCandidatesFromValue(value: unknown): Array<{ role?: string; text: string }> {
  if (!value) return [];
  if (typeof value === 'string') return [{ text: value }];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractCandidatesFromValue(entry));
  }
  if (typeof value !== 'object') return [];

  const obj = value as Record<string, unknown>;

  if (Array.isArray(obj.messages)) {
    return extractCandidatesFromValue(obj.messages);
  }

  if (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)) {
    return extractCandidatesFromValue(obj.message);
  }

  if (obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload)) {
    return extractCandidatesFromValue(obj.payload);
  }

  if (Array.isArray(obj.content)) {
    const candidates = extractCandidatesFromValue(obj.content);
    const parentRole = typeof obj.role === 'string' ? obj.role : undefined;
    if (parentRole) {
      return candidates.map(c => ({ ...c, role: c.role || parentRole }));
    }
    return candidates;
  }

  const text = extractTextFromJson(obj);
  if (!text) return [];
  const role = typeof obj.role === 'string' ? obj.role : undefined;
  return [{ role, text }];
}

interface ExtractedPreview {
  text?: string;
  timestamp?: string;
}

function extractPreviewLines(head: string): ExtractedPreview {
  const lines = head.split(/\r?\n/);
  let firstAny: string | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    const trimmed = line.trim();
    let candidates: Array<{ role?: string; text: string; timestamp?: string }> = [];

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && (parsed as { isMeta?: unknown }).isMeta === true) {
          continue;
        }
        candidates = extractCandidatesFromValue(parsed);

        // Extract timestamp from the parsed event for user messages
        // Claude: event.timestamp, Codex: event.timestamp, Gemini: event.timestamp
        if (parsed && typeof parsed === 'object') {
          const eventTimestamp = (parsed as { timestamp?: unknown }).timestamp;
          if (eventTimestamp && typeof eventTimestamp === 'string') {
            for (const candidate of candidates) {
              candidate.timestamp = eventTimestamp;
            }
          }
        }
      } catch {
        candidates = [];
      }
    } else {
      candidates = [{ text: trimmed }];
    }

    for (const candidate of candidates) {
      const text = candidate.text?.trim();
      if (!text) continue;
      if (isSyntheticCommandText(text)) continue;
      const role = candidate.role?.toLowerCase();
      if (role === 'user' || role === 'human') {
        return { text: normalizePreview(text), timestamp: candidate.timestamp };
      }
      if (!firstAny) firstAny = text;
    }
  }

  if (!firstAny) return {};
  return { text: normalizePreview(firstAny) };
}

/** The subset of the CLI's flat `agents sessions --json` row (SessionMeta) read here. */
interface CliRecentSessionRow {
  id?: string;
  agent?: string;
  timestamp?: string;
  lastActivity?: string;
  filePath?: string;
  topic?: string;
  label?: string;
}

/**
 * Recent sessions across agents, from the CLI's own discovery (`agents sessions
 * --json --local`, issue #741). The CLI scans the real transcript roots — every
 * version home plus the current per-agent layouts (e.g. gemini's ~/.gemini/tmp,
 * which the old hand-rolled walk missed by scanning ~/.gemini/sessions) — so the
 * extension no longer re-implements per-agent directory formats. With a
 * workspace, the subprocess runs in that directory and the CLI's own workspace
 * scoping applies; without one, --all lists every workspace.
 */
export async function discoverRecentSessions(
  limit: number = 50,
  workspacePath?: string
): Promise<AgentSession[]> {
  let stdout: string;
  try {
    const args = `sessions --json --local --limit ${limit}${workspacePath ? '' : ' --all'}`;
    ({ stdout } = await runAgents(args, { cwd: workspacePath, timeout: 15_000 }));
  } catch {
    // CLI unavailable — no recent list, same as an unreadable session root before.
    return [];
  }

  let rows: unknown[];
  try {
    const parsed = JSON.parse(stdout);
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }

  const sessions: AgentSession[] = [];
  for (const row of rows as CliRecentSessionRow[]) {
    if (!row || typeof row !== 'object') continue;
    const agentType = row.agent;
    // AgentSession is the session-picker shape; it only knows the transcript
    // formats the extension can open.
    if (agentType !== 'claude' && agentType !== 'codex' && agentType !== 'gemini') continue;
    if (!row.id || !row.filePath) continue;
    const ts = Date.parse(row.lastActivity || row.timestamp || '');
    sessions.push({
      agentType,
      sessionId: row.id,
      timestamp: Number.isNaN(ts) ? new Date(0) : new Date(ts),
      path: row.filePath,
      preview: row.topic || row.label || undefined,
    });
  }

  sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return sessions.slice(0, limit);
}

export async function getSessionContent(session: AgentSession): Promise<string> {
  try {
    const content = await fs.readFile(session.path, 'utf-8');
    return content.toString();
  } catch (error) {
    console.error(`[SESSIONS] Failed to read ${session.path}`, error);
    return '';
  }
}

// --- Session path resolution by sessionId ---

export async function findFileBySessionId(dir: string, sessionId: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  const entries = await safeReaddir(dir);

  // If sessionId is short (8 chars = session chunk), do prefix match
  const isChunk = sessionId.length === 8;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileBySessionId(fullPath, sessionId, depth - 1);
      if (found) return found;
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (SESSION_EXTENSIONS.has(ext)) {
      const fileSessionId = path.basename(entry.name, ext);
      // Exact match or prefix match for session chunks
      if (fileSessionId === sessionId || fileSessionId.endsWith(sessionId) || (isChunk && fileSessionId.startsWith(sessionId))) {
        return fullPath;
      }
    }
  }

  return undefined;
}

export async function getClaudeProjectRoots(homeDir: string = homedir()): Promise<string[]> {
  const roots: string[] = [path.join(homeDir, '.claude', 'projects')];
  const versionHomes = [
    path.join(homeDir, '.agents-system', 'versions', 'claude'),
    path.join(homeDir, '.agents', '.history', 'versions', 'claude'),
  ];
  for (const versionsDir of versionHomes) {
    const versions = await safeReaddir(versionsDir);
    for (const ver of versions) {
      if (!ver.isDirectory()) continue;
      roots.push(path.join(versionsDir, ver.name, 'home', '.claude', 'projects'));
    }
  }
  return roots;
}

export async function getSessionPathBySessionId(
  sessionId: string,
  agentType: 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'copilot' | 'antigravity' | 'grok' | 'kimi' | 'droid',
  workspacePath?: string,
  homeDir: string = homedir(),
): Promise<string | undefined> {
  switch (agentType) {
    case 'claude': {
      // We know the exact filename: {sessionId}.jsonl
      // Just find it under ~/.claude/projects/*/ or shim paths
      const filename = `${sessionId}.jsonl`;
      const roots = await getClaudeProjectRoots(homeDir);

      // Search each root's project subdirectories for the file
      for (const root of roots) {
        const projects = await safeReaddir(root);
        for (const project of projects) {
          if (!project.isDirectory()) continue;
          const filePath = path.join(root, project.name, filename);
          if (await safeStat(filePath)) return filePath;
        }
      }
      return undefined;
    }
    case 'codex': {
      const root = path.join(homedir(), '.codex', 'sessions');
      return await findFileBySessionId(root, sessionId, 4);
    }
    case 'gemini': {
      // Gemini stores chats at ~/.gemini/tmp/{projectHash}/chats/session-*.json.
      // Filenames embed the first 8 chars of sessionId; fall back to JSON scan
      // if the shorthand doesn't match (e.g. duplicate suffixes across projects).
      const tmpRoot = path.join(homedir(), '.gemini', 'tmp');
      const projects = await safeReaddir(tmpRoot);
      const shortId = sessionId.slice(0, 8);
      const candidates: string[] = [];
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const chatsDir = path.join(tmpRoot, project.name, 'chats');
        const entries = await safeReaddir(chatsDir);
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const filePath = path.join(chatsDir, entry.name);
          if (entry.name.endsWith(`-${shortId}.json`)) return filePath;
          candidates.push(filePath);
        }
      }
      for (const filePath of candidates) {
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed?.sessionId === sessionId) return filePath;
        } catch { }
      }
      return undefined;
    }
    case 'opencode': {
      // OpenCode stores messages in ~/.local/share/opencode/storage/message/{sessionId}/
      // with content in part/{messageId}/ - return the message directory path
      const messageDir = path.join(homedir(), '.local', 'share', 'opencode', 'storage', 'message', sessionId);
      if (await safeStat(messageDir)) return messageDir;
      return undefined;
    }
    case 'cursor': {
      // Cursor stores chats in ~/.cursor/chats/{workspaceHash}/{chatId}/store.db (SQLite)
      // sessionId is the chatId (UUID format like 52183600-90ca-4703-aeb7-f9017aab808e)
      const chatsRoot = path.join(homedir(), '.cursor', 'chats');
      const workspaceHashes = await safeReaddir(chatsRoot);
      for (const wsHash of workspaceHashes) {
        if (!wsHash.isDirectory()) continue;
        const chatPath = path.join(chatsRoot, wsHash.name, sessionId, 'store.db');
        if (await safeStat(chatPath)) return chatPath;
      }
      return undefined;
    }
    case 'copilot': {
      // GitHub Copilot CLI v1.0.56+ stores per-session NDJSON event streams at
      // ~/.copilot/session-state/<sessionId>/events.jsonl. Verified against a
      // live run and `copilot help environment` (COPILOT_HOME defaults to
      // $HOME/.copilot).
      const eventsPath = path.join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
      if (await safeStat(eventsPath)) return eventsPath;
      return undefined;
    }
    default:
      return undefined;
  }
}

// --- Session preview info (last user message + message count) ---

export interface SessionPreviewInfo {
  firstUserMessage?: string;
  firstUserMessageTimestamp?: string;
  lastUserMessage?: string;
  lastActivityMs?: number;
  messageCount: number;
}


function extractLastUserMessage(tail: string): string | undefined {
  const lines = tail.split(/\r?\n/).filter(l => l.trim()).reverse();

  for (const line of lines) {
    const trimmed = line.trim();
    let candidates: Array<{ role?: string; text: string }> = [];

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && (parsed as { isMeta?: unknown }).isMeta === true) {
          continue;
        }
        candidates = extractCandidatesFromValue(parsed);
      } catch {
        candidates = [];
      }
    } else {
      candidates = [{ text: trimmed }];
    }

    for (const candidate of candidates) {
      const text = candidate.text?.trim();
      if (!text) continue;
      if (isSyntheticCommandText(text)) continue;
      const role = candidate.role?.toLowerCase();
      if (role === 'user' || role === 'human') {
        return normalizePreview(text);
      }
    }
  }

  return undefined;
}

// Whitespace bytes for the "non-empty line" test. '\n' (0x0a) is never part of
// a multi-byte UTF-8 sequence, and every ASCII whitespace byte is single-byte,
// so we can count lines at the byte level without decoding the file.
const WS_BYTES = new Set([0x20, 0x09, 0x0d, 0x0a]);

// Incremental non-empty line count for append-only JSONL session files.
// We cache how many complete (newline-terminated) non-empty lines we've already
// counted and the byte offset just past the last counted '\n', then only scan
// the bytes appended since. A trailing partial line (no '\n' yet) is counted in
// the return value but not cached, so it's re-evaluated once it's completed.
interface LineCountCacheEntry {
  scannedBytes: number;
  completeLines: number;
}
const LINE_COUNT_CACHE = new Map<string, LineCountCacheEntry>();
const LINE_COUNT_CACHE_MAX = 200;

async function countNonEmptyLines(filePath: string): Promise<number> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }

  let cached = LINE_COUNT_CACHE.get(filePath);
  if (cached && cached.scannedBytes > size) {
    cached = undefined; // file shrank or was replaced -> rescan from the top
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    let scannedBytes = cached?.scannedBytes ?? 0;
    let completeLines = cached?.completeLines ?? 0;
    let pendingHasContent = false; // current (unterminated) line has non-ws bytes

    const CHUNK_SIZE = 64 * 1024;
    let position = scannedBytes;
    while (position < size) {
      const readLen = Math.min(CHUNK_SIZE, size - position);
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, position);
      for (let i = 0; i < readLen; i++) {
        const b = buf[i];
        if (b === 0x0a) {
          if (pendingHasContent) completeLines++;
          pendingHasContent = false;
          scannedBytes = position + i + 1;
        } else if (!WS_BYTES.has(b)) {
          pendingHasContent = true;
        }
      }
      position += readLen;
    }

    LINE_COUNT_CACHE.set(filePath, { scannedBytes, completeLines });
    evictLRU(LINE_COUNT_CACHE, LINE_COUNT_CACHE_MAX);

    return completeLines + (pendingHasContent ? 1 : 0);
  } catch {
    return 0;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Cache of full SessionPreviewInfo, invalidated by file mtime/size.
interface PreviewCacheEntry {
  mtimeMs: number;
  size: number;
  preview: SessionPreviewInfo;
}
const PREVIEW_CACHE = new Map<string, PreviewCacheEntry>();
const PREVIEW_CACHE_MAX = 200;

// The first user message of a session file is immutable once written.
// Cache it permanently (per filePath) so the hot "fetch label on focus"
// path never re-reads the file once the label has been extracted.
interface FirstMessageCacheEntry {
  text?: string;
  timestamp?: string;
}
const FIRST_MSG_CACHE = new Map<string, FirstMessageCacheEntry>();
const FIRST_MSG_CACHE_MAX = 500;

function evictLRU<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export async function getSessionPreviewInfo(filePath: string): Promise<SessionPreviewInfo> {
  let stat: Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { messageCount: 0 };
  }

  const cached = PREVIEW_CACHE.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    PREVIEW_CACHE.delete(filePath);
    PREVIEW_CACHE.set(filePath, cached);
    return cached.preview;
  }

  let firstMsgEntry = FIRST_MSG_CACHE.get(filePath);

  const [headLines, tailLines, messageCount] = await Promise.all([
    firstMsgEntry ? Promise.resolve<string[]>([]) : readHeadLines(filePath, 60),
    readTailLines(filePath, 20),
    countNonEmptyLines(filePath),
  ]);

  if (!firstMsgEntry) {
    const extracted = extractPreviewLines(headLines.join('\n'));
    firstMsgEntry = { text: extracted.text, timestamp: extracted.timestamp };
    FIRST_MSG_CACHE.set(filePath, firstMsgEntry);
    evictLRU(FIRST_MSG_CACHE, FIRST_MSG_CACHE_MAX);
  }

  const lastUserMessage = extractLastUserMessage(tailLines.join('\n'));

  const preview: SessionPreviewInfo = {
    firstUserMessage: firstMsgEntry.text,
    firstUserMessageTimestamp: firstMsgEntry.timestamp,
    lastUserMessage,
    lastActivityMs: stat.mtimeMs,
    messageCount,
  };

  PREVIEW_CACHE.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, preview });
  evictLRU(PREVIEW_CACHE, PREVIEW_CACHE_MAX);

  return preview;
}

/**
 * Get session preview info for OpenCode sessions.
 * OpenCode stores messages in separate JSON files with content in part/ directory.
 * Structure: message/{sessionId}/msg_xxx.json -> part/{messageId}/prt_xxx.json
 */
export async function getOpenCodeSessionPreviewInfo(messageDir: string): Promise<SessionPreviewInfo> {
  try {
    const entries = await safeReaddir(messageDir);
    const msgFiles = entries
      .filter(e => e.isFile() && e.name.startsWith('msg_') && e.name.endsWith('.json'))
      .map(e => e.name)
      .sort(); // Sort to get chronological order (IDs are time-based)

    if (msgFiles.length === 0) {
      return { messageCount: 0 };
    }

    // Find first user message
    let firstUserMessage: string | undefined;
    for (const msgFile of msgFiles) {
      try {
        const msgPath = path.join(messageDir, msgFile);
        const msgContent = await fs.readFile(msgPath, 'utf-8');
        const msg = JSON.parse(msgContent);

        if (msg.role === 'user') {
          // Try to get actual text from part file
          const messageId = msg.id;
          const partDir = path.join(homedir(), '.local', 'share', 'opencode', 'storage', 'part', messageId);
          const partEntries = await safeReaddir(partDir);
          const partFile = partEntries.find(e => e.isFile() && e.name.startsWith('prt_') && e.name.endsWith('.json'));

          if (partFile) {
            const partPath = path.join(partDir, partFile.name);
            const partContent = await fs.readFile(partPath, 'utf-8');
            const part = JSON.parse(partContent);
            if (part.text && typeof part.text === 'string') {
              firstUserMessage = normalizePreview(part.text);
              break;
            }
          }

          // Fallback to summary.title if no part file
          if (msg.summary?.title) {
            firstUserMessage = normalizePreview(msg.summary.title);
            break;
          }
        }
      } catch {
        continue;
      }
    }

    return {
      firstUserMessage,
      messageCount: msgFiles.length
    };
  } catch {
    return { messageCount: 0 };
  }
}

/**
 * Get session preview info for Cursor Agent sessions.
 * Cursor stores chats in SQLite databases at ~/.cursor/chats/{hash}/{chatId}/store.db
 * Structure: blobs table contains JSON messages with role and content fields
 * Uses sql.js (WebAssembly SQLite) for cross-platform compatibility.
 */
export async function getCursorSessionPreviewInfo(dbPath: string): Promise<SessionPreviewInfo> {
  try {
    const SQL = await getSqlJs();
    if (!SQL) {
      return { messageCount: 0 };
    }

    // Read the database file (async so it doesn't block the extension host)
    const fileBuffer = await fs.readFile(dbPath);
    const db = new SQL.Database(fileBuffer);

    try {
      // Get all blobs
      const results = db.exec('SELECT data FROM blobs');
      if (!results.length || !results[0].values.length) {
        return { messageCount: 0 };
      }

      let firstUserMessage: string | undefined;
      let messageCount = 0;

      for (const row of results[0].values) {
        try {
          // sql.js returns blob data as Uint8Array
          const data = row[0];
          if (!(data instanceof Uint8Array)) continue;
          if (data.length === 0 || data[0] !== 0x7B) continue; // Skip non-JSON blobs

          const dataStr = new TextDecoder().decode(data);
          const msg = JSON.parse(dataStr);

          if (msg.role === 'user') {
            messageCount++;
            if (!firstUserMessage && msg.content) {
              // Extract text from content array
              // Format: [{type: "text", text: "..."}, ...]
              const content = Array.isArray(msg.content) ? msg.content : [msg.content];
              for (const part of content) {
                if (typeof part === 'string') {
                  if (!part.startsWith('<')) {
                    firstUserMessage = normalizePreview(part);
                    break;
                  }
                }
                if (part && typeof part === 'object' && part.type === 'text' && part.text) {
                  const text = part.text as string;
                  // Extract text from <user_query> tags if present
                  const queryMatch = text.match(/<user_query>\s*([\s\S]*?)\s*(?:<\/user_query>|$)/);
                  if (queryMatch) {
                    firstUserMessage = normalizePreview(queryMatch[1].trim());
                    break;
                  }
                  if (!text.startsWith('<')) {
                    firstUserMessage = normalizePreview(text);
                    break;
                  }
                }
              }
            }
          } else if (msg.role === 'assistant') {
            messageCount++;
          }
        } catch {
          continue;
        }
      }

      return {
        firstUserMessage,
        messageCount
      };
    } finally {
      db.close();
    }
  } catch {
    return { messageCount: 0 };
  }
}
