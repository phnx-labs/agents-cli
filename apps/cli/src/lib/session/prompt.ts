/**
 * Prompt cleaning and topic extraction for session messages.
 *
 * Strips noise injected by the agent framework (system context lines, XML
 * wrapper tags, team-spawn boilerplate) so that only the real user intent
 * remains. Used by the session picker to show a human-readable topic line.
 */

/** Patterns that cause the entire message to be skipped for topic extraction. */
const WHOLE_MESSAGE_SKIP_PATTERNS = [
  /<permissions instructions>/i,
  /<collaboration_mode>/i,
  /^# AGENTS\.md instructions for\b/im,
  /<local-command-caveat>/i,
  // Slash-command invocations (e.g. /continue, /done) — actual user intent
  // lives in the next user message, not in these wrapper tags.
  /<command-(message|name|args)>/i,
];

/** Per-line noise patterns stripped during prompt cleaning (env context, bare paths, etc). */
const NOISE_LINE_PATTERNS = [
  /^(cwd|shell|current_date|timezone|os|platform|arch|home|user)\b\s*:/i,
  /^\/[\w/.-]+$/,
  /^(bash|zsh|fish|sh|dash)$/i,
  /^\d{4}-\d{2}-\d{2}$/,
  /^[A-Z][A-Za-z]+\/[A-Z][\w+-]+$/,
  /^Caveat:/i,
];

/** XML tag prefix used by local-command messages. */
const LOCAL_COMMAND_PREFIX = '<local-command-caveat>';

// Prefix prepended to every Claude-in-plan-mode team spawn prompt.
// Ends at a blank line before the real user task.
export const HEADLESS_PLAN_MODE_PREFIX = 'You are running in HEADLESS PLAN MODE.';

// Wrappers added to team-spawned prompts in src/lib/teams/agents.ts.
// Stripped before topic extraction so the picker shows what the user actually typed.
/** Marker string appended to team-spawned prompts; stripped before topic extraction. */
const TEAM_PROMPT_SUFFIX_MARKER = "When you're done, provide a brief summary of:";

/** Remove headless-plan-mode prefix and team summary suffix from a raw prompt. */
function stripTeamWrappers(raw: string): string {
  let text = raw;
  if (text.trimStart().startsWith(HEADLESS_PLAN_MODE_PREFIX)) {
    const blankLine = text.indexOf('\n\n');
    if (blankLine === -1) return '';
    text = text.slice(blankLine + 2);
  }
  const suffixIdx = text.indexOf(TEAM_PROMPT_SUFFIX_MARKER);
  if (suffixIdx !== -1) text = text.slice(0, suffixIdx);
  return text.trim();
}

/** Strip framework noise from a raw session prompt, returning only meaningful user text. */
export function cleanSessionPrompt(raw: string): string {
  let text = stripTeamWrappers(raw).replace(/\r/g, '').trim();
  if (!text) return '';

  text = text.replace(/<\/?[a-z_][a-z0-9_-]*>/gi, '');

  const meaningful = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !NOISE_LINE_PATTERNS.some(pattern => pattern.test(line)));

  return meaningful.join('\n').trim();
}

/** Extract a one-line topic from a raw user message, or undefined if the message is pure noise. */
export function extractSessionTopic(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  if (WHOLE_MESSAGE_SKIP_PATTERNS.some(pattern => pattern.test(raw))) {
    return undefined;
  }

  const cleaned = cleanSessionPrompt(raw);
  if (!cleaned) return undefined;
  if (WHOLE_MESSAGE_SKIP_PATTERNS.some(pattern => pattern.test(cleaned))) {
    return undefined;
  }

  const firstLine = cleaned.split('\n').map(line => line.trim()).find(Boolean);
  return firstLine || undefined;
}
