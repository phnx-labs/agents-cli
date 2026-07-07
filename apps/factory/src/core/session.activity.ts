import { isSensitiveEnvKey } from './terminals';

/**
 * Session Activity Extraction
 *
 * Extracts the current/last activity from agent session files.
 * Parses JSONL session logs to determine what the agent is doing.
 */

export type ActivityType =
  | 'reading'     // file_read, Read, Glob, Grep
  | 'editing'     // file_write, Edit, Write
  | 'running'     // bash command
  | 'thinking'    // reasoning, no tool call
  | 'waiting'     // permission requested (not yet implemented)
  | 'completed';  // session ended

export interface CurrentActivity {
  type: ActivityType;
  summary: string;        // e.g., "src/auth.ts", "npm test"
  timestamp: Date;
}

type AgentType = 'claude' | 'codex' | 'gemini';

/**
 * Compute output-token throughput over a rolling window.
 *
 * Parses the agent's session log, sums output tokens (plus reasoning/thoughts
 * tokens when the format reports them separately) from entries whose timestamp
 * falls within the last `windowSec` seconds, and returns tokens-per-second.
 *
 * Formats:
 *   - Claude: JSONL. Each assistant turn is `{type: 'assistant', timestamp,
 *     message: {usage: {output_tokens}}}`.
 *   - Codex:  JSONL. Each token_count event is `{type: 'event_msg', timestamp,
 *     payload: {type: 'token_count', info: {last_token_usage: {output_tokens,
 *     reasoning_output_tokens}}}}`. `last_token_usage` is per-turn (not cumulative).
 *   - Gemini: Single JSON object. `{messages: [{type: 'gemini', timestamp,
 *     tokens: {output, thoughts}}]}`. Caller must pass the whole file.
 */
export function computeOutputTokensPerSec(
  sessionContent: string,
  agentType: AgentType,
  windowSec: number = 60,
  now: number = Date.now()
): number {
  const cutoff = now - windowSec * 1000;
  let total = 0;
  if (agentType === 'gemini') {
    try {
      const d = JSON.parse(sessionContent);
      const messages = Array.isArray(d?.messages) ? d.messages : [];
      for (const m of messages) {
        if (m?.type !== 'gemini') continue;
        const ts = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : 0;
        if (!ts || ts < cutoff) continue;
        const out = typeof m?.tokens?.output === 'number' ? m.tokens.output : 0;
        const thoughts = typeof m?.tokens?.thoughts === 'number' ? m.tokens.thoughts : 0;
        total += out + thoughts;
      }
    } catch { }
    return total / windowSec;
  }
  const lines = sessionContent.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    if (!line.includes('output_tokens')) continue;
    try {
      const d = JSON.parse(line);
      const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : 0;
      if (!ts) continue;
      if (ts < cutoff) break;
      if (agentType === 'claude') {
        if (d?.type !== 'assistant') continue;
        const out = typeof d?.message?.usage?.output_tokens === 'number' ? d.message.usage.output_tokens : 0;
        total += out;
      } else if (agentType === 'codex') {
        if (d?.type !== 'event_msg') continue;
        const payload = d?.payload;
        if (payload?.type !== 'token_count') continue;
        const last = payload?.info?.last_token_usage;
        if (!last) continue;
        const out = typeof last.output_tokens === 'number' ? last.output_tokens : 0;
        const reasoning = typeof last.reasoning_output_tokens === 'number' ? last.reasoning_output_tokens : 0;
        total += out + reasoning;
      }
    } catch { }
  }
  return total / windowSec;
}

/**
 * Extract current activity from session content (tail of file).
 * Processes lines from end to find most recent tool activity.
 */
export function extractCurrentActivity(
  sessionContent: string,
  agentType: AgentType
): CurrentActivity | null {
  const lines = sessionContent.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return null;

  // Process from end to find most recent activity
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const activity = parseLineForActivity(line, agentType);
    if (activity) return activity;
  }

  return null;
}

/**
 * Parse a single JSONL line and extract activity if present.
 */
export function parseLineForActivity(line: string, agentType: AgentType): CurrentActivity | null {
  try {
    const raw = JSON.parse(line);
    switch (agentType) {
      case 'claude':
        return parseClaudeActivity(raw);
      case 'codex':
        return parseCodexActivity(raw);
      case 'gemini':
        return parseGeminiActivity(raw);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// --- Claude parsing ---

function parseClaudeActivity(raw: any): CurrentActivity | null {
  const eventType = raw?.type;
  const timestamp = raw?.timestamp ? new Date(raw.timestamp) : new Date();

  if (eventType === 'assistant') {
    const message = raw.message || {};
    const contentBlocks = message.content || [];

    for (const block of contentBlocks) {
      if (block.type === 'tool_use') {
        const toolName = block.name || '';
        const toolInput = block.input || {};

        // Return activity based on tool
        if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
          const path = toolInput.file_path || toolInput.path || toolInput.pattern || '';
          return {
            type: 'reading',
            summary: truncatePath(path),
            timestamp,
          };
        } else if (toolName === 'Edit' || toolName === 'Write') {
          const path = toolInput.file_path || '';
          return {
            type: 'editing',
            summary: truncatePath(path),
            timestamp,
          };
        } else if (toolName === 'Bash') {
          const command = toolInput.command || '';
          return {
            type: 'running',
            summary: truncateCommand(command),
            timestamp,
          };
        } else if (toolName === 'Task') {
          return {
            type: 'running',
            summary: 'Spawning subagent...',
            timestamp,
          };
        }

        // Generic tool use - treat as thinking
        return {
          type: 'thinking',
          summary: `Using ${toolName}`,
          timestamp,
        };
      }
    }

    // Assistant message with text but no tool - thinking
    const hasText = contentBlocks.some((b: any) => b.type === 'text' && b.text?.trim());
    if (hasText) {
      return {
        type: 'thinking',
        summary: '',
        timestamp,
      };
    }
  }

  // Check for completed/result
  if (eventType === 'result') {
    return {
      type: 'completed',
      summary: raw.subtype || 'done',
      timestamp,
    };
  }

  return null;
}

// --- Codex parsing ---
// Real Codex format:
// - type: "response_item" with payload.type: "function_call", payload.name, payload.arguments (JSON string)
// - type: "event_msg" with payload.type: "agent_reasoning" for thinking
// - type: "response_item" with payload.type: "reasoning" for thinking summaries

function parseCodexActivity(raw: any): CurrentActivity | null {
  const eventType = raw?.type;
  const timestamp = raw?.timestamp ? new Date(raw.timestamp) : new Date();

  // Function calls (tool use)
  if (eventType === 'response_item') {
    const payload = raw?.payload || {};
    const payloadType = payload?.type;

    if (payloadType === 'function_call') {
      const toolName = payload?.name || '';
      let toolArgs: any = {};

      // Arguments is a JSON string in Codex
      if (typeof payload?.arguments === 'string') {
        try {
          toolArgs = JSON.parse(payload.arguments);
        } catch {
          toolArgs = {};
        }
      } else if (typeof payload?.arguments === 'object') {
        toolArgs = payload.arguments || {};
      }

      // Shell commands
      if (
        toolName === 'shell_command' ||
        toolName === 'shell' ||
        toolName === 'bash' ||
        toolName === 'exec_command'
      ) {
        const command = toolArgs?.command || toolArgs?.cmd || '';
        if (command.trim()) {
          return {
            type: 'running',
            summary: truncateCommand(command),
            timestamp,
          };
        }
      }

      if (toolName === 'multi_tool_use.parallel') {
        const toolUses = Array.isArray(toolArgs?.tool_uses) ? toolArgs.tool_uses : [];
        for (const use of toolUses) {
          const recipient = String(use?.recipient_name || '');
          const params = use?.parameters || {};
          if (recipient === 'functions.exec_command') {
            const command = typeof params?.cmd === 'string' ? params.cmd : '';
            if (command.trim()) {
              return {
                type: 'running',
                summary: truncateCommand(command),
                timestamp,
              };
            }
          }
        }
      }

      // File operations
      if (['create_file', 'write_file', 'edit_file', 'apply_diff'].includes(toolName)) {
        const path = toolArgs?.path || toolArgs?.file_path || toolArgs?.target_file || '';
        return {
          type: 'editing',
          summary: truncatePath(path),
          timestamp,
        };
      }

      if (['read_file', 'view_file'].includes(toolName)) {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        return {
          type: 'reading',
          summary: truncatePath(path),
          timestamp,
        };
      }

      // Generic function call
      return {
        type: 'thinking',
        summary: `Using ${toolName}`,
        timestamp,
      };
    }

    // Reasoning summaries
    if (payloadType === 'reasoning') {
      return {
        type: 'thinking',
        summary: '',
        timestamp,
      };
    }

    // Message from assistant
    if (payloadType === 'message' && payload?.role === 'assistant') {
      return {
        type: 'thinking',
        summary: '',
        timestamp,
      };
    }
  }

  // Agent reasoning events
  if (eventType === 'event_msg') {
    const payload = raw?.payload || {};
    const payloadType = payload?.type;

    if (payloadType === 'agent_reasoning') {
      return {
        type: 'thinking',
        summary: '',
        timestamp,
      };
    }

    if (payloadType === 'agent_message') {
      return {
        type: 'thinking',
        summary: '',
        timestamp,
      };
    }
  }

  // Turn completed
  if (eventType === 'turn.completed' || eventType === 'turn_completed') {
    return {
      type: 'completed',
      summary: 'done',
      timestamp,
    };
  }

  return null;
}

// --- Gemini parsing ---

function parseGeminiActivity(raw: any): CurrentActivity | null {
  const eventType = raw?.type;
  const timestamp = raw?.timestamp ? new Date(raw.timestamp) : new Date();

  if (eventType === 'tool_call' || eventType === 'tool_use') {
    const toolName = String(raw?.tool_name || raw?.name || '').toLowerCase();
    const toolArgs = raw?.parameters || raw?.args || {};

    const filePath = toolArgs?.file_path || toolArgs?.path || '';
    const command = toolArgs?.command || '';

    // File write tools
    const writeTools = ['replace', 'edit', 'patch', 'write_file', 'edit_file', 'update_file'];
    if (writeTools.includes(toolName) || toolName.includes('write')) {
      return {
        type: 'editing',
        summary: truncatePath(filePath),
        timestamp,
      };
    }

    // File read tools
    const readTools = ['read_file', 'view_file', 'cat_file', 'get_file'];
    if (readTools.includes(toolName) || toolName.includes('read')) {
      return {
        type: 'reading',
        summary: truncatePath(filePath),
        timestamp,
      };
    }

    // Shell tools
    if (['shell', 'bash', 'execute', 'run_command', 'run_shell_command'].includes(toolName)) {
      return {
        type: 'running',
        summary: truncateCommand(command),
        timestamp,
      };
    }

    return {
      type: 'thinking',
      summary: `Using ${toolName}`,
      timestamp,
    };
  }

  if (eventType === 'message') {
    const role = raw?.role || 'assistant';
    if (role === 'assistant') {
      return {
        type: 'thinking',
        summary: '',
        timestamp,
      };
    }
  }

  if (eventType === 'result') {
    return {
      type: 'completed',
      summary: raw?.status || 'done',
      timestamp,
    };
  }

  return null;
}

// --- Helpers ---

function truncatePath(path: string, maxLen: number = 40): string {
  if (!path) return '';
  // Extract filename from full path
  const parts = path.split('/');
  const filename = parts[parts.length - 1] || path;
  if (filename.length <= maxLen) return filename;
  return filename.slice(0, maxLen - 3) + '...';
}

/**
 * Scrub sensitive environment variables from a command string.
 * Replaces KEY=value with KEY=*** for sensitive keys.
 */
export function scrubSensitiveCommand(command: string): string {
  if (!command) return command;
  // Match environment variable assignments like KEY=value, KEY="value", or KEY='value'
  const envVarRegex = /\b([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|[^\s]+)/g;
  return command.replace(envVarRegex, (match, key, value) => {
    if (isSensitiveEnvKey(key)) {
      return `${key}=***`;
    }
    return match;
  });
}

function truncateCommand(command: string, maxLen: number = 50): string {
  if (!command) return '';
  const scrubbed = scrubSensitiveCommand(command);
  const trimmed = scrubbed.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 3) + '...';
}

/**
 * Detect whether the agent appears to be awaiting user input.
 * Walks the session JSONL from the end and looks at the last actionable turn:
 *   - Claude: last assistant message whose final text block ends with "?" and
 *     has no pending tool_use, OR used the AskUserQuestion tool.
 *   - Codex:  last response_item message (role=assistant) with text ending "?".
 * Returns false for agents mid-tool or when the user has already responded.
 */
export function detectWaitingForInput(
  sessionContent: string,
  agentType: AgentType
): boolean {
  if (agentType !== 'claude' && agentType !== 'codex') return false;
  const lines = sessionContent.split(/\r?\n/).filter(l => l.trim());
  const endsWithQuestion = (s: string) => /\?\s*$/.test(s.trim());

  for (let i = lines.length - 1; i >= 0; i--) {
    let raw: any;
    try { raw = JSON.parse(lines[i]); } catch { continue; }

    if (agentType === 'claude') {
      if (raw?.isMeta) continue;
      const t = raw?.type;
      if (t !== 'user' && t !== 'assistant') continue;

      if (t === 'user') {
        // A user event means either the human typed, or a tool_result came
        // back — either way the agent is past the last question.
        return false;
      }

      const content = raw?.message?.content;
      if (!Array.isArray(content)) return false;

      for (const b of content) {
        if (b?.type === 'tool_use' && b?.name === 'AskUserQuestion') return true;
      }
      const hasToolUse = content.some((b: any) => b?.type === 'tool_use');
      if (hasToolUse) return false;

      const textBlocks = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string');
      if (textBlocks.length === 0) return false;
      return endsWithQuestion(textBlocks[textBlocks.length - 1].text);
    }

    if (agentType === 'codex') {
      if (raw?.type !== 'response_item') continue;
      const payload = raw?.payload;
      if (!payload) continue;
      if (payload?.type === 'function_call') return false;
      if (payload?.type === 'message') {
        const role = payload?.role;
        if (role && role !== 'assistant') return false;
        const content = payload?.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          text = content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('');
        }
        return endsWithQuestion(text);
      }
    }
  }
  return false;
}

/**
 * Format activity for display in terminal card.
 * Returns a string like "> Reading src/auth.ts" or "> Running npm test"
 */
export function formatActivity(activity: CurrentActivity | null): string {
  if (!activity) return 'Thinking...';

  switch (activity.type) {
    case 'reading':
      return activity.summary ? `Reading ${activity.summary}` : 'Reading...';
    case 'editing':
      return activity.summary ? `Editing ${activity.summary}` : 'Editing...';
    case 'running':
      return activity.summary || 'Running...';
    case 'thinking':
      return activity.summary || 'Thinking...';
    case 'waiting':
      return 'Waiting for approval';
    case 'completed':
      return activity.summary === 'done' ? 'Completed' : `Completed (${activity.summary})`;
    default:
      return 'Thinking...';
  }
}
