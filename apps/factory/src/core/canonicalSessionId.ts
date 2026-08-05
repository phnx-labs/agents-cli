/**
 * Normalize a session identifier for display and tab binding.
 *
 * Codex transcripts are named `rollout-<timestamp>-<uuid>.jsonl`. The real
 * session id is the UUID (also in `session_meta.payload.id` and Codex `/status`).
 * Factory historically used the full file stem as the id, which polluted the
 * status bar and broke resume/copy. Prefer the CLI's UUID; fall back to the
 * raw value when it is already a clean id (Claude, Grok, OpenCode, …).
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * True when `raw` looks like a Codex rollout file stem rather than a bare session id.
 */
export function isRolloutSessionStem(raw: string | undefined | null): boolean {
  if (!raw) return false;
  return /^rollout-/i.test(raw.trim());
}

/**
 * Return the canonical session id for status bar / clipboard / resume.
 * - `rollout-2026-…-<uuid>` → `<uuid>`
 * - bare UUID / `ses_…` / other harness ids → unchanged
 * - empty / whitespace → undefined
 */
export function canonicalSessionId(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (isRolloutSessionStem(s)) {
    const m = s.match(UUID_RE);
    return m?.[0];
  }
  // Filename accidentally passed through (with or without .jsonl)
  if (s.endsWith('.jsonl')) {
    const base = s.slice(0, -'.jsonl'.length);
    return canonicalSessionId(base);
  }
  return s;
}
