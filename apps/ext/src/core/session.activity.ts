import { isSensitiveEnvKey } from './terminals';

/**
 * Session Activity Extraction
 *
 * Per-line JSONL parsing for the agent panel's recent-activity feed
 * (parseLineForActivity + formatActivity).
 *
 * The whole-transcript derivations that used to live here — current activity,
 * waiting-for-input, output-token throughput — were deleted in issue #741: the
 * CLI's state engine computes them and `agents sessions --active --json` carries
 * them as ActiveSession.activity / awaitingReason / tokPerSec.
 *
 * The todo/plan-progress transcript parser was likewise deleted in RUSH-1503: the
 * CLI carries the computed checklist on `agents sessions <id> --json` as
 * `session.todos`, mapped into the panel shape by `todoProgressFromCli`.
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

export type TodoProgressStatus = 'pending' | 'in_progress' | 'completed';

/** One item of an agent's task checklist, parsed from its latest plan write. */
export interface TodoProgressItem {
  content: string;             // the task text
  status: TodoProgressStatus;
  activeForm?: string;         // Claude's present-tense form, when the write carries it
}

/** An agent's current checklist plus a done/total tally for a live progress pill. */
export interface TodoProgress {
  todos: TodoProgressItem[];
  done: number;                // count of status === 'completed'
  total: number;               // todos.length
}

/**
 * Map the CLI's computed checklist into the panel's TodoProgress shape (RUSH-1503).
 *
 * The CLI state engine derives the latest `TodoWrite` (Claude) / `update_plan`
 * (Codex) for EVERY agent and carries it on `agents sessions <id> --json` as
 * `session.todos` ({ items: [{ content, status, activeForm }], done, total }). The
 * extension consumes that here instead of re-parsing the raw transcript itself — one
 * source of truth for checklist state. `done`/`total` are recomputed from the mapped
 * items so a malformed tally can't drive the progress bar. Returns null when the
 * payload carries no usable checklist. Pure, so it's unit-tested.
 */
export function todoProgressFromCli(raw: unknown): TodoProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const todos: TodoProgressItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const content = typeof (it as { content?: unknown }).content === 'string'
      ? ((it as { content: string }).content).trim()
      : '';
    if (!content) continue;
    const item: TodoProgressItem = { content, status: normalizeTodoStatus((it as { status?: unknown }).status) };
    const activeForm = (it as { activeForm?: unknown }).activeForm;
    if (typeof activeForm === 'string' && activeForm.trim()) item.activeForm = activeForm.trim();
    todos.push(item);
  }
  if (todos.length === 0) return null;
  return {
    todos,
    done: todos.filter(t => t.status === 'completed').length,
    total: todos.length,
  };
}

function normalizeTodoStatus(s: unknown): TodoProgressStatus {
  return s === 'completed' || s === 'in_progress' ? s : 'pending';
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
