// Foreman "smart" mode brain: a turn-based TEXT agent.
//
// Unlike the realtime engine (foreman.audio.ts, OpenAI speech-to-speech), smart
// mode takes TEXT in — typed, or dictated via the user's own Superwhisper — and
// returns TEXT out. The brain is an OpenAI text model with tool-calling over the
// SAME shared FOREMAN_TOOLS, so tool routing gets full text-model reliability
// instead of the weaker speech-to-speech routing. No mic, no STT, no TTS, no
// barge-in — it's "chat with a tool-using Foreman."
//
// This module is pure (no vscode import) so it can be real-service tested
// against the live OpenAI API. The extension host injects the API key and the
// tool runner (runForemanTool).

import { FOREMAN_SYSTEM_PROMPT, FOREMAN_TOOLS, ForemanTool } from '../core/foreman.config';

export const SMART_MODEL = 'gpt-4.1-mini';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
// Bound on tool rounds in a single turn — a runaway model that keeps calling
// tools without answering can't spin forever.
const MAX_TOOL_ROUNDS = 6;

// Trim rolling history to at most `max` messages WITHOUT splitting a tool
// sequence. A turn is [user, assistant(tool_calls), tool..., assistant]; a raw
// slice(-max) can leave the window starting on a `tool` (or an assistant whose
// tool_calls got cut), which OpenAI 400s on ("tool message must follow an
// assistant with tool_calls"). We advance the cut forward to the next `user`
// message so the window always begins at a clean turn boundary.
export function capHistory(messages: any[], max: number): any[] {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start]?.role !== 'user') start++;
  return messages.slice(start);
}

// OpenAI Chat Completions nests our schema under `function`. FOREMAN_TOOLS is
// already {type:'function',name,description,parameters}; this is the shallow wrap.
export function adaptToolsForOpenAI(tools: ForemanTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface SmartTurnEvents {
  onText?: (delta: string) => void;                 // streamed assistant text
  onToolCall?: (name: string, args: unknown) => void;
  onStatus?: (status: 'thinking' | 'tool' | 'done' | 'error', detail?: string) => void;
}

export interface SmartTurnOpts {
  apiKey: string;
  model?: string;
  history: any[];                                    // prior messages (no system prompt)
  userText: string;
  tools?: ForemanTool[];
  runTool: (name: string, args: unknown) => Promise<unknown>;
  events?: SmartTurnEvents;
  signal?: AbortSignal;
}

// Run ONE user turn to completion: stream assistant text, resolve any tool
// calls against runTool, loop until the model answers. Returns the final text
// and the updated history so the caller carries context into the next turn.
export async function runSmartTurn(opts: SmartTurnOpts): Promise<{ text: string; history: any[] }> {
  const model = opts.model ?? SMART_MODEL;
  const tools = adaptToolsForOpenAI(opts.tools ?? FOREMAN_TOOLS);
  const messages: any[] = [
    { role: 'system', content: FOREMAN_SYSTEM_PROMPT },
    ...opts.history,
    { role: 'user', content: opts.userText },
  ];

  let finalText = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    opts.events?.onStatus?.('thinking');
    const { text, toolCalls } = await streamOne(opts.apiKey, model, messages, tools, opts.events, opts.signal);

    if (toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: text });
      finalText = text;
      opts.events?.onStatus?.('done');
      break;
    }

    // The assistant turn carrying tool_calls must be recorded verbatim BEFORE
    // the tool results, or the next request 400s on a dangling tool result.
    messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
    opts.events?.onStatus?.('tool');
    for (const tc of toolCalls) {
      let args: unknown = {};
      try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
      opts.events?.onToolCall?.(tc.function.name, args);
      let result: unknown;
      try { result = await opts.runTool(tc.function.name, args); }
      catch (e: any) { result = { error: e?.message ?? String(e) }; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
    // loop: the model now speaks using the tool results
  }

  // Exhausted MAX_TOOL_ROUNDS without a plain answer: don't return an empty
  // string (the UI silently drops empty finals). Surface it.
  if (!finalText) {
    opts.events?.onStatus?.('error', 'stopped after too many tool calls');
    finalText = 'Stopped after too many tool steps without an answer.';
  }

  return { text: finalText, history: messages.slice(1) };
}

// Stream one chat completion. Accumulates assistant text (emitting deltas) and
// reassembles tool_calls, which OpenAI streams as fragments across deltas
// (id + name arrive first, arguments accrete as a JSON string).
async function streamOne(
  apiKey: string,
  model: string,
  messages: any[],
  tools: unknown[],
  events: SmartTurnEvents | undefined,
  signal: AbortSignal | undefined,
): Promise<{ text: string; toolCalls: any[] }> {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    events?.onStatus?.('error', `OpenAI ${res.status}`);
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }

  let text = '';
  const toolCalls: any[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        events?.onText?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const d of delta.tool_calls) {
          const i = d.index ?? 0;
          if (!toolCalls[i]) toolCalls[i] = { id: d.id ?? '', type: 'function', function: { name: '', arguments: '' } };
          if (d.id) toolCalls[i].id = d.id;
          if (d.function?.name) toolCalls[i].function.name += d.function.name;
          if (d.function?.arguments) toolCalls[i].function.arguments += d.function.arguments;
        }
      }
    }
  }
  return { text, toolCalls: toolCalls.filter(Boolean) };
}
