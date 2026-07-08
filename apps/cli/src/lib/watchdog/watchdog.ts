// Watchdog: pure logic for detecting stalled agent terminals and rendering
// prompts to a headless decider instance that decides whether to nudge them.
// Ported from Swarmify (extension/src/core/watchdog.ts) — behavior verbatim.
// Terminal/session delivery lives elsewhere; this module reads no files and
// touches no host APIs so it can be unit-tested in isolation.

export interface WatchdogCandidate {
  terminalId: string;
  agentType: 'claude' | 'codex' | 'gemini';
  tailLines: string[];
  stalledForMs: number;
}

export interface Decision {
  terminalId: string;
  action: 'nudge' | 'skip';
  text: string;
  reason: string;
}

const FORCE_REVIEW_STALL_MS = 15 * 60 * 1000;
const BLOCKED_HINTS = [
  'blocked',
  'stuck',
  "can't",
  'cannot',
  'unable',
  'failed',
  'error',
  'exception',
  'traceback',
  'timed out',
  'timeout',
  'rate limit',
  'permission denied',
];
const WAITING_HINTS = [
  'waiting on user',
  'awaiting user',
  'askuserquestion',
];
const COMPLETION_HINTS = [
  'done',
  'completed',
  'all set',
  'finished',
];
const TOOL_CALL_HINTS = [
  '"type":"tool_use"',
  '"type":"tool_call"',
  '"type":"function_call"',
];
const ASSISTANT_LINE_HINTS = [
  '"type":"assistant"',
  '"role":"assistant"',
  '"payload":{"type":"message"',
];
const PROMISE_HINTS = [
  "i'll",
  'i will',
  'let me',
  'going to',
  "next i'll",
  'next i will',
];

export type StallStatus =
  | { kind: 'active' }
  | { kind: 'dormant' }
  | { kind: 'opted_out' }
  | { kind: 'rate_limited'; cooldownRemainingMs: number }
  | { kind: 'stalled'; stalledForMs: number };

export interface ClassifyInput {
  lastActivityMs: number;
  nowMs: number;
  lastNudgeMs: number | null;
  optedOut: boolean;
  stallMs: number;
  cooldownMs: number;
  dormantMs: number;
}

export function classifyTerminal(input: ClassifyInput): StallStatus {
  if (input.optedOut) return { kind: 'opted_out' };
  const age = input.nowMs - input.lastActivityMs;
  if (age < input.stallMs) return { kind: 'active' };
  if (age > input.dormantMs) return { kind: 'dormant' };
  if (input.lastNudgeMs !== null) {
    const sinceNudge = input.nowMs - input.lastNudgeMs;
    if (sinceNudge < input.cooldownMs) {
      return { kind: 'rate_limited', cooldownRemainingMs: input.cooldownMs - sinceNudge };
    }
  }
  return { kind: 'stalled', stalledForMs: age };
}

export const WATCHDOG_SYSTEM_PROMPT = `You are a watchdog monitoring AI coding agents that run in terminals.
For each stalled terminal below, decide: NUDGE (send a short message to unstick it) or SKIP.

Nudge when:
- The last assistant turn announced an action ("I'll write X", "let me run Y")
  but no matching tool call followed.
- The agent appears stuck mid-task with no recent progress and the task is incomplete.

Skip when:
- The agent asked the user a direct question (waiting on human input).
- The task looks complete.
- You cannot tell what the agent is doing.

Nudge text must be:
- One sentence, imperative ("Show me the file.", "Run the tests.").
- No emojis. No apologies. Under 120 characters.

Respond with ONLY a JSON array (no prose, no code fence):
[{"terminalId":"<id>","action":"nudge"|"skip","text":"<message or empty>","reason":"<brief>"}]`;

// User-editable playbook appended below the built-in prompt. The user maintains
// the source at ~/.agents/playbooks/watchdog.md (read by the delivery layer);
// this function is pure so it can be tested without filesystem access.
export function composePromptWithPlaybook(basePrompt: string, playbook: string): string {
  const trimmed = playbook.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}\n\n## House Rules (user playbook)\n\n${trimmed}`;
}

export function renderWatchdogPrompt(candidates: WatchdogCandidate[], playbook = ''): string {
  const systemPrompt = composePromptWithPlaybook(WATCHDOG_SYSTEM_PROMPT, playbook);
  const parts: string[] = [systemPrompt, '', 'STALLED TERMINALS:', ''];
  for (const c of candidates) {
    const seconds = Math.round(c.stalledForMs / 1000);
    parts.push(`--- terminal ${c.terminalId} (${c.agentType}, idle ${seconds}s) ---`);
    parts.push('last JSONL lines:');
    for (const line of c.tailLines) {
      parts.push(line);
    }
    parts.push('');
  }
  return parts.join('\n');
}

export function parseWatchdogResponse(stdout: string): Decision[] {
  if (!stdout || !stdout.trim()) return [];

  const arrayMatch = stdout.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayMatch[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const decisions: Decision[] = [];
  for (const d of parsed) {
    if (!d || typeof d !== 'object') continue;
    const obj = d as Record<string, unknown>;
    const terminalId = typeof obj.terminalId === 'string' ? obj.terminalId : '';
    const action = obj.action === 'nudge' || obj.action === 'skip' ? obj.action : null;
    const text = typeof obj.text === 'string' ? obj.text : '';
    const reason = typeof obj.reason === 'string' ? obj.reason : '';
    if (!terminalId || !action) continue;
    decisions.push({ terminalId, action, text, reason });
  }
  return decisions;
}

export function isLikelyTrulyBlocked(candidate: WatchdogCandidate): boolean {
  if (candidate.stalledForMs >= FORCE_REVIEW_STALL_MS) return true;
  if (candidate.tailLines.length === 0) return false;

  const lowerTail = candidate.tailLines.join('\n').toLowerCase();
  if (WAITING_HINTS.some((hint) => lowerTail.includes(hint))) return false;
  if (COMPLETION_HINTS.some((hint) => lowerTail.includes(hint))) return false;
  if (BLOCKED_HINTS.some((hint) => lowerTail.includes(hint))) return true;

  let sawToolAfter = false;
  for (let i = candidate.tailLines.length - 1; i >= 0; i--) {
    const line = candidate.tailLines[i].toLowerCase();
    if (TOOL_CALL_HINTS.some((hint) => line.includes(hint))) {
      sawToolAfter = true;
      continue;
    }
    if (!sawToolAfter) {
      const isAssistantLine = ASSISTANT_LINE_HINTS.some((hint) => line.includes(hint));
      const hasPromise = PROMISE_HINTS.some((hint) => line.includes(hint));
      if (isAssistantLine && hasPromise) return true;
    }
  }

  return false;
}
