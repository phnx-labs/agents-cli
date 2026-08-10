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

import { Option } from 'commander';
import type { Command } from 'commander';

/** Attach the standard `--host` flag family to a command and return it (chainable). */
export function addHostOption(cmd: Command): Command {
  return cmd
    .option(
      '-H, --host <name>',
      'Run this command on another machine over SSH instead of locally — a device, a registered host, user@host, or `all` to fan out across every registered device. See `agents devices` / `agents hosts`.',
    )
    .option('--device <name>', 'Alias of --host: run this command on a registered device (from `agents devices`), or `all` to run it across the whole fleet.')
    .option('--remote-cwd <dir>', "Working directory on the host for --host runs. Resolves on the REMOTE host — pass a '$HOME'-relative path (single-quoted so your local shell doesn't expand it) or a valid remote absolute path; a local ~ expands here and won't exist there (/Users/you vs /home/you). No effect on 'teams add'.")
    .option('--no-tty', 'Force non-interactive output for --host runs even from a terminal.')
    .option('--any', 'With --host <cap> (a capability tag), pick any matching host instead of erroring when several match.');
}

/**
 * Attach the resource-selector flag family to a command and return it (chainable).
 *
 * Per-kind flags let callers narrow which resource types (and optionally which
 * named resources within a type) are included in an operation. Each kind has a
 * singular primary flag and a hidden plural alias — they are identical in meaning.
 *
 *   Bare flag:         --plugin          → every plugin (kind = 'all')
 *   With names:        --plugin fleet    → only the plugin named "fleet"
 *   Comma list:        --plugin fleet,infra  → those two plugins
 *   Multiple flags:    --plugin fleet --plugin infra  → accumulates to both
 *   Plural alias:      --plugins fleet   → identical to --plugin fleet
 *
 * NOTE: --rule/--rules maps to the "memory" key in ResourceSelection (the
 * memory file is composed from all layers and is not individually filterable
 * by name — the flag enables the full recompile regardless of any name given).
 *
 * Also registers --version <spec> for the version-selector dimension
 * (the --agent and --repo dimensions are command-specific, so they are not
 * included here).
 */
export function addSelectorOptions(cmd: Command): Command {
  // Collector that accumulates comma-delimited values across repeated flags.
  // Called only when a value is provided; bare flags stay as `true` (commander
  // sets the option to `true` for an optional-arg flag with no value and no
  // default). We treat any non-array previous value as "start fresh" so that
  // bare-then-named (`--plugin` then `--plugin fleet`) correctly yields ['fleet'].
  const kindCollector = (val: string, prev: string[] | undefined): string[] => {
    const names = val.split(',').map((s) => s.trim()).filter(Boolean);
    const base = Array.isArray(prev) ? prev : [];
    return [...base, ...names];
  };

  function addKindPair(singular: string, plural: string, desc: string): void {
    cmd.addOption(new Option(`--${singular} [names]`, desc).argParser(kindCollector));
    cmd.addOption(new Option(`--${plural} [names]`, `Alias of --${singular}`).argParser(kindCollector).hideHelp());
  }

  addKindPair('plugin', 'plugins', 'Sync only plugins (bare = all; comma-separated names to filter)');
  addKindPair('command', 'commands', 'Sync only commands (bare = all; comma-separated names to filter)');
  addKindPair('skill', 'skills', 'Sync only skills (bare = all; comma-separated names to filter)');
  addKindPair('hook', 'hooks', 'Sync only hooks (bare = all; comma-separated names to filter)');
  addKindPair('subagent', 'subagents', 'Sync only subagents (bare = all; comma-separated names to filter)');
  addKindPair('permission', 'permissions', 'Sync only permissions (bare = all; comma-separated names to filter)');
  addKindPair('mcp', 'mcps', 'Sync only MCP servers (bare = all; comma-separated names to filter)');
  addKindPair('workflow', 'workflows', 'Sync only workflows (bare = all; comma-separated names to filter)');
  cmd.addOption(
    new Option(
      '--rule [names]',
      'Sync only the rules/memory file (maps to the "memory" key — the whole file is always recompiled, individual names are not filtered)',
    ).argParser(kindCollector),
  );
  cmd.addOption(new Option('--rules [names]', 'Alias of --rule').argParser(kindCollector).hideHelp());
  // Boolean alias: --memory selects the rules/memory file without any name filter.
  cmd.addOption(new Option('--memory', 'Sync only the rules/memory file (alias of --rule with no name filter)'));

  // Version-selector dimension (the @-selector or concrete x.y.z).
  // --agent and --repo are not included here because their descriptions and
  // behavior are command-specific.
  cmd.addOption(
    new Option(
      '--version <spec>',
      'Agent version or selector: @latest, @oldest, @pinned (= @default), @all, or a concrete x.y.z. "all" targets every installed version non-interactively.',
    ),
  );

  return cmd;
}
