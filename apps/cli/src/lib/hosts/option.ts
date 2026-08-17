/**
 * Shared `--device` option registrar. Every command that can run on a remote device
 * declares the flag through here, so its spelling, help text, and companions
 * (`--remote-cwd`, `--no-tty`, `--any`) stay identical everywhere and show up in
 * each command's `--help`.
 *
 * The flags are consumed centrally by `maybeRunOnHost` (passthrough.ts) *before*
 * commander parses, so for a real remote run the local action never sees them.
 * Registering them here still matters: it documents the flag and keeps the local
 * fall-through (e.g. `--device <this-machine>`) from erroring on an unknown option.
 */

import type { Command } from 'commander';

/** Attach the standard `--device` flag family to a command and return it (chainable). */
export function addHostOption(cmd: Command): Command {
  return cmd
    .option(
      '-D, --device <name>',
      'Run this command on another machine over SSH instead of locally — a registered device, user@host, or `all` to fan out across every registered device. See `agents devices` / `agents hosts`.',
    )
    .option('--remote-cwd <dir>', "Working directory on the device for --device runs. Resolves on the REMOTE device — pass a '$HOME'-relative path (single-quoted so your local shell doesn't expand it) or a valid remote absolute path; a local ~ expands here and won't exist there (/Users/you vs /home/you). No effect on 'teams add'.")
    .option('--no-tty', 'Force non-interactive output for --device runs even from a terminal.')
    .option('--any', 'With --device <cap> (a capability tag), pick any matching device instead of erroring when several match.');
}
