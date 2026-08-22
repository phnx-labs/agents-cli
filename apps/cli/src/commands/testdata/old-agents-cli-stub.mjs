#!/usr/bin/env node
/**
 * Stands in for a pre-`--resolve-safe-v1` agents-cli (1.20.88) behind the
 * ssh-peer fixture's `agents` shim (RUSH-2819).
 *
 * The old-peer test used to `npx -y -p @phnx-labs/agents-cli@1.20.88` the real
 * published package: a live npm-registry fetch inside the required PR gate,
 * bounded only by a 60s timeout. Measured cost: 122s on CI run 32439609875
 * (blocking release v1.22.43) vs 12s when the fetch was warm, three timeout
 * raises since 2026-08-03, and a macOS hermeticity leak — the old build's
 * darwin self-heal predates the version bypass and bootstrapped launchd under
 * the real HOME (RUSH-2963).
 *
 * The parent behavior under test — a partial fleet result when a peer rejects
 * the safe resolver protocol — depends only on the peer exiting nonzero with
 * commander's unknown-option rejection, which this stub reproduces verbatim
 * (same message, same exit 1 as @phnx-labs/agents-cli@1.20.88). The ssh
 * transport, ControlMaster socket, and parent CLI all stay real.
 */
const args = process.argv.slice(2);
const unknown = args.find((arg) => arg === '--resolve-safe-v1');
if (unknown) {
  process.stderr.write(`error: unknown option '${unknown}'\n`);
  process.exit(1);
}
process.stderr.write(`old-agents-cli-stub: unexpected invocation: ${args.join(' ')}\n`);
process.exit(2);
