/**
 * Poll-failure classifier (PHNX-3510).
 *
 * A poll that FAILS to observe — the command exited non-zero, or its output
 * carries a transport/auth/rate-limit error shape — is an OBSERVATION FAILURE,
 * not a new value. Reading it as a value is the defect this closes: a
 * `gh pr list … | jq` monitor whose gh half intermittently prints
 * `GraphQL: API rate limit already exceeded …` flapped empty→error→empty, and an
 * `[on-change]` monitor read that as two value changes and dispatched a full
 * agent run on a premise that was false.
 *
 * The exit code alone is not enough: when gh is piped into jq the shell's exit
 * status is jq's (0 on empty input), so the rate-limit text can ride an exit-0
 * observation. The text patterns catch exactly that case. They stay tightly
 * scoped to unambiguous failure shapes so a legitimate observation whose content
 * merely mentions "timeout" is never misread as a failure.
 */

/** A failure text pattern and the short reason it maps to (used in drought health). */
interface FailurePattern {
  re: RegExp;
  reason: string;
}

const FAILURE_TEXT_PATTERNS: FailurePattern[] = [
  { re: /\bAPI rate limit (?:already )?exceeded\b/i, reason: 'API rate limit exceeded' },
  { re: /\bsecondary rate limit\b/i, reason: 'secondary rate limit' },
  { re: /^\s*GraphQL:\s/im, reason: 'GraphQL error' },
  { re: /\bbad credentials\b/i, reason: 'bad credentials' },
  { re: /\b(?:401 Unauthorized|403 Forbidden)\b/i, reason: 'auth error' },
  { re: /\bcould not resolve host\b/i, reason: 'transport error (DNS)' },
  { re: /\bconnection (?:refused|reset|timed out)\b/i, reason: 'connection error' },
  { re: /\bnetwork is unreachable\b/i, reason: 'network unreachable' },
];

/** The failure reason matched in a poll's output text, or null when it looks clean. */
export function matchFailureText(text: string): string | null {
  for (const { re, reason } of FAILURE_TEXT_PATTERNS) {
    if (re.test(text)) return reason;
  }
  return null;
}

/**
 * Classify one poll snapshot. Returns a short failure reason when the snapshot is
 * an observation failure (non-zero exit, or a failure-shaped output), else null —
 * in which case the snapshot is a genuine value the condition may diff.
 *
 * A failure-shaped OUTPUT is checked even on exit 0, because a piped command
 * (`gh … | jq`) swallows the failing half's exit code. A non-zero exit is a
 * failure regardless of output shape.
 */
export function classifyPollFailure(input: { exitCode?: number; text: string }): string | null {
  const textReason = matchFailureText(input.text);
  const badExit = typeof input.exitCode === 'number' && input.exitCode !== 0;
  if (badExit) {
    return textReason ? `${textReason} (exit ${input.exitCode})` : `command exited ${input.exitCode}`;
  }
  return textReason;
}
