#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

/**
 * CLI entry point for agents-cli.
 *
 * Slim shell (RUSH-2335): only the leaf `lib/secrets/sync-commands.js` is a
 * static import, so the argv fast paths below can answer without evaluating the
 * commander + self-update + command-registry graph that used to be hoisted
 * above every intercept (~140ms of cold bootstrap per synchronous secrets-
 * broker read). The full CLI loads via `await import('./bootstrap.js')` once
 * none of the fast paths match.
 *
 * Fast paths (must stay above the bootstrap import — ESM does not hoist dynamic
 * `import()`, but any static import here would still evaluate first):
 *   - `__vault-age-helper`
 *   - `__secrets-get` / `__secrets-ping` / `__secrets-lock` (SYNC_* tokens)
 *   - `__shim`
 *   - `__daemon-run`
 *   - `__daemon-tick`
 *
 * The tokens are imported from the leaf module sync-commands.ts — the SAME
 * bindings the clients spawn with, so this dispatch and those spawns cannot
 * drift apart. It is a leaf precisely so binding them here is free: importing
 * agent.js would pull the whole secrets graph into every invocation.
 */

import { SYNC_GET_CMD, SYNC_PING_CMD, SYNC_LOCK_CMD } from './lib/secrets/sync-commands.js';

// Force exit on Ctrl+C when no interactive prompt is handling it.
process.on('SIGINT', () => process.exit(130));

// Ignore SIGPIPE — prevents exit code 13 crashes in piped environments
// (e.g. `agents sessions | head`, or when stdout is captured by another process).
process.on('SIGPIPE', () => {});

if (process.argv[2] === '__vault-age-helper') {
  const { runVaultAgeHelperCli } = await import('./lib/secrets/vault-age-helper.js');
  await runVaultAgeHelperCli();
  process.exit(process.exitCode ?? 0);
}

// Synchronous secrets-broker clients (src/lib/secrets/agent.ts). These are the
// hot read path: `readAndResolveBundleEnv` is synchronous all the way down, so
// it can't await a socket round-trip — it spawns one of these and reads the
// exit code (0 = hit/alive, 3 = miss/down).
//
// Intercepted HERE, before bootstrap, for the same reason as __daemon-run and
// __vault-age-helper. Everything in bootstrap runs `checkForUpdates()` and
// `spawnDetachedSync()` on every non-help invocation — so registering these as
// ordinary hidden subcommands would fire an update check and fork a detached
// background sync on *every cache hit*, which is both a fork storm on the hot
// path and a source of stdout writes that could corrupt the JSON payload. Keep
// them above the line; agent.test.ts asserts this ordering so the block can't
// drift into bootstrap.
if (
  process.argv[2] === SYNC_GET_CMD ||
  process.argv[2] === SYNC_PING_CMD ||
  process.argv[2] === SYNC_LOCK_CMD
) {
  const { runAgentGetSync, runAgentPingSync, runAgentLockSync } = await import('./lib/secrets/agent.js');
  const name = process.argv[3] ?? '';
  const harness = process.argv[4] ?? 'cli';
  const code =
    process.argv[2] === SYNC_GET_CMD ? await runAgentGetSync(name, harness)
    : process.argv[2] === SYNC_PING_CMD ? await runAgentPingSync()
    : await runAgentLockSync(name);
  process.exit(code);
}

// Transparent shim delegate: the generated Windows `.cmd` shims invoke
// `agents __shim <agent>[@version] <raw args>`. Intercept here, before bootstrap
// parses anything, so the agent's own flags (`--help`, `--version`, etc.) pass
// through completely untouched and we skip registering the full command tree.
if (process.argv[2] === '__shim') {
  const spec = process.argv[3] || '';
  const rawArgs = process.argv.slice(4);
  const atIndex = spec.indexOf('@');
  const agent = atIndex === -1 ? spec : spec.slice(0, atIndex);
  const pinned = atIndex === -1 ? undefined : spec.slice(atIndex + 1);
  const { execShimPassthrough } = await import('./lib/exec.js');
  const code = await execShimPassthrough(agent as import('./lib/types.js').AgentId, rawArgs, process.cwd(), pinned || undefined);
  process.exit(code);
}

if (process.argv[2] === '__daemon-run') {
  const { runDaemon, log: daemonLog } = await import('./lib/daemon.js');

  // RUSH-2418: the daemon is the one always-on process here, and it ran with no
  // top-level handler of any kind — an uncaught throw or a rejected promise from
  // any of its background ticks died on Node's default handler, printing a raw
  // stack to whatever the service manager had wired to stdout and never reaching
  // the daemon's own structured log. Route both into log() so the failure is in
  // logs.jsonl where `agents daemon logs` reads it, then exit non-zero and
  // DELIBERATELY let the supervisor restart us — now paced by the plist's
  // ThrottleInterval / the unit's StartLimitBurst. Swallowing here would be the
  // worse failure: a daemon left alive with a dead subsystem.
  const crash = (kind: string) => (err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try { daemonLog('ERROR', `${kind}: ${detail}`); } catch { /* log path unwritable — stderr below still carries it */ }
    process.stderr.write(`[agents] daemon ${kind}: ${detail}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', crash('uncaughtException'));
  process.on('unhandledRejection', crash('unhandledRejection'));

  try {
    await runDaemon();
  } catch (err) {
    crash('startup failure')(err);
  }
  process.exit(process.exitCode ?? 0);
}

// One-shot invocation of a migrated daemon housekeeping tick (RUSH-2353). The
// shipped system routines (`watchdog`, `device-probe`, `fleet-cache-warm`, ...)
// run this as their `command:` instead of the daemon holding a setInterval —
// same tick body, now scheduled/tracked/pinnable through the routines system.
if (process.argv[2] === '__daemon-tick') {
  const name = process.argv[3] || '';
  const { runDaemonTick } = await import('./lib/daemon-ticks.js');
  try {
    await runDaemonTick(name);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[agents] daemon tick '${name}' failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// Full CLI: commander tree, update checks, migrations, parse. Static imports
// inside bootstrap.js evaluate only when we reach this line.
await import('./bootstrap.js');
