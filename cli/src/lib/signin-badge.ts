/**
 * Shared login-state LOOK. One place decides how "signed in / logged out"
 * renders and what the login command is, so `agents doctor`, `agents view`, and
 * the `agents run` preflight banner all read identically.
 *
 * The signal is `AccountInfo.signedIn` from `getAccountInfo` (file-based, cheap,
 * no Keychain ACL prompt). It is advisory — opaque-credential agents (Kimi,
 * Antigravity) and keychain-bound Claude can false-negative — so callers that act
 * on it (the run preflight) WARN and continue; they never block.
 */
import chalk from 'chalk';
import { AGENTS } from './agents.js';
import type { AccountInfo } from './agents.js';
import type { AuthVerdict } from './auth-health.js';
import { CONFIG_ENV_ISOLATED_AGENTS } from './installations/shims.js';
import type { AgentId } from './types.js';

export type AccountVerdict =
  | Exclude<AuthVerdict, 'unconfigured' | 'error'>
  | 'missing'
  | 'per-device'
  | 'ready';

export type AccountProvisioning = 'portable' | 'per-device';

/**
 * The exact command that logs a given agent in — for warn banners and nudges.
 * Driven off the registry `cliCommand` with the per-agent subcommand overrides
 * (verified against the real CLIs): codex/grok use `<cli> login`, opencode uses
 * `<cli> auth login`, claude logs in from inside its TUI via `/login`, and the
 * remaining agents (kimi, gemini, …) start their device/oauth flow on launch.
 */
export function loginHint(agentId: AgentId): string {
  const cli = AGENTS[agentId]?.cliCommand ?? agentId;
  switch (agentId) {
    case 'claude':
      return `${cli}, then /login`;
    case 'codex':
    case 'grok':
      return `${cli} login`;
    case 'opencode':
      return `${cli} auth login`;
    // Warp Agent CLI has no `login` subcommand: running `warp` opens a browser
    // sign-in on launch (or set WARP_API_KEY / pass --api-key), so the default
    // bare-`warp` hint is correct.
    default:
      return cli;
  }
}

/**
 * Exact action shown beside a non-live account. Every emitted command exists
 * today — never a planned surface:
 * - Per-device harnesses repair per box via `agents devices login`.
 * - Named accounts re-auth through `accounts connect <harness> <name>`, the
 *   reconnect-by-name path that reuses the account's home. (The T4 track adds
 *   the `accounts login <h>#<name>` spelling for the same operation; connect
 *   is what exists now, and on a worker it refuses cleanly with the role hint
 *   rather than attempting a native OAuth flow.)
 * - Unnamed legacy homes use the same version-targeted command shape as
 *   doctor, so the hint never logs a different/default home in by accident.
 * - `unverified` emits nothing: the probe could not confirm state (e.g. a
 *   worker whose token lacks the usage scope), so there is nothing to repair.
 */
export function fixFor(input: {
  agent: AgentId;
  verdict: AccountVerdict;
  name?: string | null;
  version?: string | null;
  provisioning?: AccountProvisioning;
}): string | null {
  const { agent, verdict } = input;
  if (verdict === 'live' || verdict === 'rate_limited' || verdict === 'unverified' || verdict === 'ready') return null;
  if (input.provisioning === 'per-device' || verdict === 'per-device') {
    return `agents devices login --agents ${agent}`;
  }
  if (input.name) return `agents accounts connect ${agent} ${input.name}`;

  const version = input.version ?? null;
  if (!version || !CONFIG_ENV_ISOLATED_AGENTS.includes(agent)) return loginHint(agent);
  if (agent === 'claude') return `agents run ${agent}@${version}, then /login`;
  if (agent === 'codex' || agent === 'grok') return `agents run ${agent}@${version} -- login`;
  if (agent === 'opencode') return `agents run ${agent}@${version} -- auth login`;
  return `agents run ${agent}@${version}`;
}

/**
 * Whether `agents run` should probe login state before launching. True only for
 * a launch that actually opens the interactive TUI — where discovering a logged-out
 * account after the fact wastes time. Suppressed when there is no preamble surface
 * (`--json`/`--quiet`), when the check is explicitly disabled
 * (`--no-auth-check` / `AGENTS_NO_AUTH_CHECK=1`), or when a rotation already picked a
 * signed-in account.
 *
 * `forceInteractive` is load-bearing: a resume of a non-native-resume agent
 * (`agents run kimi --resume`, also grok/opencode/gemini) rewrites the prompt to
 * `/continue <id>` — so `hasPrompt` is true even though the run still opens the TUI.
 * Keying only off `hasPrompt` would silently skip the warning on exactly those
 * agents (the ones the feature is for), so the resume's `forceInteractive` flag is
 * consulted directly.
 */
/**
 * Is a Claude run on this box going to authenticate from an ambient
 * `CLAUDE_CODE_OAUTH_TOKEN` rather than a per-version login?
 *
 * `AccountInfo.signedIn` is `!!email` read from a version home's `.claude.json`
 * (agents.ts), so a version with no account written there reports signed-out —
 * even though Claude Code authenticates fine from the env token and the run
 * succeeds. Rendering that as "logged out" sends people hunting a login that is
 * not missing (a real fleet incident: every version on a box read as locked out
 * while all of them answered a live prompt).
 *
 * It is also the more useful warning: an ambient token is ONE account, so every
 * version on the box resolves to it and balanced rotation across them rotates
 * nothing. `env` is a parameter so the branch is testable without mutating the
 * process environment.
 */
export function ambientClaudeToken(
  agentId: AgentId | string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return agentId === 'claude' && (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim().length > 0;
}

export function shouldCheckLoginBeforeLaunch(o: {
  interactive?: boolean;
  forceInteractive?: boolean;
  headless?: boolean;
  hasPrompt: boolean;
  json?: boolean;
  quiet?: boolean;
  authCheckDisabled?: boolean;
  rotated?: boolean;
}): boolean {
  if (o.json || o.quiet || o.authCheckDisabled || o.rotated) return false;
  return o.interactive === true || o.forceInteractive === true || (!o.hasPrompt && o.headless !== true);
}

/**
 * Colored `✓ signed in <account>` / `✗ logged out` badge. When signed in and an
 * account label is derivable (email, else an account id), it is appended in cyan;
 * opaque-credential agents with no email still read as signed in.
 */
export function formatSignInBadge(
  info: Pick<AccountInfo, 'signedIn' | 'email' | 'accountId'> | null | undefined,
): string {
  if (!info?.signedIn) return chalk.red('✗ logged out');
  const who = info.email ?? (info.accountId ? `id:${info.accountId}` : '');
  return who ? `${chalk.green('✓ signed in')} ${chalk.cyan(who)}` : chalk.green('✓ signed in');
}
