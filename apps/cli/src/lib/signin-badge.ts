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
import type { AgentId } from './types.js';

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
    default:
      return cli;
  }
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
