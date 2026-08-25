/**
 * Credential provisioning for `agents run --device --copy-creds`.
 *
 * `--copy-creds` USED TO copy each signed-in runtime's native login to a
 * persistent host — the Claude OAuth token (`.claude/.credentials.json`) plus
 * codex/grok/gemini `auth.json`-style files — so the box booted logged-in. Every
 * one of those is a **rotating, interactive OAuth / session credential**, and
 * copying it between devices is forbidden by the fleet-auth contract
 * (`docs/specifications.md` SING-1b, `docs/secrets.md`):
 * a shared refresh token rotates server-side on the next refresh and invalidates
 * every other copy — the "droid collapsed 10 boxes to 1 overnight" failure.
 *
 * So this module no longer serializes native logins at all. It REFUSES the
 * transfer and steers to the portable path — a long-lived, non-rotating provider
 * account (`agents accounts add` / `agents accounts sync`), whose bundle is
 * policy-`never` and safe to reuse on many devices. That sync rides its own
 * hardened SSH transport (RUSH-2527); it never touches this path.
 */

import type { AgentId } from '../types.js';
import type { DetectedRuntime } from '../crabbox/runtimes.js';
import { isNativeOAuthRuntime, nativeOAuthTransferRefusal } from '../crabbox/runtimes.js';

// The native-OAuth predicate + refusal are canonical in `crabbox/runtimes.ts`
// (next to `LEASE_RUNTIMES`), so `--copy-creds` here and `--lease` there refuse
// against exactly the same set. Re-export for this module's existing consumers.
export { isNativeOAuthRuntime, nativeOAuthTransferRefusal } from '../crabbox/runtimes.js';

export interface HostCredentials {
  runtimes: AgentId[];
  detected: DetectedRuntime[];
  claudeCredentialsJson?: string | null;
}

/**
 * Build the setup/teardown scripts for a `--copy-creds` host run.
 *
 * Every runtime `--copy-creds` handles is a native OAuth / session login, so this
 * REFUSES rather than serialize one across the wire (SING-1b) — it throws with the
 * concrete `agents accounts` steer. The refusal happens BEFORE anything is
 * serialized, so a native credential can never reach a remote-write script. An
 * empty runtime set is a no-op (nothing to provision, nothing forbidden).
 */
export function buildHostCredentialScript(opts: HostCredentials): { setup: string; teardown: string } {
  const native = opts.runtimes.filter(isNativeOAuthRuntime);
  if (native.length > 0) {
    throw new Error(nativeOAuthTransferRefusal(native));
  }
  return { setup: '', teardown: '' };
}

/**
 * Wrap a remote command with credential setup/teardown for a `--copy-creds` run.
 *
 * Delegates to {@link buildHostCredentialScript}, which now refuses to transfer a
 * native OAuth login — so a `--copy-creds` run against a signed-in native runtime
 * fails loudly here (before dispatch) with the `agents accounts sync` steer,
 * rather than shipping a rotating token to another device.
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
