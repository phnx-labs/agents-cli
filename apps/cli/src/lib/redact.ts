/**
 * Shared redaction helpers for text that may be exported or logged.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  // GitHub: classic PATs (ghp_), OAuth (gho_), app/refresh/server tokens
  // (ghs_/ghr_), and fine-grained PATs (github_pat_). All share the 36-char
  // classic body; fine-grained tokens are longer, so match greedily.
  [/\bghp_[A-Za-z0-9]{36}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgh[osru]_[A-Za-z0-9]{36}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  // Anthropic keys (sk-ant-api03-…) before the generic sk- rule so the marker
  // is specific; the generic rule would otherwise swallow it first.
  [/\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_ANTHROPIC_KEY]'],
  // Stripe live secret / restricted keys.
  [/\b[rs]k_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED_STRIPE_KEY]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED_API_KEY]'],
  // Slack bot/user/app-level tokens (xoxb-/xoxp-/xapp-…).
  [/\bxox[bp]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bxapp-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED_NPM_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]'],
  [/Bearer\s+\S+/gi, 'Bearer [REDACTED]'],
  [/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=[REDACTED]'],
];

/** Env vars whose NAME marks their VALUE as a credential worth masking literally. */
const SECRET_ENV_NAME = /(?:TOKEN|KEY|SECRET|PASSWORD)/i;
/** Don't literal-mask trivially short values — they collide with ordinary text. */
const MIN_KNOWN_VALUE_LEN = 6;

/**
 * Scrub secrets from `text`. Two passes: format-based patterns (above), then a
 * value-aware pass that masks any `knownValues` verbatim — a credential we
 * already hold in hand leaks regardless of its format, so an exact-value match
 * catches tokens the regexes don't recognize.
 */
export function redactSecrets(text: string, knownValues?: readonly string[]): string {
  let safe = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    safe = safe.replace(pattern, replacement);
  }
  if (knownValues) {
    for (const value of knownValues) {
      if (value.length < MIN_KNOWN_VALUE_LEN) continue;
      safe = safe.split(value).join('[REDACTED]');
    }
  }
  return safe;
}

/**
 * Secret values already present in the environment (e.g. an injected secrets
 * bundle), selected by secret-shaped var NAME. These are the "known" values fed
 * to {@link redactSecrets} so an exported transcript can't leak a live
 * credential verbatim even when its format matches no pattern.
 */
export function knownSecretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_KNOWN_VALUE_LEN) continue;
    if (SECRET_ENV_NAME.test(name)) out.push(value);
  }
  return out;
}
