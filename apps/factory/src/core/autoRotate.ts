// Pure logic for the `agents run auto` rotate path (RUSH-2132).
//
// The watchdog's auto-rotate no longer picks a version itself — it delegates
// host affinity, harness headroom, and account balance to the CLI via
// `agents run auto`. The CLI FAILS LOUD when nothing is healthy: nonzero exit
// with stderr containing `no healthy` and `resets <time>`. This module builds
// that launch command and parses that error text (and agent-reported
// rate-limit tails) so the rotate path and the watchdog can suppress rotation
// until the window resets instead of churning a dead terminal every tick.
//
// vscode-free so it can be unit-tested in isolation.

/**
 * The rotate launch: full auto — the CLI resolves host (affinity) → harness
 * (cross-harness headroom) → account (balanced), and exits nonzero when every
 * layer is exhausted. A terminal already on a device rotates ON that device
 * (`--host`); a local terminal omits it and lets affinity pick. `--session-id`
 * is honored only when the CLI picks claude (existing claude-only semantics)
 * and ignored otherwise — passing it unconditionally keeps the local terminal's
 * AGENT_SESSION_ID aligned with the session Claude actually creates.
 */
export function buildAutoRotateLaunchCommand(opts: {
  host?: string;
  sessionId: string;
}): string {
  let cmd = 'agents run auto --interactive';
  if (opts.host) {
    cmd += ` --host ${shellQuoteHost(opts.host)}`;
  }
  cmd += ` --session-id ${opts.sessionId}`;
  return cmd;
}

/** Single-quote a device name so it can never break out of the built command. */
function shellQuoteHost(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The literal substring the CLI's fail-loud boundary guarantees on stderr. */
export const NO_HEALTHY_SUBSTRING = 'no healthy';

// Agent-reported exhaustion texts, matched against a session transcript tail.
// Kept specific on purpose — a transcript carries prose, so a loose "rate
// limit" match would rotate terminals whose agent merely DISCUSSED limits.
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /you'?ve hit your [\w-]*\s?limit/i,
  /hit your (weekly|daily|usage|session) limit/i,
  /usage limit (has been )?(reached|exceeded)/i,
  /rate limit (reached|exceeded)/i,
  /out of (credits|extra usage)/i,
];

export type RotateTailVerdict =
  | { kind: 'none' }
  | { kind: 'rate_limited'; resetsAtMs?: number }
  | { kind: 'no_healthy_account'; agentKey?: string; resetsAtMs?: number };

/**
 * Classify a terminal tail for the rotate decision. The CLI's `no healthy`
 * error (a rotate found nothing to rotate INTO) suppresses rotation entirely
 * until the reset; an agent-reported limit means this terminal needs rotating.
 */
export function classifyTailForRotate(tail: string, nowMs: number): RotateTailVerdict {
  const noHealthy = parseNoHealthyError(tail, nowMs);
  if (noHealthy) {
    return { kind: 'no_healthy_account', agentKey: noHealthy.agentKey, resetsAtMs: noHealthy.resetsAtMs };
  }
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(tail))) {
    return { kind: 'rate_limited', resetsAtMs: parseResetTimeMs(tail, nowMs) };
  }
  return { kind: 'none' };
}

/**
 * Parse the CLI's fail-loud error text. Captured-real line (RUSH-2132):
 *   agents: no healthy claude account under strategy 'balanced' — excluded: a@x.com
 *   (weekly); earliest window resets 2026-08-10T14:00:00.000Z. Use --strategy
 *   pinned to force the default.
 * (The reset is `reset.toISOString()` — always milliseconds + Z — or
 * `unknown (no reset timestamps in any snapshot)`.) Returns null when the text
 * is not the no-healthy error.
 */
export function parseNoHealthyError(
  text: string,
  nowMs: number,
): { agentKey?: string; resetsAtMs?: number } | null {
  if (!text.includes(NO_HEALTHY_SUBSTRING)) return null;
  const agentKey = /no healthy ([a-z][a-z0-9-]*) account/i.exec(text)?.[1];
  return { agentKey, resetsAtMs: parseResetTimeMs(text, nowMs) };
}

/**
 * Parse the `resets <time>` clause of a limit error into an epoch-ms cooldown
 * horizon. The CLI's `reset.toISOString()` form (milliseconds + Z) is matched
 * EXPLICITLY and first: a generic "up to the sentence period" capture stops at
 * the milliseconds dot and drops the Z, which makes Date.parse read LOCAL time
 * — the suppression would end hours late in UTC− zones and hours EARLY in UTC+
 * zones (re-rotating into exhausted accounts). Time-of-day forms like `7am` /
 * `7:30pm` with an optional `(Area/City)` IANA zone are handled for agent
 * transcript tails (claude's own limit text); the CLI never emits those.
 * Returns undefined when no usable reset is present or the parsed time is
 * already in the past (caller falls back to its default cooldown).
 */
export function parseResetTimeMs(text: string, nowMs: number): number | undefined {
  const iso = /resets\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/i.exec(text);
  if (iso) {
    const parsedIso = Date.parse(iso[1]);
    return Number.isNaN(parsedIso) || parsedIso <= nowMs ? undefined : parsedIso;
  }

  const m = /resets\s+([^.;!\n]+)/i.exec(text);
  if (!m) return undefined;
  const segment = m[1].trim();
  const timeZone = /\(([A-Za-z_]+\/[A-Za-z_]+)\)/.exec(segment)?.[1];
  const timePart = segment.replace(/\([A-Za-z_]+\/[A-Za-z_]+\)/, '').trim();

  const parsed = Date.parse(timePart);
  if (!Number.isNaN(parsed)) {
    return parsed > nowMs ? parsed : undefined;
  }

  const t = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(timePart);
  if (!t) return undefined;
  let hour = parseInt(t[1], 10) % 12;
  if (t[3].toLowerCase() === 'pm') hour += 12;
  const minute = t[2] ? parseInt(t[2], 10) : 0;
  return nextOccurrenceMs(hour, minute, timeZone, nowMs);
}

/**
 * What the rotate does when agentReady never fires on the fresh terminal. A
 * BLIND launch (sendText — no shell-integration output tap) cannot distinguish
 * a slow TUI from a CLI that already failed `no healthy` into a dead shell, so
 * the failure callback must NOT type the resume input into that shell and must
 * NOT close the old terminal: the session there is limited but still alive,
 * and closing it gains nothing. The observed (shell-integration) path already
 * gave the CLI a window to fail loud, so a timeout there keeps the legacy
 * slow-TUI behavior: type the resume input anyway and honor closeOldTerminal.
 */
export function agentReadyFailureAction(blind: boolean): {
  sendResumeInput: boolean;
  closeOld: boolean;
} {
  return blind
    ? { sendResumeInput: false, closeOld: false }
    : { sendResumeInput: true, closeOld: true };
}

/** Next wall-clock occurrence of hour:minute in the given zone after nowMs. */
function nextOccurrenceMs(
  hour: number,
  minute: number,
  timeZone: string | undefined,
  nowMs: number,
): number | undefined {
  try {
    if (!timeZone) {
      const d = new Date(nowMs);
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    // Wall-clock "now" in the target zone, to minute precision — close enough
    // for a cooldown horizon.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (type: string): number =>
      parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
    const year = get('year');
    const month = get('month') - 1;
    const day = get('day');
    const wallNowMs = Date.UTC(year, month, day, get('hour') % 24, get('minute'));
    const offsetMs = wallNowMs - nowMs;
    let candidate = Date.UTC(year, month, day, hour, minute) - offsetMs;
    if (candidate <= nowMs) candidate += 24 * 60 * 60 * 1000;
    return candidate;
  } catch {
    return undefined;
  }
}
