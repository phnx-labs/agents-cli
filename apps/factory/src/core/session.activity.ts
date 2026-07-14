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
 * Extract the agent's CURRENT task checklist + progress from a session transcript.
 *
 * Fine-grained progress rides the per-task detail STREAM (the transcript tail the
 * caller already read for recent activity) — NOT the floor poll — so
 * this adds no extra I/O.
 *
 * The LATEST plan write fully supersedes earlier ones (the agent rewrites the whole
 * list each time), so we walk from the end and stop at the first valid match:
 *   - Claude: a `TodoWrite` tool_use with `input.todos: [{content,status,activeForm}]`.
 *   - Codex:  an `update_plan` function_call with `arguments.plan: [{step,status}]`.
 *   - Gemini: has no plan/todo tool — always null.
 * Returns null when there is no plan write or the latest one is empty. Pure so it's
 * unit-tested.
 */
export function extractTodoProgress(
  sessionContent: string,
  agentType: AgentType
): TodoProgress | null {
  if (agentType !== 'claude' && agentType !== 'codex') return null;
  const marker = agentType === 'claude' ? 'TodoWrite' : 'update_plan';
  const lines = sessionContent.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    if (!line.includes(marker)) continue;
    let raw: any;
    try { raw = JSON.parse(line); } catch { continue; }
    const todos = agentType === 'claude' ? parseClaudeTodos(raw) : parseCodexPlan(raw);
    if (!todos) continue;
    if (todos.length === 0) return null;
    return {
      todos,
      done: todos.filter(t => t.status === 'completed').length,
      total: todos.length,
    };
  }
  return null;
}

function normalizeTodoStatus(s: unknown): TodoProgressStatus {
  return s === 'completed' || s === 'in_progress' ? s : 'pending';
}

/** Parse a Claude `TodoWrite` tool_use line into checklist items (null if not one). */
function parseClaudeTodos(raw: any): TodoProgressItem[] | null {
  if (raw?.type !== 'assistant') return null;
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type !== 'tool_use' || block?.name !== 'TodoWrite') continue;
    const list = block?.input?.todos;
    if (!Array.isArray(list)) return null;
    const todos: TodoProgressItem[] = [];
    for (const it of list) {
      const text = typeof it?.content === 'string' ? it.content.trim() : '';
      if (!text) continue;
      const item: TodoProgressItem = { content: text, status: normalizeTodoStatus(it?.status) };
      if (typeof it?.activeForm === 'string' && it.activeForm.trim()) item.activeForm = it.activeForm.trim();
      todos.push(item);
    }
    return todos;
  }
  return null;
}

/** Parse a Codex `update_plan` function_call line into checklist items (null if not one). */
function parseCodexPlan(raw: any): TodoProgressItem[] | null {
  if (raw?.type !== 'response_item') return null;
  const payload = raw?.payload;
  if (payload?.type !== 'function_call' || payload?.name !== 'update_plan') return null;
  let args: any = {};
  if (typeof payload?.arguments === 'string') {
    try { args = JSON.parse(payload.arguments); } catch { return null; }
  } else if (payload?.arguments && typeof payload.arguments === 'object') {
    args = payload.arguments;
  }
  const list = args?.plan;
  if (!Array.isArray(list)) return null;
  const todos: TodoProgressItem[] = [];
  for (const it of list) {
    const text = typeof it?.step === 'string' ? it.step.trim() : '';
    if (!text) continue;
    todos.push({ content: text, status: normalizeTodoStatus(it?.status) });
  }
  return todos;
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
