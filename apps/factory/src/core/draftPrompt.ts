import { spawn } from 'child_process';
import { resolveAgentsBin, bootstrapPath } from './agentsBin';

// Draft a dispatch prompt from one or more attached tickets, so the user doesn't
// hand-write the agent's instructions. Mirrors labelgen.ts: spawn a headless
// `agents run claude` in read-only plan mode and capture stdout — the agents CLI
// owns auth, so no API key is needed. The model is left to the user's default
// (a fuller model than labelgen's haiku) because the output is a multi-sentence
// work order, not a 3-word title.

const MAX_INPUT_CHARS = 6000;
const MAX_DESC_CHARS = 1500;
const DEFAULT_TIMEOUT_MS = 30000;

export interface DraftTicket {
  identifier?: string;
  title: string;
  description?: string;
}

/**
 * The meta-prompt handed to claude. Pure so it's unit-tested. Instructs an
 * immediate, tool-free response so plan mode returns text without investigating.
 */
export function buildDraftInput(tickets: DraftTicket[], hint?: string): string {
  const header =
    'You are writing a work order for an autonomous coding agent. Using the ticket(s) below, ' +
    'write the prompt that agent should receive. Requirements: imperative voice; 2-5 sentences; ' +
    'name the concrete change to make and how to verify it; no preamble, no markdown, no quotes, no headings. ' +
    'Respond IMMEDIATELY with only the prompt text. Do NOT use any tools, do NOT read files, do NOT investigate.';

  const parts: string[] = [header];
  const h = (hint ?? '').trim();
  if (h) parts.push(`Extra guidance from the user to fold in: ${h}`);

  const ticketLines = tickets
    .filter((t) => t && (t.title?.trim() || t.identifier?.trim()))
    .map((t) => {
      const id = t.identifier?.trim() ? `[${t.identifier.trim()}] ` : '';
      const title = (t.title ?? '').trim();
      const desc = (t.description ?? '').trim();
      const clipped = desc.length > MAX_DESC_CHARS ? `${desc.slice(0, MAX_DESC_CHARS)}…` : desc;
      return `- ${id}${title}${clipped ? `\n${clipped}` : ''}`;
    });
  if (ticketLines.length) parts.push(`Ticket(s):\n${ticketLines.join('\n\n')}`);

  const full = parts.join('\n\n');
  return full.length > MAX_INPUT_CHARS ? full.slice(0, MAX_INPUT_CHARS) : full;
}

/**
 * Clean the raw agent stdout into a usable prompt: unwrap a fenced block, drop a
 * leading "Prompt:"-style label, strip surrounding quotes. Pure. Returns null
 * when nothing usable remains. Multi-line is preserved (a work order is a
 * paragraph, unlike labelgen's single-line title).
 */
export function extractDraftText(raw: string): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;
  const fenced = s.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fenced) s = fenced[1].trim();
  s = s.replace(/^(prompt|work order|task|instructions?)\s*:\s*/i, '');
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
  return s || null;
}

/**
 * Draft a dispatch prompt for the given tickets. Returns null on empty input,
 * timeout, non-zero exit, or unresolvable agents binary (the caller surfaces an
 * inline error and leaves the user's box untouched).
 */
export async function draftDispatchPrompt(
  tickets: DraftTicket[],
  hint?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  const list = (tickets ?? []).filter((t) => t && (t.title?.trim() || t.identifier?.trim()));
  if (list.length === 0 && !(hint ?? '').trim()) return null;

  const prompt = buildDraftInput(list, hint);

  // Resolve the absolute `agents` binary + bootstrapped PATH so this works when
  // the editor is launched from Dock/Finder with a minimal PATH (see agentsBin).
  let bin: string;
  let runPath: string;
  try {
    bin = await resolveAgentsBin();
    runPath = `${bootstrapPath(bin)}:${process.env.PATH ?? ''}`;
  } catch {
    return null;
  }

  return new Promise<string | null>((resolve) => {
    let stdout = '';
    let resolved = false;

    const child = spawn(
      bin,
      ['run', 'claude', prompt, '--mode', 'plan'],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: runPath } },
    );

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => {
      if (code !== 0) return finish(null);
      finish(extractDraftText(stdout));
    });
  });
}
