/**
 * The headless-context detector shared by every secrets read path that could
 * raise a macOS Touch ID sheet: bundle resolution (bundles.ts) and raw item
 * reads (index.ts). It lives in its own module so index.ts can use it without
 * importing bundles.ts (which already imports index.ts).
 */

/**
 * True when the current process was structurally launched by an agent runtime
 * that must NEVER raise a Keychain biometry prompt on the user's screen:
 *   - `AGENTS_RUNTIME` is `headless`, `teams`, or `terminal` — i.e. ANY agent
 *     launch, interactive included, and inherited by everything spawned beneath
 *     one (set on the child env by `agents run --headless`, scheduled routines,
 *     teammates, and interactive runs — see exec.ts:430, runner.ts,
 *     teams/agents.ts).
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
): boolean {
  if (platform !== 'darwin') return false; // no biometry prompt to suppress off-darwin
  // Every agent-launch runtime resolves broker-only, interactive included.
  const runtime = env.AGENTS_RUNTIME;
  if (runtime === 'headless' || runtime === 'teams' || runtime === 'terminal') return true;
  return false;
}
