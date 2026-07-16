/**
 * Session file parsers for Claude, Codex, Gemini, and OpenCode.
 *
 * Each agent stores sessions in a different format (JSONL, JSON, SQLite).
 * This module normalizes all of them into a flat array of SessionEvent
 * objects suitable for rendering, filtering, and summarization.
 */

import * as fs from 'fs';
import { truncate } from '../format.js';
import * as path from 'path';
import Database from '../sqlite.js';
import type { SessionAgentId, SessionEvent } from './types.js';

/**
 * Largest session file we will load into memory. Above this we throw a clean
 * error instead of OOMing or hitting V8's ERR_STRING_TOO_LONG. Aligns with
 * Node's ~512MB string ceiling with a healthy margin.
 */
export const SESSION_FILE_MAX_BYTES = 200_000_000;

/**
 * Strip terminal control sequences that a malicious session file could use to
 * hijack the user's terminal (clipboard via OSC 52, scrollback wipe, alt-screen
 * takeover, cursor moves, etc.). Allowed through: tab (0x09), newline (0x0a),
 * carriage return (0x0d). Everything else in the C0/C1 range and every CSI/OSC
 * escape is dropped.
 */
const TERMINAL_ESCAPE_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function sanitizeForTerminal(s: string): string {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(TERMINAL_ESCAPE_REGEX, '');
}

/** Recursively sanitize every string value within a tool-args object. */
function sanitizeArgsDeep(value: any): any {
  if (typeof value === 'string') return sanitizeForTerminal(value);
  if (Array.isArray(value)) return value.map(sanitizeArgsDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = sanitizeArgsDeep(value[k]);
    return out;
  }
  return value;
}

/** In-place sanitize every user-visible string field on a list of events. */
export function sanitizeEvents(events: SessionEvent[]): void {
  for (const e of events) sanitizeEvent(e);
}

/** In-place sanitize all user-visible string fields on an event. */
function sanitizeEvent(e: SessionEvent): void {
  if (e.content) e.content = sanitizeForTerminal(e.content);
  if (e.command) e.command = sanitizeForTerminal(e.command);
  if (e.path) e.path = sanitizeForTerminal(e.path);
  if (e.name) e.name = sanitizeForTerminal(e.name);
  if (e.output) e.output = sanitizeForTerminal(e.output);
  if (e.tool) e.tool = sanitizeForTerminal(e.tool);
  if (e.model) e.model = sanitizeForTerminal(e.model);
  if (e.mediaType) e.mediaType = sanitizeForTerminal(e.mediaType);
  if (e.args) e.args = sanitizeArgsDeep(e.args);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function attachmentPath(block: any, source: any): string | undefined {
  return firstString(
    source?.path,
    source?.file_path,
    source?.filePath,
    source?.url,
    source?.ref,
    block?.path,
    block?.file_path,
    block?.filePath,
    block?.ref,
  );
}

function attachmentName(block: any, source: any, filePath: string | undefined): string | undefined {
  return firstString(
    block?.name,
    block?.title,
    source?.name,
    source?.filename,
    source?.file_name,
    source?.fileName,
    filePath ? path.basename(filePath) : undefined,
  );
}

function normalizedAttachmentEvent(
  agent: SessionAgentId,
  timestamp: string,
  block: any,
  source: any,
  defaultMediaType: string,
  sizeBytes: number,
): SessionEvent {
  const filePath = attachmentPath(block, source);
  const name = attachmentName(block, source, filePath);
  const explicitSize =
    typeof source?.sizeBytes === 'number' ? source.sizeBytes :
    typeof source?.size === 'number' ? source.size :
    typeof block?.sizeBytes === 'number' ? block.sizeBytes :
    undefined;
  return {
    type: 'attachment',
    agent,
    timestamp,
    path: filePath,
    name,
    mediaType: firstString(source?.media_type, source?.mediaType, block?.media_type, block?.mediaType) || defaultMediaType,
    sizeBytes: sizeBytes || explicitSize || 0,
  };
}

/**
 * Read a session file, refusing files above maxBytes. Bounded read protects
 * against multi-GB session blobs that would OOM the CLI or exceed V8's
 * ERR_STRING_TOO_LONG ceiling.
 */
export function safeReadSessionFile(filePath: string, maxBytes: number = SESSION_FILE_MAX_BYTES): string {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(
      `Session file too large: ${filePath} is ${stat.size} bytes (limit ${maxBytes}). Refusing to load.`,
    );
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Auto-detect agent type from file path and parse the session.
 */
export function parseSession(filePath: string, agent?: SessionAgentId): SessionEvent[] {
  const detected = agent || detectAgent(filePath);
  if (!detected) {
    throw new Error(`Cannot detect agent type from path: ${filePath}`);
  }

  let events: SessionEvent[];
  switch (detected) {
    case 'claude': events = parseClaude(filePath); break;
    case 'codex': events = parseCodex(filePath); break;
    case 'gemini': events = parseGemini(filePath); break;
    case 'antigravity': events = parseAntigravity(filePath); break;
    case 'opencode': events = parseOpenCode(filePath); break;
    case 'grok': events = parseGrok(filePath); break;
    case 'rush': events = parseRush(filePath); break;
    case 'openclaw': events = []; break; // OpenClaw sessions don't have parseable files yet
    case 'hermes': events = parseHermes(filePath); break;
    case 'kimi': events = parseKimi(filePath); break;
    case 'droid': events = parseDroid(filePath); break;
  }

  // Chokepoint: every string field that originated in an untrusted session
  // file gets stripped of terminal escapes here, so renderers downstream can
  // safely splat values into chalk/console output.
  for (const e of events) sanitizeEvent(e);
  return events;
}

/** Infer the agent type from a session file path using known directory conventions. */
export function detectAgent(filePath: string): SessionAgentId | null {
  if (filePath.includes('/.claude/') || filePath.includes('\\.claude\\')) return 'claude';
  if (filePath.includes('/.codex/') || filePath.includes('\\.codex\\')) return 'codex';
  // Antigravity lives under ~/.gemini/antigravity-cli/conversations/<uuid>.db, so
  // it must be matched BEFORE the generic /.gemini/ check below or it would be
  // misdetected as Gemini.
  if ((filePath.includes('/antigravity-cli/conversations/') || filePath.includes('\\antigravity-cli\\conversations\\'))
      && filePath.endsWith('.db')) return 'antigravity';
  if (filePath.includes('/.gemini/') || filePath.includes('\\.gemini\\')) return 'gemini';
  if (filePath.includes('/.grok/') || filePath.includes('\\.grok\\')) return 'grok';
  if (filePath.includes('/.rush/') || filePath.includes('\\.rush\\')) return 'rush';
  if (filePath.includes('/.hermes/') || filePath.includes('\\.hermes\\')) return 'hermes';
  if (filePath.includes('/.kimi-code/') || filePath.includes('\\.kimi-code\\')) return 'kimi';
  if (filePath.includes('/.factory/') || filePath.includes('\\.factory\\')) return 'droid';
  // Cloud convention: cloud-sessions/<id>/session.<format>.jsonl
  const cloudMatch = filePath.match(/session\.(claude|codex|rush)\.jsonl(?:$|[?#])/);
  if (cloudMatch) return cloudMatch[1] as SessionAgentId;
  if (filePath.includes('opencode.db')) return 'opencode';

  // Try file extension + content heuristic
  if (filePath.endsWith('.json')) return 'gemini';
  return null;
}

/**
 * Summarize a tool_use into a one-liner string.
 */
export function summarizeToolUse(tool: string, args?: Record<string, any>): string {
  if (!args) return tool;

  switch (tool) {
    case 'Bash':
      return `Bash: ${truncate(String(args.command || '').replace(/\n/g, ' ').trim(), 120)}`;
    case 'Read':
      return `Read ${shortenPath(args.file_path || '')}`;
    case 'Write':
      return `Write ${shortenPath(args.file_path || '')}`;
    case 'Edit':
      return `Edit ${shortenPath(args.file_path || '')}`;
    case 'Glob':
      return `Glob ${args.pattern || ''}`;
    case 'Grep':
      return `Grep ${args.pattern || ''} ${args.path || ''}`.trim();
    case 'Agent':
      return `Agent: ${truncate(args.description || args.prompt || '', 80)}`;
    case 'WebSearch':
    case 'WebFetch':
      return `${tool}: ${truncate(args.query || args.url || '', 80)}`;
    // Codex plan tool: arrives as a function_call with {plan:[{step,status}]}.
    case 'update_plan': {
      const steps = Array.isArray(args.plan) ? args.plan.length : 0;
      return `Plan: ${steps} step${steps === 1 ? '' : 's'}`;
    }
    // Claude's live checklist: show progress + the current step, not a bare "TodoWrite".
    case 'TodoWrite': {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      if (todos.length === 0) return 'Plan: 0 steps';
      const done = todos.filter((t: any) => t?.status === 'completed').length;
      const active = todos.find((t: any) => t?.status === 'in_progress');
      const step = active?.activeForm || active?.content;
      return step
        ? `Plan ${done}/${todos.length}: ${truncate(String(step), 80)}`
        : `Plan: ${done}/${todos.length} done`;
    }
    // Codex tools
    case 'exec_command':
      return `Bash: ${truncate(String(args.command || args.cmd || '').replace(/\n/g, ' ').trim(), 120)}`;
    case 'read_file':
      return `Read ${shortenPath(args.file_path || args.path || '')}`;
    case 'write_file':
    case 'create_file':
      return `Write ${shortenPath(args.file_path || args.path || '')}`;
    case 'edit_file':
      return `Edit ${shortenPath(args.file_path || args.path || '')}`;
    // Gemini tools
    case 'run_shell_command':
      return `Bash: ${truncate(String(args.command || '').replace(/\n/g, ' ').trim(), 120)}`;
    case 'search_file_content':
      return `Search ${args.pattern || ''}`;
    default: {
      // Generic: show first meaningful arg
      for (const key of ['file_path', 'path', 'pattern', 'command', 'prompt', 'query', 'url']) {
        if (args[key]) return `${tool}: ${truncate(String(args[key]), 80)}`;
      }
      return tool;
    }
  }
}


/** Replace the home directory prefix with ~ for display. */
function shortenPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

// ---------------------------------------------------------------------------
// Claude parser
// ---------------------------------------------------------------------------

/** Parse a Claude JSONL session file into normalized events. */
export function parseClaude(filePath: string): SessionEvent[] {
  return parseClaudeContent(safeReadSessionFile(filePath));
}

/**
 * Parse Claude JSONL *content* (already read into a string) into normalized
 * events. Split from `parseClaude` so the tail reader can parse just the last
 * chunk of a file without re-reading the whole thing. Malformed leading lines
 * (a tail that starts mid-line) are skipped by the per-line try/catch below.
 */
export function parseClaudeContent(content: string): SessionEvent[] {
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Map tool_use id -> {tool, args} for correlating with tool_result
  const toolUseMap = new Map<string, { tool: string; args: Record<string, any> }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      /* malformed JSONL line, skip */
      continue;
    }

    const type = raw.type;
    const timestamp = raw.timestamp || new Date().toISOString();

    if (type === 'assistant') {
      const contentBlocks = raw.message?.content || [];
      for (const block of contentBlocks) {
        if (block.type === 'thinking') {
          // Thinking content -- may be encrypted (has .signature field)
          const thinkingText = block.thinking || '';
          if (thinkingText) {
            events.push({
              type: 'thinking',
              agent: 'claude',
              timestamp,
              content: thinkingText,
            });
          }
        } else if (block.type === 'text') {
          const text = (block.text || '').trim();
          if (text) {
            events.push({
              type: 'message',
              agent: 'claude',
              timestamp,
              role: 'assistant',
              content: text,
            });
          }
        } else if (block.type === 'tool_use') {
          const toolName = block.name || 'unknown';
          const toolInput = block.input || {};
          const toolId = block.id;
          const isLocal = toolInput.is_local === true;

          if (toolId) {
            toolUseMap.set(toolId, { tool: toolName, args: toolInput });
          }

          const event: any = {
            type: 'tool_use',
            agent: 'claude' as const,
            timestamp,
            tool: toolName,
            args: toolInput,
            path: toolInput.file_path || undefined,
            command: toolName === 'Bash' ? toolInput.command : undefined,
          };
          if (isLocal) event._local = true;
          events.push(event);
        }
      }
      // Capture token usage and model from assistant turn
      if (raw.message?.usage) {
        const u = raw.message.usage;
        events.push({
          type: 'usage',
          agent: 'claude',
          timestamp,
          model: raw.message.model,
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens,
          cacheCreationTokens: u.cache_creation_input_tokens,
        });
      }
    } else if (type === 'user') {
      const contentBlocks = raw.message?.content;

      if (typeof contentBlocks === 'string') {
        // Simple user text
        const text = contentBlocks.trim();
        if (text) {
          events.push({
            type: 'message',
            agent: 'claude',
            timestamp,
            role: 'user',
            content: text,
          });
        }
      } else if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text && !text.startsWith('[Request interrupted')) {
              events.push({
                type: 'message',
                agent: 'claude',
                timestamp,
                role: 'user',
                content: text,
              });
            }
          } else if (block.type === 'image') {
            const source = block.source || {};
            if (source.type === 'base64') {
              const sizeBytes = Math.ceil(((source.data as string)?.length || 0) * 0.75);
              events.push(normalizedAttachmentEvent('claude', timestamp, block, source, 'image/png', sizeBytes));
            } else {
              events.push(normalizedAttachmentEvent('claude', timestamp, block, source, 'image/png', 0));
            }
          } else if (block.type === 'document') {
            const source = block.source || {};
            events.push(normalizedAttachmentEvent('claude', timestamp, block, source, 'application/pdf', 0));
          } else if (block.type === 'tool_result') {
            const toolId = block.tool_use_id;
            const toolInfo = toolId ? toolUseMap.get(toolId) : undefined;
            const isError = block.is_error === true;

            // Extract output text from tool result
            let output = '';
            if (typeof block.content === 'string') {
              output = block.content;
            } else if (Array.isArray(block.content)) {
              output = block.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text || '')
                .join('\n');
            }

            if (isError) {
              events.push({
                type: 'error',
                agent: 'claude',
                timestamp,
                tool: toolInfo?.tool,
                content: output || 'Tool execution failed',
              });
            } else {
              events.push({
                type: 'tool_result',
                agent: 'claude',
                timestamp,
                tool: toolInfo?.tool,
                success: true,
                output: output.length > 500 ? output.slice(0, 497) + '...' : output,
              });
            }

            if (toolId) toolUseMap.delete(toolId);
          }
        }
      }
    } else if (type === 'result') {
      events.push({
        type: 'result',
        agent: 'claude',
        timestamp,
        content: raw.subtype || 'success',
      });
    }
    // Skip: permission-mode, attachment, and other line types
  }

  return events;
}

// ---------------------------------------------------------------------------
// Codex parser
// ---------------------------------------------------------------------------

/** Parse a Codex JSONL session file into normalized events. */
export function parseCodex(filePath: string): SessionEvent[] {
  return parseCodexContent(safeReadSessionFile(filePath));
}

/**
 * Extract target file path(s) from a Codex apply_patch envelope. The patch body
 * opens with `*** Begin Patch` and carries one or more file ops of the form
 * `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>`.
 * Returns every path in order (a multi-file patch emits multiple paths so
 * artifact discovery sees each file — RUSH-1410). Empty when unparseable.
 */
export function applyPatchTargetPaths(input: string): string[] {
  const paths: string[] = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  for (const m of input.matchAll(re)) {
    const p = m[1].trim();
    if (p) paths.push(p);
  }
  return paths;
}

/** @deprecated Prefer applyPatchTargetPaths — kept for single-file call sites. */
function applyPatchTargetPath(input: string): string | undefined {
  return applyPatchTargetPaths(input)[0];
}

/**
 * Parse Codex JSONL *content* (already read into a string) into normalized
 * events. Split from `parseCodex` so the tail reader can parse just the last
 * chunk without re-reading the whole file.
 */
export function parseCodexContent(content: string): SessionEvent[] {
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Track function_call id -> name for correlating with function_call_output
  const callMap = new Map<string, { name: string; args: any }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      /* malformed JSONL line, skip */
      continue;
    }

    const lineType = raw.type;
    const timestamp = raw.timestamp || new Date().toISOString();
    const payload = raw.payload || {};

    if (lineType === 'session_meta') {
      events.push({
        type: 'init',
        agent: 'codex',
        timestamp,
        content: `Codex ${payload.cli_version || ''} session in ${payload.cwd || ''}`.trim(),
      });
      continue;
    }

    if (lineType === 'event_msg') {
      // Web search is reported out-of-band as event_msg (not response_item).
      // The paired begin (`web_search_call`) has no query; only `web_search_end`
      // carries the resolved query string, so we emit exactly one tool_use per
      // search off the end event and ignore the begin to avoid duplicates.
      if (payload.type === 'web_search_end') {
        const query = typeof payload.query === 'string' ? payload.query : '';
        events.push({
          type: 'tool_use',
          agent: 'codex',
          timestamp,
          tool: 'WebSearch',
          args: { query },
        });
      }
      continue;
    }

    if (lineType === 'response_item') {
      const ptype = payload.type;

      if (ptype === 'message') {
        const contentBlocks = payload.content || [];
        const role = payload.role === 'user' || payload.role === 'developer' ? 'user' : 'assistant';

        for (const block of contentBlocks) {
          if (block.type === 'output_text') {
            const text = (block.text || '').trim();
            if (text) {
              events.push({
                type: 'message',
                agent: 'codex',
                timestamp,
                role: 'assistant',
                content: text,
              });
            }
          } else if (block.type === 'input_text') {
            // Developer/user input messages -- only include actual prompts, not system instructions
            const text = (block.text || '').trim();
            if (text && text.length < 2000 && !text.includes('<permissions instructions>')) {
              events.push({
                type: 'message',
                agent: 'codex',
                timestamp,
                role: 'user',
                content: text,
              });
            }
          }
        }
      } else if (ptype === 'function_call') {
        const name = payload.name || 'unknown';
        let args: any = {};
        try {
          args = typeof payload.arguments === 'string'
            ? JSON.parse(payload.arguments)
            : (payload.arguments || {});
        } catch {
          /* arguments not valid JSON, preserve raw */
          args = { raw: payload.arguments };
        }

        const callId = payload.call_id || payload.id;
        if (callId) {
          callMap.set(callId, { name, args });
        }

        events.push({
          type: 'tool_use',
          agent: 'codex',
          timestamp,
          tool: name,
          args,
          command: name === 'exec_command' ? (args.command || args.cmd) : undefined,
          path: args.file_path || args.path || undefined,
        });
      } else if (ptype === 'function_call_output') {
        const callId = payload.call_id || payload.id;
        const callInfo = callId ? callMap.get(callId) : undefined;
        const output = String(payload.output || '');

        events.push({
          type: 'tool_result',
          agent: 'codex',
          timestamp,
          tool: callInfo?.name,
          success: true,
          output: output.length > 500 ? output.slice(0, 497) + '...' : output,
        });

        if (callId) callMap.delete(callId);
      } else if (ptype === 'custom_tool_call') {
        // Codex edits arrive as custom_tool_call (apply_patch), NOT function_call.
        const rawName = payload.name || 'unknown';
        const input = typeof payload.input === 'string' ? payload.input : '';
        const isApplyPatch = rawName === 'apply_patch';
        // Multi-file patches: one tool_use per file so artifact discovery sees
        // every path (RUSH-1410). Single-file / non-patch keep one event.
        const patchPaths = isApplyPatch ? applyPatchTargetPaths(input) : [];
        const tool = isApplyPatch ? 'Edit' : rawName;
        const truncatedInput = input.length > 500 ? input.slice(0, 497) + '...' : input;

        const emitOne = (patchPath: string | undefined) => {
          const args: any = { input: truncatedInput };
          if (patchPath) args.file_path = patchPath;
          const callId = payload.call_id || payload.id;
          if (callId) callMap.set(callId, { name: tool, args });
          events.push({
            type: 'tool_use',
            agent: 'codex',
            timestamp,
            tool,
            args,
            path: patchPath,
          });
        };

        if (isApplyPatch && patchPaths.length > 0) {
          for (const p of patchPaths) emitOne(p);
        } else {
          emitOne(undefined);
        }
      } else if (ptype === 'custom_tool_call_output') {
        const callId = payload.call_id || payload.id;
        const callInfo = callId ? callMap.get(callId) : undefined;
        const output = String(payload.output || '');

        events.push({
          type: 'tool_result',
          agent: 'codex',
          timestamp,
          tool: callInfo?.name,
          success: true,
          output: output.length > 500 ? output.slice(0, 497) + '...' : output,
        });

        if (callId) callMap.delete(callId);
      } else if (ptype === 'reasoning') {
        // Codex reasoning -- try to get the readable summary
        const summaries = payload.summary || [];
        const text = summaries.length > 0
          ? summaries.map((s: any) => s.text || '').join('\n')
          : (payload.text || '');
        if (text.trim()) {
          events.push({
            type: 'thinking',
            agent: 'codex',
            timestamp,
            content: text.trim(),
          });
        }
      }
    }
    // Skip: event_msg (token_count, etc.), turn_context
  }

  return events;
}

// ---------------------------------------------------------------------------
// Gemini parser
// ---------------------------------------------------------------------------

/** Parse a Gemini JSON session file into normalized events. */
export function parseGemini(filePath: string): SessionEvent[] {
  const content = safeReadSessionFile(filePath);
  let session: any;
  try {
    session = JSON.parse(content);
  } catch {
    /* Gemini session file is not valid JSON */
    throw new Error(`Failed to parse Gemini session: ${filePath}`);
  }

  const messages = session.messages || [];
  const events: SessionEvent[] = [];

  events.push({
    type: 'init',
    agent: 'gemini',
    timestamp: session.startTime || new Date().toISOString(),
    content: `Gemini session ${session.sessionId || ''}`.trim(),
  });

  for (const msg of messages) {
    const timestamp = msg.timestamp || session.startTime || new Date().toISOString();

    if (msg.type === 'user') {
      const text = extractGeminiContent(msg.content);
      if (text) {
        events.push({
          type: 'message',
          agent: 'gemini',
          timestamp,
          role: 'user',
          content: text,
        });
      }
    } else if (msg.type === 'gemini') {
      // Reasoning thoughts
      if (Array.isArray(msg.thoughts)) {
        for (const thought of msg.thoughts) {
          const text = thought.description || thought.subject || '';
          if (text.trim()) {
            const subject = thought.subject ? `**${thought.subject}**: ` : '';
            events.push({
              type: 'thinking',
              agent: 'gemini',
              timestamp: thought.timestamp || timestamp,
              content: `${subject}${thought.description || ''}`.trim(),
            });
          }
        }
      }

      // Assistant text
      const text = extractGeminiContent(msg.content);
      if (text) {
        events.push({
          type: 'message',
          agent: 'gemini',
          timestamp,
          role: 'assistant',
          content: text,
        });
      }

      // Tool calls (Gemini inlines call + result on the same message)
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const toolName = tc.name || 'unknown';
          const args = tc.args || {};

          events.push({
            type: 'tool_use',
            agent: 'gemini',
            timestamp: tc.timestamp || timestamp,
            tool: toolName,
            args,
            command: ['run_shell_command', 'shell', 'bash'].includes(toolName) ? args.command : undefined,
            path: args.file_path || args.path || undefined,
          });

          // Inline result
          if (tc.result || tc.status) {
            let output = '';
            if (Array.isArray(tc.result)) {
              for (const r of tc.result) {
                const resp = r?.functionResponse?.response;
                if (resp?.output) {
                  output += String(resp.output);
                }
              }
            } else if (typeof tc.result === 'string') {
              output = tc.result;
            }

            events.push({
              type: 'tool_result',
              agent: 'gemini',
              timestamp: tc.timestamp || timestamp,
              tool: toolName,
              success: tc.status === 'success',
              output: output.length > 500 ? output.slice(0, 497) + '...' : output,
            });
          }
        }
      }
    }
  }

  return events;
}

/**
 * Extract text content from Gemini's content field,
 * which can be a string or an array of {text: string} parts.
 */
function extractGeminiContent(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Antigravity parser
//
// Antigravity (Google's Gemini-CLI successor) stores each conversation as a
// SQLite DB at ~/.gemini/antigravity-cli/conversations/<trajectory-uuid>.db.
// Table `steps(idx, step_type, ..., step_payload BLOB, ...)`; step_payload is
// protobuf with no .proto shipped. The wire layout, reverse-engineered and
// uniform across every tool step, nests a tool-call sub-message with:
//   f1  (string) = call id       (shared by the request + completion steps)
//   f2  (string) = tool name     e.g. run_command / view_file / grep_search
//   f3  (string) = JSON args     e.g. {"CommandLine":"date","Cwd":"…","toolAction":…}
//   f30 (string) = toolSummary   short human label ("Run date")
//   f31 (string) = toolAction    ("Running date command")
// We never decode the step_type enum: extracting the tool name (f2) + JSON args
// (f3) generically keeps the parser tool-agnostic, so a future tool (web search,
// etc.) is captured automatically. Each tool surfaces TWICE — a request step
// (step_type 15) and a completion step share the same f1 call id — so we dedupe
// by that id. Reads the BLOB payloads via the node/bun SQLite wrapper (portable,
// no `sqlite3` CLI dependency) and normalizes to SessionEvent[].
// ---------------------------------------------------------------------------

/** One decoded protobuf field at a single nesting level. */
type ProtoField = { field: number; wire: number; value: number | Uint8Array };

/** Read a base-128 varint from `b` at offset `i`; returns [value, nextOffset]. */
function readVarint(b: Uint8Array, i: number): [number, number] {
  let shift = 0;
  let val = 0;
  for (;;) {
    const byte = b[i++];
    val += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [val, i];
}

/** Decode a protobuf message into a flat list of fields (one nesting level). */
function decodeProtoMessage(b: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < b.length) {
    let tag: number;
    [tag, i] = readVarint(b, i);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, i] = readVarint(b, i);
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len: number;
      [len, i] = readVarint(b, i);
      out.push({ field, wire, value: b.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      i += 4; // fixed32 — skipped
      out.push({ field, wire, value: 0 });
    } else if (wire === 1) {
      i += 8; // fixed64 — skipped
      out.push({ field, wire, value: 0 });
    } else {
      break; // unknown wire type — stop to avoid runaway reads
    }
  }
  return out;
}

const ANTIGRAVITY_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/** A tool-call node recovered from a step payload. */
interface AntigravityToolCall {
  id?: string;
  name: string;
  args: Record<string, any>;
  summary?: string;
  action?: string;
}

/**
 * Recursively locate the tool-call node: the first sub-message that carries an
 * f2 string tool-name AND an f3 JSON-args string. Also captures the f1 call id
 * (used to dedupe the request + completion steps) and the f30/f31 human labels.
 */
function findAntigravityToolCall(fields: ProtoField[]): AntigravityToolCall | null {
  let id: string | undefined;
  let name: string | undefined;
  let argsJson: string | undefined;
  let summary: string | undefined;
  let action: string | undefined;
  const subs: ProtoField[][] = [];

  for (const f of fields) {
    if (f.wire !== 2) continue;
    const bytes = f.value as Uint8Array;
    const s = ANTIGRAVITY_TEXT_DECODER.decode(bytes);
    if (f.field === 1 && !id && /^[a-z0-9]{4,16}$/.test(s)) id = s;
    else if (f.field === 2 && !name && /^[a-z][a-z_]{2,30}$/.test(s)) name = s;
    else if (f.field === 3 && !argsJson && s.startsWith('{') && s.includes('"toolAction"')) argsJson = s;
    else if (f.field === 30 && !summary) summary = s;
    else if (f.field === 31 && !action) action = s;
    else {
      try {
        subs.push(decodeProtoMessage(bytes));
      } catch {
        /* not a nested message */
      }
    }
  }

  if (name && argsJson) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = { _raw: argsJson };
    }
    return { id, name, args, summary, action };
  }
  for (const sub of subs) {
    const hit = findAntigravityToolCall(sub);
    if (hit) return hit;
  }
  return null;
}

/**
 * Map an Antigravity tool name onto the shared normalized vocabulary that the
 * renderer already handles (so no render.ts changes are needed). Unknown tools
 * pass through untouched (with their JSON args) so future tools are captured.
 */
const ANTIGRAVITY_TOOL_MAP: Record<string, string> = {
  run_command: 'Bash',
  view_file: 'Read',
  read_file: 'Read',
  list_dir: 'LS',
  grep_search: 'Grep',
  replace_file_content: 'Edit',
  write_to_file: 'Write',
  // Web tools surface identically once observed:
  search_web: 'WebSearch',
  read_url: 'WebFetch',
  execute_url: 'WebFetch',
};

/**
 * Parse an Antigravity conversation SQLite DB into normalized tool_use events.
 * Deduped by the tool-call id so each tool appears once (Antigravity writes a
 * request step and a completion step that share the id).
 */
export function parseAntigravity(dbPath: string): SessionEvent[] {
  // Read the raw BLOB payloads through the node/bun SQLite wrapper (not the
  // `sqlite3` CLI) so this works on every OS — the CLI is absent on Windows.
  let rows: Array<{ step_payload: unknown }>;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    rows = db
      .prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx;')
      .all() as Array<{ step_payload: unknown }>;
  } catch {
    /* DB not accessible, sqlite module unavailable, or query failed */
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }

  // Single timestamp for the whole session: the steps table carries no per-step
  // time column, so fall back to the DB file's mtime for a stable, sortable value.
  let timestamp = new Date().toISOString();
  try {
    timestamp = fs.statSync(dbPath).mtime.toISOString();
  } catch {
    /* file vanished between query and stat — keep now() */
  }

  const events: SessionEvent[] = [];
  const seenCallIds = new Set<string>();

  for (const row of rows) {
    const payload = row.step_payload;
    // Both node:sqlite and bun:sqlite return a BLOB as a Uint8Array (Buffer is
    // a subclass). NULL / non-blob payloads are skipped.
    if (!(payload instanceof Uint8Array)) continue;
    const bytes = payload;
    let fields: ProtoField[];
    try {
      fields = decodeProtoMessage(bytes);
    } catch {
      continue;
    }
    const call = findAntigravityToolCall(fields);
    if (!call) continue;

    // Dedupe: the request + completion steps of one tool share the f1 call id.
    if (call.id) {
      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);
    }

    const norm = ANTIGRAVITY_TOOL_MAP[call.name] || call.name;
    const a = call.args || {};
    events.push({
      type: 'tool_use',
      agent: 'antigravity',
      timestamp,
      tool: norm,
      args: a,
      command: norm === 'Bash' ? a.CommandLine : undefined,
      // Antigravity uses PascalCase arg keys; probe the known path-bearing ones.
      path: a.AbsolutePath || a.TargetFile || a.DirectoryPath || a.SearchPath || undefined,
      // Antigravity's own short human label — free, high quality. It surfaces
      // either as the f30 string or (more reliably) as `toolSummary` inside the
      // f3 JSON args.
      content: call.summary || (typeof a.toolSummary === 'string' ? a.toolSummary : undefined) || undefined,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// OpenCode parser
// ---------------------------------------------------------------------------

/**
 * Parse an OpenCode session from its SQLite database.
 * filePath format: "/path/to/opencode.db#session_id"
 *
 * Data model: session -> message -> part
 * Messages have role (user/assistant) and metadata.
 * Parts contain the actual content: text, tool, reasoning, patch, step-start/finish.
 */
export function parseGrok(filePath: string): SessionEvent[] {
  // Grok sessions are rich (summary.json + events.jsonl + chat_history.jsonl + updates.jsonl)
  // This is a minimal stub for now so grok appears in `agents sessions`.
  // Full parser (with subagents, tool calls, etc.) can be expanded later.
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // If it's a summary.json, create a basic event
    if (filePath.endsWith('summary.json')) {
      const summary = JSON.parse(content);
      return [{
        timestamp: summary.created_at || new Date().toISOString(),
        type: 'session_start',
        content: summary.session_summary || 'Grok session',
        agent: 'grok',
        metadata: { sessionId: summary.id, cwd: summary.cwd },
      } as any];
    }
    // For JSONL files (events, chat_history, updates), return basic parsed lines
    if (filePath.endsWith('.jsonl')) {
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.slice(0, 50).map((line, i) => {
        try {
          const obj = JSON.parse(line);
          return {
            timestamp: obj.timestamp || obj.ts || new Date().toISOString(),
            type: obj.type || obj.method || 'grok_event',
            content: typeof obj.content === 'string' ? obj.content : JSON.stringify(obj).slice(0, 200),
            agent: 'grok',
          } as any;
        } catch {
          return { timestamp: new Date().toISOString(), type: 'raw', content: line.slice(0, 200), agent: 'grok' } as any;
        }
      });
    }
  } catch {}
  return [];
}

export function parseOpenCode(filePath: string): SessionEvent[] {
  const [dbPath, sessionId] = filePath.split('#');
  if (!dbPath || !sessionId) return [];

  const events: SessionEvent[] = [];

  // Read through the node/bun SQLite wrapper (not the `sqlite3` CLI) so this
  // works on every OS — the CLI is absent on Windows.
  let rows: Array<{ role: unknown; part_type: unknown; part_data: unknown; time_created: unknown }>;
  let db: Database.Database | undefined;
  try {
    // Query messages with their parts, ordered chronologically. Tool parts are
    // truncated to keep large tool outputs from bloating memory; the session id
    // is bound as a parameter rather than interpolated.
    const query = `
      SELECT
        json_extract(m.data, '$.role') AS role,
        json_extract(p.data, '$.type') AS part_type,
        CASE
          WHEN json_extract(p.data, '$.type') = 'tool'
          THEN substr(p.data, 1, 2000)
          ELSE p.data
        END AS part_data,
        m.time_created AS time_created
      FROM message m
      JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
      WHERE m.session_id = ?
      ORDER BY m.time_created ASC, p.time_created ASC;
    `.replace(/\n/g, ' ');

    db = new Database(dbPath);
    rows = db.prepare(query).all(sessionId) as Array<{
      role: unknown;
      part_type: unknown;
      part_data: unknown;
      time_created: unknown;
    }>;
  } catch {
    /* DB not accessible, sqlite module unavailable, or query failed */
    return events;
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }

  try {
    for (const row of rows) {
      const role = typeof row.role === 'string' ? row.role : '';
      const partType = typeof row.part_type === 'string' ? row.part_type : '';
      const partDataStr = typeof row.part_data === 'string' ? row.part_data : '';

      const timeMs = typeof row.time_created === 'number' ? row.time_created : parseInt(String(row.time_created), 10);
      const timestamp = isNaN(timeMs) ? new Date().toISOString() : new Date(timeMs).toISOString();

      let partData: any;
      try {
        partData = JSON.parse(partDataStr);
      } catch {
        /* malformed part data, skip */
        continue;
      }

      switch (partType) {
        case 'text': {
          const text = (partData.text || '').trim();
          if (text) {
            events.push({
              type: 'message',
              agent: 'opencode',
              timestamp,
              role: role === 'user' ? 'user' : 'assistant',
              content: text,
            });
          }
          break;
        }
        case 'reasoning': {
          const text = (partData.text || '').trim();
          if (text) {
            events.push({
              type: 'thinking',
              agent: 'opencode',
              timestamp,
              content: text,
            });
          }
          break;
        }
        case 'tool': {
          const toolName = partData.tool || 'unknown';
          const state = partData.state || {};
          const input = state.input || {};
          const output = state.output || '';

          events.push({
            type: 'tool_use',
            agent: 'opencode',
            timestamp,
            tool: toolName,
            args: input,
            command: toolName === 'shell' ? input.command : undefined,
            path: input.filePath || input.path || undefined,
          });

          if (state.status === 'completed' || state.status === 'error') {
            const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
            events.push({
              type: state.status === 'error' ? 'error' : 'tool_result',
              agent: 'opencode',
              timestamp,
              tool: toolName,
              success: state.status === 'completed',
              output: outputStr.length > 500 ? outputStr.slice(0, 497) + '...' : outputStr,
            });
          }
          break;
        }
        // Skip step-start, step-finish, patch, file — not needed for transcript/trace
      }
    }
  } catch {
    /* malformed row payload — return what we parsed so far */
  }

  return events;
}

// ---------------------------------------------------------------------------
// Rush parser
//
// Rush messages.jsonl format is flat: one JSON object per line with
//   { id, session_id, role, type, content, created_at, tool_call_id?, name? }
// type ∈ {message, tool_call, tool_result}
// content varies by type:
//   message     -> { text: string }
//   tool_call   -> { input: {...} }
//   tool_result -> { input, output } (output.success === false marks an error)
// ---------------------------------------------------------------------------

/** Parse a Rush JSONL session file into normalized events. */
export function parseRush(filePath: string): SessionEvent[] {
  const content = safeReadSessionFile(filePath);
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Map tool_call id -> {tool, args} for correlating with tool_result.
  const toolCallMap = new Map<string, { tool: string; args: Record<string, any> }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      /* malformed JSONL line, skip */
      continue;
    }

    const type = raw.type;
    const timestamp = raw.created_at || new Date().toISOString();
    const content = raw.content || {};

    if (type === 'message') {
      const text = typeof content.text === 'string' ? content.text.trim() : '';
      if (!text) continue;

      const role: 'user' | 'assistant' = raw.role === 'user' ? 'user' : 'assistant';
      // Rush wraps the first user turn in <user_input>...</user_input> — strip.
      const cleaned = text
        .replace(/^<user_input>/, '')
        .replace(/<\/user_input>$/, '')
        .trim();

      // Skip sentinel execution-start marker that isn't human-readable.
      if (raw.role === 'system' && cleaned === 'execution_start') continue;

      events.push({
        type: 'message',
        agent: 'rush',
        timestamp,
        role,
        content: cleaned,
      });
    } else if (type === 'tool_call') {
      const toolName = raw.name || 'unknown';
      const args = content.input || {};
      const callId = raw.tool_call_id;
      if (callId) toolCallMap.set(callId, { tool: toolName, args });

      events.push({
        type: 'tool_use',
        agent: 'rush',
        timestamp,
        tool: toolName,
        args,
        path: args.file_path || args.path || undefined,
        command: (toolName === 'Bash' || toolName === 'shell') ? args.command : undefined,
      });
    } else if (type === 'tool_result') {
      const callId = raw.tool_call_id;
      const info = callId ? toolCallMap.get(callId) : undefined;
      const output = content.output;

      let outputStr = '';
      if (typeof output === 'string') {
        outputStr = output;
      } else if (output !== undefined) {
        try {
          outputStr = JSON.stringify(output);
        } catch {
          outputStr = String(output);
        }
      }

      const success = output?.success !== false;
      events.push({
        type: success ? 'tool_result' : 'error',
        agent: 'rush',
        timestamp,
        tool: info?.tool ?? raw.name,
        success,
        output: outputStr.length > 500 ? outputStr.slice(0, 497) + '...' : outputStr,
      });

      if (callId) toolCallMap.delete(callId);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Hermes parser
//
// Hermes stores one JSON file per session at ~/.hermes/sessions/session_<id>.json:
//   { session_id, model, platform, session_start, last_updated,
//     system_prompt, message_count, messages: [{role, content}, ...] }
// Content may be a string or an array of text parts.
// ---------------------------------------------------------------------------

/** Parse a Hermes session JSON file into normalized events. */
export function parseHermes(filePath: string): SessionEvent[] {
  let session: any;
  try {
    session = JSON.parse(safeReadSessionFile(filePath));
  } catch {
    return [];
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const timestamp = typeof session.session_start === 'string'
    ? session.session_start
    : new Date().toISOString();

  const events: SessionEvent[] = [];
  for (const msg of messages) {
    const role = msg?.role === 'user' ? 'user' : 'assistant';
    const text = hermesContentToText(msg?.content);
    if (!text) continue;
    events.push({
      type: 'message',
      agent: 'hermes',
      timestamp,
      role,
      content: text,
    });
  }

  return events;
}

function hermesContentToText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    })
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Kimi parser
//
// Kimi stores session metadata in state.json and the conversation transcript
// in agents/main/wire.jsonl under ~/.kimi-code/sessions/<workdir>/session_<uuid>/.
// wire.jsonl uses a role-based schema:
//   - "context.append_message" with role=user/assistant -> messages
//   - "context.append_loop_event" with content.part type=text/think -> message/thinking
//   - "context.append_loop_event" with event.type=tool.call -> tool_use
//   - "context.append_loop_event" with event.type=tool.result -> tool_result
//   - "usage.record" -> usage
// ---------------------------------------------------------------------------

/** Parse a Kimi session state.json file by reading its agents/main/wire.jsonl. */
export function parseKimi(filePath: string): SessionEvent[] {
  const sessionDir = path.dirname(filePath);
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  if (!fs.existsSync(wirePath)) {
    return [];
  }

  const content = safeReadSessionFile(wirePath);
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Map tool.call uuid -> tool name so tool.result can carry the tool name.
  const toolCallMap = new Map<string, string>();

  function extractMessageText(rawContent: any): string {
    if (typeof rawContent === 'string') return rawContent.trim();
    if (Array.isArray(rawContent)) {
      return rawContent
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
    }
    return '';
  }

  function timestampFrom(raw: any): string {
    const t = raw?.time;
    if (typeof t === 'number' && t > 0) {
      return new Date(t).toISOString();
    }
    return new Date().toISOString();
  }

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const type = raw?.type;
    const timestamp = timestampFrom(raw);

    if (type === 'context.append_message') {
      const message = raw.message || {};
      const role = message.role === 'user' ? 'user' : 'assistant';
      const text = extractMessageText(message.content);
      if (!text) continue;

      events.push({
        type: 'message',
        agent: 'kimi',
        timestamp,
        role,
        content: text,
      });
    } else if (type === 'context.append_loop_event') {
      const event = raw.event || {};
      const eventType = event.type;

      if (eventType === 'content.part') {
        const part = event.part || {};
        const partType = part.type;

        if (partType === 'text') {
          const text = typeof part.text === 'string' ? part.text.trim() : '';
          if (text) {
            events.push({
              type: 'message',
              agent: 'kimi',
              timestamp,
              role: 'assistant',
              content: text,
            });
          }
        } else if (partType === 'think') {
          const think = typeof part.think === 'string' ? part.think.trim() : '';
          if (think) {
            events.push({
              type: 'thinking',
              agent: 'kimi',
              timestamp,
              content: think,
            });
          }
        }
      } else if (eventType === 'tool.call') {
        const fn = event.function || {};
        const toolName = typeof event.name === 'string' ? event.name : (fn.name || 'unknown');
        let args: Record<string, any> = {};
        if (event.args && typeof event.args === 'object') {
          args = event.args;
        } else if (typeof fn.arguments === 'string') {
          try {
            args = JSON.parse(fn.arguments);
          } catch {
            args = { _raw: fn.arguments };
          }
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          args = fn.arguments;
        }

        const callId = event.toolCallId || event.uuid;
        if (callId) {
          toolCallMap.set(callId, toolName);
        }

        events.push({
          type: 'tool_use',
          agent: 'kimi',
          timestamp,
          tool: toolName,
          args,
          path: args.path || args.file_path || undefined,
          command: toolName === 'Bash' ? args.command : undefined,
        });
      } else if (eventType === 'tool.result') {
        const callId = event.toolCallId || event.parentUuid;
        const toolName = (callId && toolCallMap.get(callId)) || 'unknown';
        const result = event.result || {};
        const output = typeof result.output === 'string' ? result.output : '';
        const isError = result.isError === true || (output && output.startsWith('Error:'));

        events.push({
          type: isError ? 'error' : 'tool_result',
          agent: 'kimi',
          timestamp,
          tool: toolName,
          success: !isError,
          output: output.length > 500 ? output.slice(0, 497) + '...' : output,
        });

        if (callId) {
          toolCallMap.delete(callId);
        }
      }
    } else if (type === 'usage.record') {
      const usage = raw.usage || {};
      const inputTokens = usage.inputOther ?? usage.input_tokens;
      const outputTokens = usage.output ?? usage.output_tokens;
      if (
        (typeof inputTokens === 'number' && inputTokens >= 0) ||
        (typeof outputTokens === 'number' && outputTokens >= 0)
      ) {
        events.push({
          type: 'usage',
          agent: 'kimi',
          timestamp,
          model: raw.model || usage.model,
          inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
          outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
        });
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Droid (Factory) parser
// ---------------------------------------------------------------------------

/**
 * Parse a Droid (Factory) JSONL session file into normalized events. Droid
 * wraps each turn in a `{type:'message', message:{role, content, modelId}}`
 * envelope; the content blocks are Anthropic-shaped (text/thinking/tool_use/
 * tool_result), so block handling mirrors the Claude parser.
 */
export function parseDroid(filePath: string): SessionEvent[] {
  const content = safeReadSessionFile(filePath);
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Map tool_use id -> {tool, args} for correlating with tool_result.
  const toolUseMap = new Map<string, { tool: string; args: Record<string, any> }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    if (raw.type !== 'message') continue;

    const message = raw.message || {};
    const role = message.role === 'user' ? 'user' : 'assistant';
    const timestamp = raw.timestamp || new Date().toISOString();
    const blocks = message.content;

    // Plain-string content (rare) renders as a single message.
    if (typeof blocks === 'string') {
      const text = blocks.trim();
      if (text) events.push({ type: 'message', agent: 'droid', timestamp, role, content: text });
      continue;
    }
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block.type === 'text') {
        const text = (block.text || '').trim();
        // Skip injected context blocks (date, skills list) on the first user turn.
        if (text && !(role === 'user' && text.startsWith('<system-reminder>'))) {
          events.push({ type: 'message', agent: 'droid', timestamp, role, content: text });
        }
      } else if (block.type === 'thinking') {
        const thinkingText = (block.thinking || '').trim();
        if (thinkingText) events.push({ type: 'thinking', agent: 'droid', timestamp, content: thinkingText });
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'unknown';
        const toolInput = block.input || {};
        if (block.id) toolUseMap.set(block.id, { tool: toolName, args: toolInput });
        events.push({
          type: 'tool_use',
          agent: 'droid',
          timestamp,
          tool: toolName,
          args: toolInput,
          path: toolInput.file_path || toolInput.path || undefined,
          command: (toolName === 'Bash' || toolName === 'Execute') ? toolInput.command : undefined,
        });
      } else if (block.type === 'tool_result') {
        const toolId = block.tool_use_id;
        const toolInfo = toolId ? toolUseMap.get(toolId) : undefined;
        const isError = block.is_error === true;

        let output = '';
        if (typeof block.content === 'string') {
          output = block.content;
        } else if (Array.isArray(block.content)) {
          output = block.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text || '')
            .join('\n');
        }

        if (isError) {
          events.push({ type: 'error', agent: 'droid', timestamp, tool: toolInfo?.tool, content: output || 'Tool execution failed' });
        } else {
          events.push({
            type: 'tool_result',
            agent: 'droid',
            timestamp,
            tool: toolInfo?.tool,
            success: true,
            output: output.length > 500 ? output.slice(0, 497) + '...' : output,
          });
        }
        if (toolId) toolUseMap.delete(toolId);
      } else if (block.type === 'image') {
        const source = block.source || {};
        const sizeBytes = source.type === 'base64' ? Math.ceil(((source.data as string)?.length || 0) * 0.75) : 0;
        events.push(normalizedAttachmentEvent('droid', timestamp, block, source, 'image/png', sizeBytes));
      }
    }
  }

  return events;
}
