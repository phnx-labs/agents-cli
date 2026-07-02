/**
 * Shared `--host` option registrar. Every command that can run on a remote host
 * declares the flag through here, so its spelling, help text, and companions
 * (`--remote-cwd`, `--no-tty`, `--any`) stay identical everywhere and show up in
 * each command's `--help`.
 *
 * The flags are consumed centrally by `maybeRunOnHost` (passthrough.ts) *before*
 * commander parses, so for a real remote run the local action never sees them.
 * Registering them here still matters: it documents the flag and keeps the local
 * fall-through (e.g. `--host <this-machine>`) from erroring on an unknown option.
 */

import type { Command } from 'commander';

/** Attach the standard `--host` flag family to a command and return it (chainable). */
export function addHostOption(cmd: Command): Command {
  return cmd
    .option(
      '-H, --host <name>',
      'Run this command on a registered host (or user@host) over SSH instead of locally. See `agents hosts`.',
    )
    .option('--remote-cwd <dir>', 'Working directory on the host for --host runs.')
    .option('--no-tty', 'Force non-interactive output for --host runs even from a terminal.')
    .option('--any', 'With --host <cap> (a capability tag), pick any matching host instead of erroring when several match.');
}
