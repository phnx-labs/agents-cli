/**
 * Credential provisioning for `agents run --host --copy-creds`.
 *
 * Reuses the lease flow's runtime detection + credential-script builder so a
 * persistent host can boot logged-in the same way an ephemeral leased box does.
 * Unlike `--lease`, a host is persistent, so copying tokens is strictly opt-in
 * per run and we shred the files after the run to bound the credential window.
 */

import type { AgentId } from '../types.js';
import { buildCredentialScript, CLAUDE_TOKEN_REMOTE, type DetectedRuntime } from '../crabbox/runtimes.js';

function getShredPaths(runtimes: AgentId[]): string[] {
  const pathsById: Record<string, string[]> = {
    claude: ['.claude.json', CLAUDE_TOKEN_REMOTE],
    codex: ['.codex/auth.json'],
    gemini: ['.gemini/google_accounts.json'],
    grok: ['.grok/auth.json'],
  };
  return runtimes.flatMap((id) => pathsById[id as string] ?? []);
}

export interface HostCredentials {
  runtimes: AgentId[];
  detected: DetectedRuntime[];
  claudeCredentialsJson?: string | null;
}

/**
 * Build the setup (write credential files) and teardown (shred them) scripts for
 * a host run. Returns shell snippets meant to be run on the remote host.
 */
export function buildHostCredentialScript(opts: HostCredentials): { setup: string; teardown: string } {
  const setup = buildCredentialScript(opts.runtimes, opts.detected, {
    claudeCredentialsJson: opts.claudeCredentialsJson,
  });
  const teardown = getShredPaths(opts.runtimes)
    .map((p) => `rm -f "$HOME/${p}" 2>/dev/null || true`)
    .join('\n');
  return { setup, teardown };
}

/**
 * Wrap a remote command so credentials are written before it runs and shredded
 * after it exits, regardless of success or failure.
 */
export function wrapHostCommandWithCredentials(innerCommand: string, opts: HostCredentials): string {
  const { setup, teardown } = buildHostCredentialScript(opts);
  return [
    'set -uo pipefail',
    setup,
    innerCommand,
    'rc=$?',
    teardown,
    'exit $rc',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
}
