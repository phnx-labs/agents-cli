export type SessionSummaryAgentType = 'claude' | 'codex' | 'gemini';

export interface SessionQuickSummary {
  filesEdited: number;
  filesRead: number;
  filesCreated: number;
  filesDeleted: number;
  toolCalls: number;
  webSearches: number;
  webFetches: number;
  mcpCalls: number;
}

export interface RecentToolCall {
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  timestamp?: string;
}

export interface SessionQuickDetails {
  summary: SessionQuickSummary;
  recentFiles: string[];
  recentFileTimes: Record<string, number>;
  recentTools: string[];
  recentToolCalls: RecentToolCall[];
  lastFilePath: string | null;
  /**
   * The agent's most recent substantive assistant prose — the natural-language
   * text it emits between tool calls. Pure tool-call turns, thinking-only turns,
   * and empty/whitespace turns are skipped. Truncated at a word boundary.
   * '' when the session has no assistant prose yet.
   */
  narrative: string;
}

const MAX_RECENT_TOOL_CALLS = 24;
const MAX_TOOL_OUTPUT_CHARS = 4000;
const MAX_NARRATIVE_CHARS = 160;

type MutableSessionQuickSummary = {
  filesEdited: Set<string>;
  filesRead: Set<string>;
  filesCreated: Set<string>;
  filesDeleted: Set<string>;
  recentChangedFiles: string[];
  recentTouchedFiles: string[];
  recentFileTimes: Record<string, number>;
  recentTools: string[];
  recentToolCalls: RecentToolCall[];
  pendingToolCallById: Map<string, RecentToolCall>;
  toolCalls: number;
  webSearches: number;
  webFetches: number;
  mcpCalls: number;
  maxWebSearchesFromUsage: number;
  maxWebFetchesFromUsage: number;
  lastAssistantText: string;
};

function initMutableSummary(): MutableSessionQuickSummary {
  return {
    filesEdited: new Set<string>(),
    filesRead: new Set<string>(),
    filesCreated: new Set<string>(),
    filesDeleted: new Set<string>(),
    recentChangedFiles: [],
    recentTouchedFiles: [],
    recentFileTimes: {},
    recentTools: [],
    recentToolCalls: [],
    pendingToolCallById: new Map<string, RecentToolCall>(),
    toolCalls: 0,
    webSearches: 0,
    webFetches: 0,
    mcpCalls: 0,
    maxWebSearchesFromUsage: 0,
    maxWebFetchesFromUsage: 0,
    lastAssistantText: '',
  };
}

/**
 * Pull natural-language prose out of an assistant message's content. Handles both
 * a bare string and the block-array shape common to every CLI: Claude
 * `{type:'text', text}`, Codex `{type:'output_text', text}`. Thinking / reasoning /
 * tool_use blocks carry no `text` under those types, so they are skipped.
 */
function assistantTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const rec = toRecord(block);
    if (!rec) continue;
    const type = toStringValue(rec.type);
    if (type !== 'text' && type !== 'output_text' && type !== 'input_text') continue;
    const text = toStringValue(rec.text).trim();
    if (text) parts.push(text);
  }
  return parts.join(' ').trim();
}

/** Collapse whitespace and truncate to ~160 chars at a word boundary. */
function truncateNarrative(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_NARRATIVE_CHARS) return clean;
  const slice = clean.slice(0, MAX_NARRATIVE_CHARS);
  const lastSpace = slice.lastIndexOf(' ');
  const base = lastSpace > MAX_NARRATIVE_CHARS * 0.6 ? slice.slice(0, lastSpace) : slice;
  return base.replace(/[\s,.;:]+$/, '') + '...';
}

function parseTimestampMs(ts?: string): number | undefined {
  if (!ts) return undefined;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? undefined : ms;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n... [truncated]';
}

function stringifyToolResultContent(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const rec = toRecord(item);
      if (!rec) continue;
      const text = toStringValue(rec.text);
      if (text) {
        parts.push(text);
        continue;
      }
      const itemType = toStringValue(rec.type);
      if (itemType === 'image') {
        parts.push('[image]');
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pushToolCall(summary: MutableSessionQuickSummary, call: RecentToolCall, id?: string): void {
  summary.recentToolCalls.unshift(call);
  if (summary.recentToolCalls.length > MAX_RECENT_TOOL_CALLS) {
    const dropped = summary.recentToolCalls.pop();
    if (dropped) {
      for (const [key, value] of summary.pendingToolCallById) {
        if (value === dropped) {
          summary.pendingToolCallById.delete(key);
          break;
        }
      }
    }
  }
  if (id) summary.pendingToolCallById.set(id, call);
}

function attachToolResult(
  summary: MutableSessionQuickSummary,
  id: string,
  output: string,
  isError: boolean
): void {
  const call = summary.pendingToolCallById.get(id);
  if (!call) return;
  call.output = truncateOutput(output);
  if (isError) call.isError = true;
  summary.pendingToolCallById.delete(id);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNumberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return toRecord(parsed) || {};
    } catch {
      return {};
    }
  }
  return toRecord(value) || {};
}

function pathFromArgs(args: Record<string, unknown>): string {
  const path = toStringValue(args.path);
  if (path) return path;
  const filePath = toStringValue(args.file_path);
  if (filePath) return filePath;
  return toStringValue(args.target_file);
}

function parsePatchPaths(input: unknown): Array<{ kind: 'create' | 'write' | 'delete'; path: string }> {
  let patchText = '';
  if (typeof input === 'string') {
    patchText = input;
  } else {
    const rec = toRecord(input);
    if (rec) {
      patchText =
        toStringValue(rec.patch) ||
        toStringValue(rec.input) ||
        toStringValue(rec.text) ||
        toStringValue(rec.content);
    }
  }
  if (!patchText) return [];

  const changes: Array<{ kind: 'create' | 'write' | 'delete'; path: string }> = [];
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      if (path) changes.push({ kind: 'create', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      if (path) changes.push({ kind: 'write', path });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      if (path) changes.push({ kind: 'delete', path });
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      const path = line.slice('*** Move to: '.length).trim();
      if (path) changes.push({ kind: 'write', path });
    }
  }
  return changes;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function isWebSearchTool(toolName: string): boolean {
  const value = lower(toolName);
  return value.includes('web_search') || value.includes('websearch');
}

function isWebFetchTool(toolName: string): boolean {
  const value = lower(toolName);
  return value.includes('web_fetch') || value.includes('webfetch');
}

function isMcpTool(toolName: string): boolean {
  const value = lower(toolName);
  return value.startsWith('mcp__') || value.startsWith('mcp.');
}

function addRecentUnique(list: string[], value: string): void {
  if (!value) return;
  const idx = list.indexOf(value);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(value);
}

function addToolCounters(summary: MutableSessionQuickSummary, toolName: string): void {
  addRecentUnique(summary.recentTools, toolName);
  if (isWebSearchTool(toolName)) {
    summary.webSearches++;
  }
  if (isWebFetchTool(toolName)) {
    summary.webFetches++;
  }
  if (isMcpTool(toolName)) {
    summary.mcpCalls++;
  }
}

function recordFileTime(summary: MutableSessionQuickSummary, filePath: string, tsMs?: number): void {
  if (tsMs !== undefined) summary.recentFileTimes[filePath] = tsMs;
}

function addFileWrite(summary: MutableSessionQuickSummary, filePath: string, tsMs?: number): void {
  if (!filePath) return;
  summary.filesEdited.add(filePath);
  addRecentUnique(summary.recentChangedFiles, filePath);
  addRecentUnique(summary.recentTouchedFiles, filePath);
  recordFileTime(summary, filePath, tsMs);
}

function addFileRead(summary: MutableSessionQuickSummary, filePath: string, tsMs?: number): void {
  if (!filePath) return;
  summary.filesRead.add(filePath);
  addRecentUnique(summary.recentTouchedFiles, filePath);
  recordFileTime(summary, filePath, tsMs);
}

function addFileCreate(summary: MutableSessionQuickSummary, filePath: string, tsMs?: number): void {
  if (!filePath) return;
  summary.filesCreated.add(filePath);
  summary.filesEdited.add(filePath);
  addRecentUnique(summary.recentChangedFiles, filePath);
  addRecentUnique(summary.recentTouchedFiles, filePath);
  recordFileTime(summary, filePath, tsMs);
}

function addFileDelete(summary: MutableSessionQuickSummary, filePath: string, tsMs?: number): void {
  if (!filePath) return;
  summary.filesDeleted.add(filePath);
  summary.filesEdited.add(filePath);
  addRecentUnique(summary.recentChangedFiles, filePath);
  addRecentUnique(summary.recentTouchedFiles, filePath);
  recordFileTime(summary, filePath, tsMs);
}

function applyClaudeEvent(summary: MutableSessionQuickSummary, event: Record<string, unknown>): void {
  const eventType = toStringValue(event.type);
  const eventTimestamp = toStringValue(event.timestamp) || undefined;
  const tsMs = parseTimestampMs(eventTimestamp);

  if (eventType === 'assistant') {
    const message = toRecord(event.message);
    const content = message?.content;
    if (!Array.isArray(content)) return;

    const text = assistantTextFromContent(content);
    if (text) summary.lastAssistantText = text;

    for (const block of content) {
      const blockRecord = toRecord(block);
      if (!blockRecord || toStringValue(blockRecord.type) !== 'tool_use') continue;

      const toolName = toStringValue(blockRecord.name);
      const toolInput = toRecord(blockRecord.input) || {};
      const toolUseId = toStringValue(blockRecord.id) || undefined;
      summary.toolCalls++;
      addToolCounters(summary, toolName);
      pushToolCall(
        summary,
        { name: toolName, input: blockRecord.input, timestamp: eventTimestamp },
        toolUseId
      );

      if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
        addFileRead(summary, pathFromArgs(toolInput), tsMs);
        continue;
      }

      if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
        addFileWrite(summary, pathFromArgs(toolInput), tsMs);
        continue;
      }

      if (toolName === 'Delete') {
        addFileDelete(summary, pathFromArgs(toolInput), tsMs);
      }
    }

    return;
  }

  if (eventType === 'user') {
    const message = toRecord(event.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const blockRecord = toRecord(block);
        if (!blockRecord || toStringValue(blockRecord.type) !== 'tool_result') continue;
        const toolUseId = toStringValue(blockRecord.tool_use_id);
        if (!toolUseId) continue;
        const output = stringifyToolResultContent(blockRecord.content);
        const isError = blockRecord.is_error === true;
        attachToolResult(summary, toolUseId, output, isError);
      }
    }

    const toolUseResult = toRecord(event.tool_use_result);
    if (!toolUseResult) return;

    const resultType = toStringValue(toolUseResult.type);
    const resultPath = toStringValue(toolUseResult.filePath);
    if (resultType === 'create' && resultPath) {
      addFileCreate(summary, resultPath, tsMs);
    } else if (resultType === 'delete' && resultPath) {
      addFileDelete(summary, resultPath, tsMs);
    }

    const file = toRecord(toolUseResult.file);
    if (file) {
      const readPath = toStringValue(file.filePath);
      if (readPath) {
        addFileRead(summary, readPath, tsMs);
      }
    }

    return;
  }

  if (eventType === 'result') {
    const usage = toRecord(event.usage);
    const serverToolUse = usage ? toRecord(usage.server_tool_use) : null;
    if (!serverToolUse) return;
    summary.maxWebSearchesFromUsage = Math.max(
      summary.maxWebSearchesFromUsage,
      toNumberValue(serverToolUse.web_search_requests)
    );
    summary.maxWebFetchesFromUsage = Math.max(
      summary.maxWebFetchesFromUsage,
      toNumberValue(serverToolUse.web_fetch_requests)
    );
  }
}

function applyCodexToolCall(
  summary: MutableSessionQuickSummary,
  toolName: string,
  args: Record<string, unknown>,
  callId?: string,
  timestamp?: string
): void {
  const name = lower(toolName);
  const filePath = pathFromArgs(args);
  const tsMs = parseTimestampMs(timestamp);

  summary.toolCalls++;
  addToolCounters(summary, toolName);
  pushToolCall(summary, { name: toolName, input: args, timestamp }, callId);

  if (name === 'create_file') {
    addFileCreate(summary, filePath, tsMs);
    return;
  }

  if (name === 'apply_patch') {
    for (const change of parsePatchPaths(args)) {
      if (change.kind === 'create') addFileCreate(summary, change.path, tsMs);
      else if (change.kind === 'delete') addFileDelete(summary, change.path, tsMs);
      else addFileWrite(summary, change.path, tsMs);
    }
    return;
  }

  if (name === 'write_file' || name === 'edit_file' || name === 'apply_diff') {
    addFileWrite(summary, filePath, tsMs);
    return;
  }

  if (name === 'read_file' || name === 'view_file') {
    addFileRead(summary, filePath, tsMs);
    return;
  }

  if (name === 'delete_file' || name === 'remove_file') {
    addFileDelete(summary, filePath, tsMs);
  }
}

function applyCodexEvent(summary: MutableSessionQuickSummary, event: Record<string, unknown>): void {
  const eventType = toStringValue(event.type);
  const eventTimestamp = toStringValue(event.timestamp) || undefined;

  if (eventType === 'function_call') {
    const toolName = toStringValue(event.name);
    const args = parseArguments(event.arguments);
    const callId = toStringValue(event.call_id) || toStringValue(event.id) || undefined;
    if (toolName) {
      applyCodexToolCall(summary, toolName, args, callId, eventTimestamp);
    }
    return;
  }

  if (eventType !== 'response_item') return;

  const payload = toRecord(event.payload);
  if (!payload) return;
  const payloadType = toStringValue(payload.type);

  if (payloadType === 'function_call_output') {
    const callId = toStringValue(payload.call_id) || toStringValue(payload.id);
    if (!callId) return;
    const output = stringifyToolResultContent(payload.output);
    const isError = payload.success === false;
    attachToolResult(summary, callId, output, isError);
    return;
  }

  if (payloadType === 'custom_tool_call') {
    const toolName = toStringValue(payload.name);
    if (!toolName) return;
    const tsMs = parseTimestampMs(eventTimestamp);
    const callId = toStringValue(payload.call_id) || toStringValue(payload.id) || undefined;
    summary.toolCalls++;
    addToolCounters(summary, toolName);
    pushToolCall(summary, { name: toolName, input: payload.input, timestamp: eventTimestamp }, callId);

    if (lower(toolName) === 'apply_patch') {
      for (const change of parsePatchPaths(payload.input)) {
        if (change.kind === 'create') addFileCreate(summary, change.path, tsMs);
        else if (change.kind === 'delete') addFileDelete(summary, change.path, tsMs);
        else addFileWrite(summary, change.path, tsMs);
      }
    }
    return;
  }

  if (payloadType === 'message' && toStringValue(payload.role) === 'assistant') {
    const text = assistantTextFromContent(payload.content);
    if (text) summary.lastAssistantText = text;
    return;
  }

  if (payloadType !== 'function_call') return;
  const toolName = toStringValue(payload.name);
  const args = parseArguments(payload.arguments);
  if (!toolName) return;
  const callId = toStringValue(payload.call_id) || toStringValue(payload.id) || undefined;
  applyCodexToolCall(summary, toolName, args, callId, eventTimestamp);
}

function applyGeminiEvent(summary: MutableSessionQuickSummary, event: Record<string, unknown>): void {
  const eventType = toStringValue(event.type);
  const eventTimestamp = toStringValue(event.timestamp) || undefined;

  if (eventType === 'tool_response' || eventType === 'tool_result') {
    const callId = toStringValue(event.tool_call_id) || toStringValue(event.id);
    if (!callId) return;
    const output = stringifyToolResultContent(event.response ?? event.result ?? event.output);
    const isError = event.is_error === true || event.success === false;
    attachToolResult(summary, callId, output, isError);
    return;
  }

  if (eventType === 'message' || eventType === 'assistant') {
    const role = toStringValue(event.role) || 'assistant';
    if (role === 'assistant') {
      const text = assistantTextFromContent(event.content) || toStringValue(event.text).trim();
      if (text) summary.lastAssistantText = text;
    }
    return;
  }

  if (eventType !== 'tool_call' && eventType !== 'tool_use') return;

  const toolName = toStringValue(event.tool_name) || toStringValue(event.name);
  if (!toolName) return;

  const args = parseArguments(event.parameters ?? event.args);
  const name = lower(toolName);
  const filePath = pathFromArgs(args);
  const callId = toStringValue(event.tool_call_id) || toStringValue(event.id) || undefined;
  const tsMs = parseTimestampMs(eventTimestamp);

  summary.toolCalls++;
  addToolCounters(summary, toolName);
  pushToolCall(summary, { name: toolName, input: args, timestamp: eventTimestamp }, callId);

  if (
    name === 'replace' ||
    name === 'edit' ||
    name === 'patch' ||
    name === 'write_file' ||
    name === 'edit_file' ||
    name === 'update_file' ||
    name === 'modify_file'
  ) {
    addFileWrite(summary, filePath, tsMs);
    return;
  }

  if (name === 'create_file') {
    addFileCreate(summary, filePath, tsMs);
    return;
  }

  if (name === 'read_file' || name === 'view_file' || name === 'cat_file' || name === 'get_file') {
    addFileRead(summary, filePath, tsMs);
    return;
  }

  if (name === 'delete_file' || name === 'remove_file' || name === 'rm_file') {
    addFileDelete(summary, filePath, tsMs);
  }
}

function applyEvent(
  summary: MutableSessionQuickSummary,
  agentType: SessionSummaryAgentType,
  event: Record<string, unknown>
): void {
  if (agentType === 'claude') {
    applyClaudeEvent(summary, event);
    return;
  }
  if (agentType === 'codex') {
    applyCodexEvent(summary, event);
    return;
  }
  applyGeminiEvent(summary, event);
}

function toQuickSummary(summary: MutableSessionQuickSummary): SessionQuickSummary {
  return {
    filesEdited: summary.filesEdited.size,
    filesRead: summary.filesRead.size,
    filesCreated: summary.filesCreated.size,
    filesDeleted: summary.filesDeleted.size,
    toolCalls: summary.toolCalls,
    webSearches: Math.max(summary.webSearches, summary.maxWebSearchesFromUsage),
    webFetches: Math.max(summary.webFetches, summary.maxWebFetchesFromUsage),
    mcpCalls: summary.mcpCalls,
  };
}

export function extractSessionQuickDetails(
  sessionContent: string,
  agentType: SessionSummaryAgentType
): SessionQuickDetails {
  const summary = initMutableSummary();
  if (!sessionContent.trim()) {
    return {
      summary: toQuickSummary(summary),
      recentFiles: [],
      recentFileTimes: {},
      recentTools: [],
      recentToolCalls: [],
      lastFilePath: null,
      narrative: '',
    };
  }

  const lines = sessionContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const record = toRecord(parsed);
      if (!record) continue;
      applyEvent(summary, agentType, record);
    } catch {
      continue;
    }
  }

  const recentFilesSource = summary.recentChangedFiles.length > 0
    ? summary.recentChangedFiles
    : summary.recentTouchedFiles;
  const recentFiles = recentFilesSource.slice(0, 32);
  return {
    summary: toQuickSummary(summary),
    recentFiles,
    recentFileTimes: summary.recentFileTimes,
    recentTools: summary.recentTools.slice(0, 32),
    recentToolCalls: summary.recentToolCalls.slice(0, MAX_RECENT_TOOL_CALLS),
    lastFilePath: recentFilesSource[0] || null,
    narrative: truncateNarrative(summary.lastAssistantText),
  };
}

export function extractSessionQuickSummary(
  sessionContent: string,
  agentType: SessionSummaryAgentType
): SessionQuickSummary {
  return extractSessionQuickDetails(sessionContent, agentType).summary;
}
