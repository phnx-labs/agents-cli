import type { Command } from 'commander';

/**
 * Configure the public root surface shared by the live CLI and reference generator.
 *
 * Does NOT call `enablePositionalOptions()` — tried for RUSH-2687 (a subcommand
 * option whose long name collides with an ancestor's is silently dropped at
 * parse time) and reverted. Commander's `copyInheritedSettings()` copies
 * `_enablePositionalOptions` onto every command created via `.command()` from
 * that point on, so setting it here cascades to all ~552 registered commands,
 * not just the root's own scan. That broke a real, load-bearing pattern used
 * elsewhere in the tree: a parent command (e.g. `sessions`, which owns
 * `--since`/`--json`/`--local`) whose LEAF subcommands declare none of their
 * own options and read them back via `command.optsWithGlobals()` (e.g.
 * `sessions backfill tools --since 7d --json --local`) — positional options
 * makes the parent stop scanning at the first subcommand-shaped token, so it
 * never sees the flags typed after it, and the leaf sees `unknown option`
 * instead of a silent drop. RUSH-2687 was fixed per-surface in share.ts
 * instead (renaming the colliding options), not with this global flag.
 */
export function configureRootCommand(program: Command, name: string, version: string): Command {
  return program
    .name(name)
    .description(
      'Install, configure, run, and dispatch AI coding agents from one place.\n' +
        'Works with Claude, Codex, Antigravity, Cursor, OpenCode, OpenClaw, and Droid.',
    )
    .version(version)
    .option('--verbose', 'Show startup self-heal details on stderr')
    .helpOption('-h, --help', 'Show help')
    .addHelpCommand(false);
}
