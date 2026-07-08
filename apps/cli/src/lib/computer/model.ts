// Default reasoning model for the `computer run` loop.
//
// This is a BOUNDARY, not loop logic. It turns the loop's LoopState into an
// Anthropic Messages API request (tool use), sends it to the Claude API by
// default OR to a configurable base URL (Ollama / vLLM / LiteLLM serving the
// Anthropic wire shape) for local/offline parity, and parses the reply back
// into a ModelDecision the loop can act on.
//
// The loop (loop.ts) never imports this — it takes a ModelResponder callback,
// so the unit tests inject a scripted fake instead of ever hitting a network.

import type { LoopState, ModelDecision, ModelResponder, VerbCall } from './loop.js';

// The verb surface exposed to the model as tools. Names match the CLI verbs
// (and the dispatcher's verb -> RPC mapping), so nothing here reimplements a
// verb — the model just names one and the dispatcher runs it over the daemon.
interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const TARGET_PROPS = {
  bundle: { type: 'string', description: 'Bundle id of the target app (default: frontmost allow-listed app)' },
  pid: { type: 'number', description: 'Target pid (overrides bundle)' },
};

export const COMPUTER_TOOLS: ToolSpec[] = [
  { name: 'apps', description: 'List allow-listed apps currently running.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'describe',
    description: 'Dump the accessibility tree of the target app. Element ids feed click/type via id. If the tree is opaque the loop auto-captures a screenshot for you.',
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, depth: { type: 'number' } } },
  },
  {
    name: 'screenshot',
    description: 'Capture the target app window as an image (the vision path — use coordinate clicks off it).',
    input_schema: { type: 'object', properties: { ...TARGET_PROPS } },
  },
  {
    name: 'get-text',
    description: 'Extract visible text from the target app (or a subtree via id).',
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, id: { type: 'string' } } },
  },
  {
    name: 'click',
    description: 'Click an element (id from describe) or a screen coordinate (x,y). Use x,y after a vision screenshot.',
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
  },
  {
    name: 'type',
    description: 'Set a field value (id) or paste at a coordinate. Set commit=true to submit.',
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, commit: { type: 'boolean' } }, required: ['text'] },
  },
  {
    name: 'type-text',
    description: 'Type a unicode string into the focused field. Focus it first with click or focus.',
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, text: { type: 'string' }, commit: { type: 'boolean' } }, required: ['text'] },
  },
  {
    name: 'key',
    description: 'Send a key chord, e.g. "cmd+s", "enter", "esc".',
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, keys: { type: 'string' } }, required: ['keys'] },
  },
  {
    name: 'launch',
    description: 'Launch an app by bundle id, path, or name.',
    input_schema: { type: 'object', properties: { bundle: { type: 'string' }, path: { type: 'string' }, name: { type: 'string' } } },
  },
  {
    name: 'wait',
    description: 'Wait for a duration (ms) or for an element to appear.',
    input_schema: { type: 'object', properties: { ...TARGET_PROPS, duration: { type: 'number' }, id: { type: 'string' }, role: { type: 'string' }, label: { type: 'string' } } },
  },
];

export interface ClaudeResponderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  // Injectable for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
}

export const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
export const ANTHROPIC_VERSION = '2023-06-01';

// Resolve the API key: explicit config, then the standard Anthropic env var,
// then a computer-run-specific override. A local Anthropic-shaped endpoint
// (Ollama/vLLM/LiteLLM) usually ignores the key, so an empty key is allowed
// when a non-default base URL is set.
export function resolveApiKey(config: ClaudeResponderConfig, env: NodeJS.ProcessEnv = process.env): string {
  return config.apiKey || env.AGENTS_COMPUTER_API_KEY || env.ANTHROPIC_API_KEY || '';
}

// Build the system prompt. In vision mode we steer the model onto coordinate
// clicks off screenshots, because element ids from an opaque tree are useless.
export function buildSystemPrompt(state: LoopState): string {
  const lines = [
    'You are driving a macOS desktop through accessibility + vision tools to accomplish a task.',
    'Loop: observe (describe / screenshot / get-text), act (click / type / key), then verify the result before the next step.',
    'Prefer element ids from describe. When you are confident the task is complete, stop calling tools and reply with a short completion summary.',
    `Task: ${state.task}`,
  ];
  if (state.visionMode) {
    lines.push('NOTE: the accessibility tree for the current surface is opaque (WebView / canvas). Work from the screenshot and click by x,y coordinates instead of element ids.');
  }
  return lines.join('\n');
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

// Reconstruct the Anthropic message array from the loop transcript. We rebuild
// from scratch each turn (the loop holds canonical state), synthesizing stable
// tool_use ids per step so each tool_result pairs with its call.
export function buildMessages(state: LoopState): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: [{ type: 'text', text: `Begin. Task: ${state.task}` }] },
  ];
  state.steps.forEach((step, i) => {
    const id = `call_${i}`;
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: step.call.name, input: step.call.input }] });
    const summary = step.result.ok
      ? JSON.stringify(step.result.result ?? {}).slice(0, 4000)
      : `error: ${step.result.error ?? 'unknown'}`;
    const note = step.visionFallback ? ' [ax tree opaque — auto-captured screenshot follows; use coordinate clicks]' : '';
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: summary + note }] });
  });
  return messages;
}

// Parse the Anthropic response body into a ModelDecision. tool_use blocks
// become tool calls; a reply with no tool calls is treated as the model
// finishing, with its text as the summary.
export function parseDecision(body: unknown): ModelDecision {
  const content = (body as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content : [];
  const toolCalls: VerbCall[] = [];
  const texts: string[] = [];
  for (const block of blocks) {
    const b = block as { type?: string; name?: string; input?: unknown; text?: string };
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      toolCalls.push({ name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
    } else if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
    }
  }
  if (toolCalls.length === 0) {
    return { toolCalls: [], done: { text: texts.join('\n').trim() || 'no further action' } };
  }
  return { toolCalls };
}

// The default responder: one Anthropic Messages call per turn.
export function makeClaudeResponder(config: ClaudeResponderConfig = {}): ModelResponder {
  const baseUrl = (config.baseUrl || DEFAULT_CLAUDE_BASE_URL).replace(/\/+$/, '');
  const model = config.model || DEFAULT_CLAUDE_MODEL;
  const maxTokens = config.maxTokens ?? 1024;
  const doFetch = config.fetchImpl ?? fetch;
  const apiKey = resolveApiKey(config);

  return async (state: LoopState): Promise<ModelDecision> => {
    const res = await doFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: buildSystemPrompt(state),
        tools: COMPUTER_TOOLS,
        messages: buildMessages(state),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`model request failed: ${res.status} ${res.statusText} ${text.slice(0, 500)}`);
    }
    const body = await res.json();
    return parseDecision(body);
  };
}
