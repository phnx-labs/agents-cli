/**
 * Agent event stream parsers.
 *
 * Normalizes the heterogeneous JSON event formats emitted by each agent CLI
 * (Claude, Codex, Gemini, Cursor, OpenCode, Grok) into a unified event schema
 * with consistent types: init, message, tool_use, bash, file_read, file_write,
 * file_create, file_delete, result, error, and others.
 */
import { extractFileOpsFromBash } from './file_ops.js';

/** Supported agent CLI types for team spawning. */
export type AgentType = 'codex' | 'gemini' | 'cursor' | 'claude' | 'opencode' | 'grok';

const claudeToolUseMap = new Map<string, { tool: string; command?: string; path?: string }>();

/** Normalize a raw JSON event from any agent type into an array of unified event objects. */
export function normalizeEvents(agentType: AgentType, raw: any): any[] {
  if (agentType === 'codex') {
    return normalizeCodex(raw);
  } else if (agentType === 'cursor') {
    return normalizeCursor(raw);
  } else if (agentType === 'gemini') {
    return normalizeGemini(raw);
  } else if (agentType === 'claude') {
    return normalizeClaude(raw);
  } else if (agentType === 'opencode') {
    return normalizeOpencode(raw);
  } else if (agentType === 'grok') {
    return normalizeGrok(raw);
  }

  const timestamp = new Date().toISOString();
  return [{
    type: raw.type || 'unknown',
    agent: agentType,
    raw: raw,
    timestamp: timestamp,
  }];
}

/** Normalize a raw JSON event, returning only the first unified event (convenience wrapper). */
export function normalizeEvent(agentType: AgentType, raw: any): any {
  const events = normalizeEvents(agentType, raw);
  if (events.length > 0) {
    return events[0];
  }

  return {
    type: raw.type || 'unknown',
    agent: agentType,
    raw: raw,
    timestamp: new Date().toISOString(),
  };
}

function normalizeCodex(raw: any): any[] {
  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'codex',
      raw: raw,
      timestamp: new Date().toISOString(),
    }];
  }

  const eventType = raw.type || 'unknown';
  const timestamp = new Date().toISOString();

  if (eventType === 'thread.started') {
    return [{
      type: 'init',
      agent: 'codex',
      session_id: raw.thread_id || null,
      timestamp: timestamp,
    }];
  } else if (eventType === 'turn.started') {
    return [{
      type: 'turn_start',
      agent: 'codex',
      timestamp: timestamp,
    }];
  } else if (eventType === 'item.completed') {
    const item = raw.item || {};
    const itemType = item?.type;

    if (itemType === 'agent_message') {
      return [{
        type: 'message',
        agent: 'codex',
        content: item?.text || '',
        complete: true,
        timestamp: timestamp,
      }];
    } else if (itemType === 'command_execution') {
      const command = item?.command || '';
      if (!command.trim()) {
        return [];
      }
      const events: any[] = [{
        type: 'bash',
        agent: 'codex',
        tool: 'command_execution',
        command: command,
        timestamp: timestamp,
      }];

      const [filesRead, filesWritten, filesDeleted] = extractFileOpsFromBash(command);
      for (const path of filesRead) {
        events.push({
          type: 'file_read',
          agent: 'codex',
          tool: 'bash',
          path,
          command,
          timestamp,
        });
      }
      for (const path of filesWritten) {
        events.push({
          type: 'file_write',
          agent: 'codex',
          tool: 'bash',
          path,
          command,
          timestamp,
        });
      }
      for (const path of filesDeleted) {
        events.push({
          type: 'file_delete',
          agent: 'codex',
          tool: 'bash',
          path,
          command,
          timestamp,
        });
      }

      return events;
    } else if (itemType === 'file_change') {
      const changes = Array.isArray(item?.changes) ? item.changes : [];
      const changeEvents: any[] = [];

      for (const change of changes) {
        const path = change?.path || change?.file_path || '';
        if (!path) {
          continue;
        }

        const kind = String(change?.kind || change?.status || '').toLowerCase();
        const baseEvent = {
          agent: 'codex',
          tool: 'file_change',
          path,
          timestamp,
        };

        if (['add', 'create', 'new'].includes(kind)) {
          changeEvents.push({ ...baseEvent, type: 'file_create' });
        } else if (['delete', 'remove'].includes(kind)) {
          changeEvents.push({ ...baseEvent, type: 'file_delete' });
        } else {
          changeEvents.push({ ...baseEvent, type: 'file_write' });
        }
      }

      if (changeEvents.length > 0) {
        return changeEvents;
      }
    } else if (itemType === 'tool_call') {
      const toolName = item?.name || 'unknown';
      const toolArgs = item?.arguments || {};

      if (toolName === 'create_file') {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        if (!path) {
          return [];
        }
        return [{
          type: 'file_create',
          agent: 'codex',
          tool: toolName,
          path: path,
          timestamp: timestamp,
        }];
      } else if (toolName === 'write_file' || toolName === 'edit_file') {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        if (!path) {
          return [];
        }
        return [{
          type: 'file_write',
          agent: 'codex',
          tool: toolName,
          path: path,
          timestamp: timestamp,
        }];
      } else if (toolName === 'read_file') {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        if (!path) {
          return [];
        }
        return [{
          type: 'file_read',
          agent: 'codex',
          tool: toolName,
          path: path,
          timestamp: timestamp,
        }];
      } else if (toolName === 'delete_file' || toolName === 'remove_file') {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        if (!path) {
          return [];
        }
        return [{
          type: 'file_delete',
          agent: 'codex',
          tool: toolName,
          path: path,
          timestamp: timestamp,
        }];
      } else if (toolName === 'shell' || toolName === 'bash' || toolName === 'execute') {
        const command = toolArgs?.command || '';
        if (!command.trim()) {
          return [];
        }
        return [{
          type: 'bash',
          agent: 'codex',
          tool: toolName,
          command: command,
          timestamp: timestamp,
        }];
      } else {
        return [{
          type: 'tool_use',
          agent: 'codex',
          tool: toolName,
          args: toolArgs,
          timestamp: timestamp,
        }];
      }
    }
  } else if (eventType === 'turn.completed') {
    const usage = raw.usage || {};
    return [{
      type: 'result',
      agent: 'codex',
      status: 'success',
      usage: {
        input_tokens: usage?.input_tokens || 0,
        output_tokens: usage?.output_tokens || 0,
      },
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'codex',
    raw: raw,
    timestamp: timestamp,
  }];
}

function normalizeCursor(raw: any): any[] {
  const eventType = raw.type || 'unknown';
  const subtype = raw.subtype;
  const timestamp = new Date().toISOString();

  if (eventType === 'system' && subtype === 'init') {
    return [{
      type: 'init',
      agent: 'cursor',
      model: raw.model,
      session_id: raw.session_id,
      timestamp: timestamp,
    }];
  } else if (eventType === 'thinking') {
    if (subtype === 'delta') {
      const text = raw.text || '';
      if (!text.trim()) {
        return [];
      }
    }
    return [{
      type: 'thinking',
      agent: 'cursor',
      content: raw.text || '',
      complete: subtype === 'completed',
      timestamp: timestamp,
    }];
  } else if (eventType === 'assistant') {
    const message = raw.message || {};
    const contentBlocks = message.content || [];
    const events: any[] = [];
    let textContent = '';

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool_use',
          agent: 'cursor',
          tool: block.name || 'unknown',
          args: block.input || {},
          timestamp: timestamp,
        });
      }
    }

    if (textContent) {
      events.push({
        type: 'message',
        agent: 'cursor',
        content: textContent,
        complete: true,
        timestamp: timestamp,
      });
    }

    if (events.length === 0) {
      events.push({
        type: 'message',
        agent: 'cursor',
        content: '',
        complete: true,
        timestamp: timestamp,
      });
    }

    return events;
  } else if (eventType === 'result') {
    return [{
      type: 'result',
      agent: 'cursor',
      status: subtype || 'success',
      duration_ms: raw.duration_ms,
      timestamp: timestamp,
    }];
  } else if (eventType === 'tool_result') {
    return [{
      type: 'tool_result',
      agent: 'cursor',
      tool: raw.tool_name || 'unknown',
      success: raw.success !== false,
      timestamp: timestamp,
    }];
  } else if (eventType === 'tool_call' && subtype === 'completed') {
    const toolCall = raw.tool_call;

    if (toolCall?.shellToolCall) {
      const command = toolCall.shellToolCall.args?.command || '';
      return [{
        type: 'bash',
        agent: 'cursor',
        tool: 'shell',
        command: command,
        timestamp: timestamp,
      }];
    } else if (toolCall?.editToolCall) {
      const filePath = toolCall.editToolCall.args?.path || '';
      return [{
        type: 'file_write',
        agent: 'cursor',
        tool: 'edit',
        path: filePath,
        timestamp: timestamp,
      }];
    } else if (toolCall?.readToolCall) {
      const filePath = toolCall.readToolCall.args?.path || '';
      return [{
        type: 'file_read',
        agent: 'cursor',
        tool: 'read',
        path: filePath,
        timestamp: timestamp,
      }];
    } else if (toolCall?.deleteToolCall) {
      const filePath = toolCall.deleteToolCall.args?.path || '';
      return [{
        type: 'file_delete',
        agent: 'cursor',
        tool: 'delete',
        path: filePath,
        timestamp: timestamp,
      }];
    } else if (toolCall?.listToolCall) {
      const dirPath = toolCall.listToolCall.args?.path || '';
      return [{
        type: 'directory_list',
        agent: 'cursor',
        tool: 'list',
        path: dirPath,
        timestamp: timestamp,
      }];
    }

    return [{
      type: 'tool_use',
      agent: 'cursor',
      tool: Object.keys(toolCall || {})[0] || 'unknown',
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'cursor',
    raw: raw,
    timestamp: timestamp,
  }];
}

function normalizeGemini(raw: any): any[] {
  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'gemini',
      raw: raw,
      timestamp: new Date().toISOString(),
    }];
  }

  const eventType = raw?.type || 'unknown';
  const timestamp = raw?.timestamp || new Date().toISOString();

  if (eventType === 'init') {
    return [{
      type: 'init',
      agent: 'gemini',
      model: raw?.model,
      session_id: raw?.session_id,
      timestamp: timestamp,
    }];
  } else if (eventType === 'message') {
    const role = raw?.role || 'assistant';
    if (role === 'assistant') {
      return [{
        type: 'message',
        agent: 'gemini',
        content: raw?.content || '',
        complete: !raw?.delta,
        timestamp: timestamp,
      }];
    } else {
      return [{
        type: 'user_message',
        agent: 'gemini',
        content: raw?.content || '',
        timestamp: timestamp,
      }];
    }
  } else if (eventType === 'tool_call' || eventType === 'tool_use') {
    const toolNameRaw = raw?.tool_name || raw?.name || 'unknown';
    const toolName = String(toolNameRaw);

    let toolArgsRaw = raw?.parameters;
    if (toolArgsRaw === null || toolArgsRaw === undefined) {
      toolArgsRaw = raw?.args;
    }
    const toolArgs = (typeof toolArgsRaw === 'object' && toolArgsRaw !== null) ? toolArgsRaw : {};
    const toolNameLower = toolName.toLowerCase();

    const filePath = toolArgs?.file_path || toolArgs?.path || '';
    const command = toolArgs?.command || '';

    // File write/edit tools - Gemini uses 'replace', 'edit', 'patch', 'write_file', etc.
    const writeTools = ['replace', 'edit', 'patch', 'write_file', 'edit_file', 'update_file', 'modify_file'];
    if (writeTools.includes(toolNameLower) || (toolNameLower.includes('write') && toolNameLower.includes('file'))) {
      if (!filePath.trim()) {
        return [];
      }
      return [{
        type: 'file_write',
        agent: 'gemini',
        tool: toolName,
        path: filePath,
        timestamp: timestamp,
      }];
    }

    // File read tools
    const readTools = ['read_file', 'view_file', 'cat_file', 'get_file'];
    if (readTools.includes(toolNameLower) || (toolNameLower.includes('read') && toolNameLower.includes('file'))) {
      if (!filePath.trim()) {
        return [];
      }
      return [{
        type: 'file_read',
        agent: 'gemini',
        tool: toolName,
        path: filePath,
        timestamp: timestamp,
      }];
    }

    // File delete tools
    const deleteTools = ['delete_file', 'remove_file', 'rm_file'];
    if (deleteTools.includes(toolNameLower) || (toolNameLower.includes('delete') && toolNameLower.includes('file'))) {
      if (!filePath.trim()) {
        return [];
      }
      return [{
        type: 'file_delete',
        agent: 'gemini',
        tool: toolName,
        path: filePath,
        timestamp: timestamp,
      }];
    }

    // Shell/bash tools
    if (['shell', 'bash', 'execute', 'run_command', 'run_shell_command'].includes(toolNameLower)) {
      if (!command.trim()) {
        return [];
      }
      return [{
        type: 'bash',
        agent: 'gemini',
        tool: toolName,
        command: command,
        timestamp: timestamp,
      }];
    }

    return [{
      type: 'tool_use',
      agent: 'gemini',
      tool: toolName,
      args: toolArgs,
      timestamp: timestamp,
    }];
  } else if (eventType === 'result') {
    const stats = raw?.stats || {};
    return [{
      type: 'result',
      agent: 'gemini',
      status: raw?.status || 'success',
      duration_ms: stats?.duration_ms,
      usage: {
        total_tokens: stats?.total_tokens || 0,
      },
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'gemini',
    raw: raw,
    timestamp: timestamp,
  }];
}

function normalizeClaude(raw: any): any[] {
  const eventType = raw.type || 'unknown';
  const subtype = raw.subtype;
  const timestamp = new Date().toISOString();

  if (eventType === 'system' && subtype === 'init') {
    return [{
      type: 'init',
      agent: 'claude',
      model: raw.model,
      session_id: raw.session_id,
      timestamp: timestamp,
    }];
  } else if (eventType === 'assistant') {
    const message = raw.message || {};
    const contentBlocks = message.content || [];
    const events: any[] = [];
    let textContent = '';

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'unknown';
        const toolId = block.id;
        const toolInput = block.input || {};
        
        if (toolId) {
          if (toolName === 'Bash' && toolInput.command) {
            claudeToolUseMap.set(toolId, { tool: toolName, command: toolInput.command });
          } else if ((toolName === 'Edit' || toolName === 'Write') && toolInput.file_path) {
            claudeToolUseMap.set(toolId, { tool: toolName, path: toolInput.file_path });
          } else if (toolName === 'Read' && toolInput.file_path) {
            claudeToolUseMap.set(toolId, { tool: toolName, path: toolInput.file_path });
          }
        }
        
        events.push({
          type: 'tool_use',
          agent: 'claude',
          tool: toolName,
          args: toolInput,
          timestamp: timestamp,
        });
      }
    }

    if (textContent) {
      events.push({
        type: 'message',
        agent: 'claude',
        content: textContent,
        complete: true,
        timestamp: timestamp,
      });
    }

    if (events.length === 0) {
      events.push({
        type: 'message',
        agent: 'claude',
        content: '',
        complete: true,
        timestamp: timestamp,
      });
    }

    return events;
  } else if (eventType === 'user') {
    const message = raw.message || {};
    const contentBlocks = message.content || [];
    const toolUseResult = raw.tool_use_result;
    const events: any[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'tool_result') {
        const toolUseId = block.tool_use_id;

        if (toolUseResult?.file) {
          events.push({
            type: 'file_read',
            agent: 'claude',
            path: toolUseResult.file.filePath,
            timestamp: timestamp,
          });
        } else if (toolUseResult?.stdout !== undefined) {
          const toolUseInfo = claudeToolUseMap.get(toolUseId);
          const command = toolUseInfo?.command || '';
          events.push({
            type: 'bash',
            agent: 'claude',
            command: command,
            timestamp: timestamp,
          });
          claudeToolUseMap.delete(toolUseId);
        } else if (!block.is_error && typeof toolUseResult !== 'string') {
          const toolUseInfo = claudeToolUseMap.get(toolUseId);
          if (toolUseInfo && (toolUseInfo.tool === 'Edit' || toolUseInfo.tool === 'Write') && toolUseInfo.path) {
            events.push({
              type: 'file_write',
              agent: 'claude',
              path: toolUseInfo.path,
              timestamp: timestamp,
            });
            claudeToolUseMap.delete(toolUseId);
          } else {
            events.push({
              type: 'tool_result',
              agent: 'claude',
              tool_use_id: toolUseId,
              success: true,
              timestamp: timestamp,
            });
            if (toolUseInfo) {
              claudeToolUseMap.delete(toolUseId);
            }
          }
        } else if (block.is_error || (typeof toolUseResult === 'string' && toolUseResult.startsWith('Error:'))) {
          events.push({
            type: 'error',
            agent: 'claude',
            message: block.content || (typeof toolUseResult === 'string' ? toolUseResult : ''),
            timestamp: timestamp,
          });
        } else {
          const toolUseInfo = claudeToolUseMap.get(toolUseId);
          events.push({
            type: 'tool_result',
            agent: 'claude',
            tool_use_id: toolUseId,
            success: !block.is_error,
            timestamp: timestamp,
          });
          if (toolUseInfo) {
            claudeToolUseMap.delete(toolUseId);
          }
        }
      }
    }

    return events.length > 0 ? events : [{
      type: eventType,
      agent: 'claude',
      raw: raw,
      timestamp: timestamp,
    }];
  } else if (eventType === 'result') {
    return [{
      type: 'result',
      agent: 'claude',
      status: subtype || 'success',
      duration_ms: raw.duration_ms,
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'claude',
    raw: raw,
    timestamp: timestamp,
  }];
}

// --- OpenCode parsing ---
// OpenCode outputs JSON events with step_start, tool_use, text, step_finish types

function normalizeOpencode(raw: any): any[] {
  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'opencode',
      raw: raw,
      timestamp: new Date().toISOString(),
    }];
  }

  const eventType = raw?.type || 'unknown';
  const timestamp = raw?.timestamp ? new Date(raw.timestamp).toISOString() : new Date().toISOString();
  const part = raw?.part || {};

  if (eventType === 'step_start' || eventType === 'step-start') {
    return [{
      type: 'init',
      agent: 'opencode',
      session_id: part?.sessionID || null,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'tool_use') {
    const toolName = part?.tool || 'unknown';
    const state = part?.state || {};
    const input = state?.input || {};
    const status = state?.status || 'unknown';

    const events: any[] = [];

    if (toolName === 'bash' && input?.command) {
      events.push({
        type: 'bash',
        agent: 'opencode',
        tool: toolName,
        command: input.command,
        timestamp: timestamp,
      });

      const [filesRead, filesWritten, filesDeleted] = extractFileOpsFromBash(input.command);
      for (const path of filesRead) {
        events.push({ type: 'file_read', agent: 'opencode', tool: 'bash', path, command: input.command, timestamp });
      }
      for (const path of filesWritten) {
        events.push({ type: 'file_write', agent: 'opencode', tool: 'bash', path, command: input.command, timestamp });
      }
      for (const path of filesDeleted) {
        events.push({ type: 'file_delete', agent: 'opencode', tool: 'bash', path, command: input.command, timestamp });
      }

      return events;
    }

    const filePath = input?.path || input?.file_path || '';

    if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'create_file') {
      if (filePath.trim()) {
        return [{
          type: 'file_write',
          agent: 'opencode',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      }
    }

    if (toolName === 'read_file' || toolName === 'view_file') {
      if (filePath.trim()) {
        return [{
          type: 'file_read',
          agent: 'opencode',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      }
    }

    if (toolName === 'delete_file' || toolName === 'remove_file') {
      if (filePath.trim()) {
        return [{
          type: 'file_delete',
          agent: 'opencode',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      }
    }

    return [{
      type: 'tool_use',
      agent: 'opencode',
      tool: toolName,
      args: input,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'text') {
    const text = part?.text || '';
    return [{
      type: 'message',
      agent: 'opencode',
      content: text,
      complete: true,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'step_finish' || eventType === 'step-finish') {
    const reason = part?.reason || 'unknown';
    const status = reason === 'stop' ? 'success' : (reason === 'error' ? 'error' : 'success');
    return [{
      type: 'result',
      agent: 'opencode',
      status: status,
      cost: part?.cost || 0,
      tokens: part?.tokens || {},
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'opencode',
    raw: raw,
    timestamp: timestamp,
  }];
}

// --- Grok parsing ---
// Grok's streaming-json mode emits one JSON object per token, with three event
// types:
//   {"type":"thought","data":"<chunk>"}   — reasoning tokens (many, small)
//   {"type":"text","data":"<chunk>"}      — visible response tokens (many, small)
//   {"type":"end","stopReason":"EndTurn","sessionId":"<uuid>","requestId":"<uuid>"}
//
// Tool calls are NOT exposed as separate events in this format; they appear
// inside the `thought` text as XML-like markup. Extracting them reliably would
// require running a streaming XML/markup parser over concatenated thought
// chunks, which is out of scope for v1. The teams summary will show grok
// teammates' bash/file ops as empty — known limitation, fixable later by
// switching to grok's `agent` subcommand (richer event stream) once stable.
//
// Tokens are emitted as `message` events with `complete: false` so the
// summarizer can concatenate them into a final message; `thinking` events are
// already collapsed by the summarizer's groupAndFlattenEvents pathway.
function normalizeGrok(raw: any): any[] {
  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'grok',
      raw: raw,
      timestamp: new Date().toISOString(),
    }];
  }

  const eventType = raw.type || 'unknown';
  const timestamp = new Date().toISOString();

  if (eventType === 'thought') {
    const data = typeof raw.data === 'string' ? raw.data : '';
    if (!data) return [];
    return [{
      type: 'thinking',
      agent: 'grok',
      content: data,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'text') {
    const data = typeof raw.data === 'string' ? raw.data : '';
    if (!data) return [];
    return [{
      type: 'message',
      agent: 'grok',
      content: data,
      complete: false,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'end') {
    const stopReason = typeof raw.stopReason === 'string' ? raw.stopReason : '';
    const status = stopReason === 'EndTurn' || stopReason === 'StopSequence' || stopReason === ''
      ? 'success'
      : 'error';
    return [{
      type: 'result',
      agent: 'grok',
      status: status,
      stop_reason: stopReason || null,
      session_id: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'grok',
    raw: raw,
    timestamp: timestamp,
  }];
}

/** Parse a single JSONL line into normalized events. Returns null if the line is not valid JSON. */
export function parseEvent(agentType: AgentType, line: string): any[] | null {
  try {
    const raw = JSON.parse(line);
    return normalizeEvents(agentType, raw);
  } catch {
    return null;
  }
}
