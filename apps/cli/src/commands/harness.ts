/**
 * Custom harness commands (`agents harness`).
 *
 * A "custom harness" is a named (host CLI + model) combo — e.g. OpenCode pinned
 * to meta/muse-spark-1.1, called `spark`. It runs like a native agent type
 * (`agents run spark`) and syncs across devices via `agents repo push user`.
 *
 * Mechanism: harnesses ARE profiles (same ~/.agents/profiles/*.yml, same run
 * resolution). This command group is the harness-flavored surface over that
 * layer + a discovery `list` spanning custom harnesses, addable presets, and the
 * native harness registry. The `agents profiles` tree stays unchanged.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { addProfile, type AddProfileOptions } from './profiles.js';
import {
  listProfiles,
  readProfile,
  deleteProfile,
  profileHostLabel,
  profileProviderLabel,
  profileModelLabel,
  profileAuthLabel,
  getProfilePath,
} from '../lib/profiles.js';
import { listPresets } from '../lib/profiles-presets.js';
import { AGENTS, ALL_AGENT_IDS } from '../lib/agents.js';

/** Short capability summary for a native harness — its supported run modes. */
function nativeModes(id: (typeof ALL_AGENT_IDS)[number]): string {
  const modes = AGENTS[id]?.capabilities?.modes ?? [];
  return modes.length ? modes.join('/') : '-';
}

export function registerHarnessCommands(program: Command): void {
  const cmd = program
    .command('harness')
    .alias('harnesses')
    .description('Custom harnesses — name a (host CLI + model) combo and run it like a native agent type.')
    .addHelpText(
      'after',
      `
A custom harness pins a host CLI (opencode, claude, codex, grok, antigravity, ...) to a
model and gives it a name. 'agents run <name>' then behaves like a native agent
type, and 'agents repo push user' syncs it to every device.

Examples:
  # Meta Muse Spark 1.1 through OpenCode, called 'spark'
  agents harness add spark --host opencode --model meta/muse-spark-1.1
  agents run spark "refactor api/handlers/checkout.py"

  # Per-run model override still wins
  agents run spark --model opencode/big-pickle "quick pass"

  # See custom harnesses, addable presets, and native harnesses
  agents harness list

  # Private OpenAI/Anthropic-compatible endpoint (stores a keychain key)
  agents harness add corp --host claude --model gpt-x --base-url https://gw.corp/v1 --auth-provider corp

  # Custom harnesses are just profiles — this also works via 'agents profiles'
`,
    );

  cmd
    .command('add <name>')
    .description('Create a custom harness from a host + model (or apply a built-in preset).')
    .option('--host <agent>', 'Host CLI to run under (opencode, claude, codex, grok, antigravity, ...) — pair with --model')
    .option('--model <id>', 'Model id to pin on the host (e.g., meta/muse-spark-1.1) — pair with --host')
    .option('--base-url <url>', 'Custom endpoint base URL (claude/codex hosts)')
    .option('--auth-provider <provider>', 'Attach a keychain-backed API key under this provider (for private endpoints)')
    .option('--preset <preset>', 'Apply a built-in preset instead of --host/--model')
    .option('--version <version>', 'Pin the host CLI version (e.g., 1.16.0)')
    .option('--key-stdin', 'Read API key from stdin instead of prompting (for scripts/CI)')
    .option('--force', 'Overwrite an existing harness with the same name')
    .action(async (name: string, opts: AddProfileOptions) => {
      try {
        await addProfile(name, opts, 'Harness');
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('list')
    .alias('ls')
    .description('List custom harnesses, addable presets, and native harnesses.')
    .option('--json', 'Emit JSON instead of a table')
    .action((opts: { json?: boolean }) => {
      const custom = listProfiles();
      const presets = listPresets();
      const native = ALL_AGENT_IDS.map((id) => ({ id, name: AGENTS[id].name, modes: nativeModes(id) }));

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              custom: custom.map((p) => ({
                name: p.name,
                host: p.host.agent,
                model: profileModelLabel(p),
                provider: profileProviderLabel(p),
              })),
              presets: presets.map((p) => ({ name: p.name, provider: p.provider, description: p.description })),
              native,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(chalk.bold('Custom harnesses') + chalk.gray('  (yours — agents run <name>)'));
      if (custom.length === 0) {
        console.log(chalk.gray('  none yet — try: agents harness add spark --host opencode --model meta/muse-spark-1.1'));
      } else {
        for (const p of custom) {
          console.log(
            `  ${chalk.cyan(p.name.padEnd(16))} ${profileHostLabel(p).padEnd(14)} ${chalk.gray(profileModelLabel(p))}`,
          );
        }
      }

      console.log('');
      console.log(chalk.bold('Presets') + chalk.gray('  (addable — agents harness add <name>)'));
      for (const p of presets) {
        console.log(`  ${chalk.cyan(p.name.padEnd(16))} ${p.provider.padEnd(12)} ${chalk.gray(p.description.slice(0, 70))}`);
      }

      console.log('');
      console.log(chalk.bold('Native harnesses') + chalk.gray('  (built-in — agents run <id>)'));
      for (const n of native) {
        console.log(`  ${chalk.cyan(n.id.padEnd(16))} ${n.name.padEnd(14)} ${chalk.gray('modes: ' + n.modes)}`);
      }
    });

  cmd
    .command('view <name>')
    .alias('show')
    .description('Show one custom harness (host, model, provider, auth, path).')
    .action((name: string) => {
      try {
        const p = readProfile(name);
        console.log(chalk.bold(p.name));
        if (p.description) console.log(chalk.gray(p.description));
        console.log('');
        console.log(`Host:     ${profileHostLabel(p)}`);
        console.log(`Model:    ${profileModelLabel(p)}`);
        console.log(`Provider: ${profileProviderLabel(p)}`);
        console.log(`Auth:     ${profileAuthLabel(p)}`);
        console.log(chalk.gray(getProfilePath(p.name)));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('remove <name>')
    .alias('rm')
    .description('Delete a custom harness (keychain token is kept).')
    .action((name: string) => {
      const existed = deleteProfile(name);
      if (!existed) {
        console.error(chalk.red(`Harness '${name}' not found.`));
        process.exit(1);
      }
      console.log(chalk.green(`Harness '${name}' removed.`));
    });
}
