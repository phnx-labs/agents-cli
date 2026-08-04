/**
 * The headless-context detector shared by every secrets read path that could
 * raise a macOS Touch ID sheet: bundle resolution (bundles.ts) and raw item
 * reads (index.ts). It lives in its own module so index.ts can use it without
 * importing bundles.ts (which already imports index.ts).
 */

/**
 * True when the current process is a background / non-interactive context that
 * must NEVER raise a Keychain biometry prompt on the interactive user's screen —
 * a prompt nobody is watching. Two signals, either sufficient:
 *   - `AGENTS_RUNTIME` is `headless`, `teams`, or `terminal` — i.e. ANY agent
 *     launch, interactive included, and inherited by everything spawned beneath
 *     one (set on the child env by `agents run --headless`, scheduled routines,
 *     teammates, and interactive runs — see exec.ts:430, runner.ts,
 *     teams/agents.ts).
 *   - neither stdin nor stdout is a TTY (a detached/backgrounded task whose
 *     stdio is redirected to a log — e.g. a release script run in the
 *     background as `( ... ) >log 2>&1 </dev/null`).
 * `AGENTS_SECRETS_NO_PROMPT=1` forces headless-safe; `=0` force-allows a prompt
 * even in a non-TTY context. An `eval "$(agents secrets export X)"` typed in a
 * PLAIN shell has no AGENTS_RUNTIME, so it is not classified headless and still
 * prompts. Run beneath an agent it inherits AGENTS_RUNTIME and resolves
 * broker-only — the agent, not the human, is the caller there.
 *
 * Only **macOS keychain** reads pop an interactive Touch ID sheet — the secrets
 * broker itself is a no-op off darwin (see agent.ts), and libsecret (Linux) /
 * the Windows credential store resolve without any prompt. So off-darwin this
 * ALWAYS returns false: forcing broker-only there would break every headless
 * Linux/Windows read (CI, `agents run --headless`, routines, the Linux-driven
 * release flow) for no benefit — there is no prompt to suppress.
 *
 * A read in a macOS headless context resolves broker-only (agentOnly) and fails
 * fast with an actionable error instead of hijacking Touch ID. This generalizes
 * the per-caller broker-only pattern used across the headless secrets readers.
 */
export function isHeadlessSecretsContext(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  // Injected so the TTY branch below is testable: it is the branch that decides a
  // plain human shell still prompts, which is this guard's entire safety argument,
  // and reading process.* directly made it unreachable from a test.
  tty: { stdin?: boolean; stdout?: boolean } = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY },
): boolean {
  if (platform !== 'darwin') return false; // no biometry prompt to suppress off-darwin
  const override = env.AGENTS_SECRETS_NO_PROMPT;
  if (override === '1') return true;
  if (override === '0') return false;
  // Every AGENT-LAUNCH runtime resolves broker-only, interactive included.
  // `terminal` was missing, which made an agent terminal the one launch path
  // still allowed to pop Touch ID: exec.ts sets AGENTS_RUNTIME='terminal' for an
  // interactive run (exec.ts:430), that fell through to the TTY check below, and
  // a TTY meant "a human is watching, so prompting is fine". It is not fine —
  // opening a terminal is not a request to authenticate, and a launch that needs
  // a locked bundle should say so and point at `agents secrets unlock`, not grab
  // the fingerprint sensor. AGENTS_RUNTIME is INHERITED by everything spawned under
  // an agent, so `agents secrets export` run beneath one resolves broker-only too —
  // correctly: there the agent, not the human, is the caller. A plain shell carries
  // no AGENTS_RUNTIME, so a person running it themselves still gets the sheet.
  const runtime = env.AGENTS_RUNTIME;
  if (runtime === 'headless' || runtime === 'teams' || runtime === 'terminal') return true;
  return !tty.stdin && !tty.stdout;
}
