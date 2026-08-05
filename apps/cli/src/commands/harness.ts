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
import { addProfile, ensureProviderToken, type AddProfileOptions } from './profiles.js';
import {
  listProfiles,
  readProfile,
  writeProfile,
  deleteProfile,
  profileExists,
  profileHostLabel,
  profileProviderLabel,
  profileModelLabel,
  profileAuthLabel,
  profileLabel,
  forkProfile,
  profileFromHostModel,
  authEnvKeyForHost,
  getProfilePath,
  validateProfileName,
  editProfile,
  renameProfile,
  type Profile,
  type EditProfileOptions,
} from '../lib/profiles.js';
import { listPresets } from '../lib/profiles-presets.js';
import { AGENTS, ALL_AGENT_IDS, resolveAgentName } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';

/** Short capability summary for a native harness — its supported run modes. */
function nativeModes(id: (typeof ALL_AGENT_IDS)[number]): string {
  const modes = AGENTS[id]?.capabilities?.modes ?? [];
  return modes.length ? modes.join('/') : '-';
}

/**
 * Print one custom harness. Shared by `agents harness view <name>` and by
 * `agents view <name>` — a custom harness resolves as an agent type there, so
 * both entry points must describe it identically.
 */
export function renderHarnessDetail(name: string): void {
  const p = readProfile(name);
  console.log(chalk.bold(profileLabel(p)) + chalk.gray('  (custom harness)'));
  if (p.description) console.log(chalk.gray(p.description));
  console.log('');
  console.log(`Host:     ${profileHostLabel(p)}`);
  console.log(`Model:    ${profileModelLabel(p)}`);
  if (p.fallback_model) console.log(`Fallback: ${p.fallback_model}`);
  console.log(`Provider: ${profileProviderLabel(p)}`);
  console.log(`Auth:     ${profileAuthLabel(p)}`);
  if (p.forkedFrom) console.log(`Forked:   from ${p.forkedFrom}`);
  console.log(chalk.gray(getProfilePath(p.name)));
  console.log('');
  console.log(chalk.gray(`Run: agents run ${p.name} "hello"`));
}

/** Options accepted by `agents harness fork`. */
export interface ForkOptions {
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  version?: string;
  label?: string;
  description?: string;
  keyStdin?: boolean;
  force?: boolean;
}

/**
 * Build the new harness for `agents harness fork <source> <name>`.
 *
 * Two sources, one verb: an existing custom harness is copied and overridden;
 * a native agent id is turned into a harness pinned to `--model` on that host.
 * Forking a native harness therefore requires `--model` — there is nothing to
 * copy a model from.
 */
export function buildFork(source: string, name: string, opts: ForkOptions): Profile {
  if (profileExists(source)) {
    return forkProfile(readProfile(source), name, {
      model: opts.model,
      baseUrl: opts.baseUrl,
      provider: opts.authProvider,
      version: opts.version,
      label: opts.label,
      description: opts.description,
    });
  }

  const host = resolveAgentName(source);
  if (!host) {
    throw new Error(
      `No harness or agent named '${source}'.\n` +
        `Fork from a custom harness (agents harness list) or a native one: ${ALL_AGENT_IDS.join(', ')}.`,
    );
  }
  if (!opts.model) {
    throw new Error(`--model <id> is required when forking the native '${host}' harness (there is no model to inherit).`);
  }
  return profileFromHostModel(name, host, opts.model, {
    version: opts.version,
    baseUrl: opts.baseUrl,
    provider: opts.authProvider,
    authEnvVar: opts.authProvider ? authEnvKeyForHostOrThrow(host) : undefined,
    label: opts.label,
    description: opts.description ?? `Forked from ${host}: ${opts.model}`,
  });
}

/** Auth env var for a host, as a hard error when the host declares none. */
function authEnvKeyForHostOrThrow(host: AgentId): string {
  const key = authEnvKeyForHost(host);
  if (!key) {
    throw new Error(`--auth-provider is set but host '${host}' has no known auth env var; it manages its own login.`);
  }
  return key;
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

A custom harness is its own agent type in 'agents view' — its own block beside Claude
and Codex, not a row indented under the host CLI that executes it.

Examples:
  # Meta Muse Spark 1.1 through OpenCode, called 'spark'
  agents harness add spark --host opencode --model meta/muse-spark-1.1
  agents run spark "refactor api/handlers/checkout.py"

  # Fork a native harness, or copy one of your own and swap the model
  agents harness fork opencode deepseek --model deepseek/deepseek-v4-flash-0731 --auth-provider openrouter
  agents harness fork deepseek deepseek-chat --model deepseek/deepseek-chat-v3

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
    .command('fork <source> <name>')
    .description('Fork a native harness (claude, opencode, ...) or an existing custom one into a new named harness.')
    .option('--model <id>', 'Model to pin on the fork (required when forking a native harness)')
    .option('--base-url <url>', 'Custom endpoint base URL (claude/codex hosts)')
    .option('--auth-provider <provider>', 'Attach a keychain-backed API key under this provider')
    .option('--version <version>', 'Pin the host CLI version (e.g., 1.16.0)')
    .option('--label <text>', 'Human-facing name shown by `agents view` (defaults to <name>)')
    .option('--description <text>', 'One-line description')
    .option('--key-stdin', 'Read the API key from stdin instead of prompting (for scripts/CI)')
    .option('--force', 'Overwrite an existing harness with the same name')
    .addHelpText(
      'after',
      `
Examples:
  # Fork OpenCode into a harness pinned to a DeepSeek model on OpenRouter
  agents harness fork opencode deepseek --model deepseek/deepseek-v4-flash-0731 --auth-provider openrouter

  # Fork Claude Code onto a private gateway
  agents harness fork claude corp --model gpt-x --base-url https://gw.corp/v1 --auth-provider corp

  # Copy an existing harness and swap only the model
  agents harness fork deepseek deepseek-chat --model deepseek/deepseek-chat-v3
`,
    )
    .action(async (source: string, name: string, opts: ForkOptions) => {
      try {
        validateProfileName(name);
        if (profileExists(name) && !opts.force) {
          throw new Error(`Harness '${name}' already exists. Use --force to overwrite.`);
        }
        // Build first so a bad source/flag combination fails before prompting
        // for a key the user would then have stored for nothing.
        const forked = buildFork(source, name, opts);
        if (opts.authProvider) await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
        writeProfile(forked);
        console.log(chalk.green(`Harness '${name}' forked from ${source}.`));
        console.log(chalk.gray(`Try: agents run ${name} "hello"`));
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
        renderHarnessDetail(name);
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

  cmd
    .command('edit <name>')
    .description('Edit a custom harness in place (model, label, description, base-url, version, fallback).')
    .option('--model <id>', 'Swap the pinned model (e.g., meta/muse-spark-2.0)')
    .option('--base-url <url>', 'Set or replace the endpoint base URL (claude/codex hosts). Empty string clears it.')
    .option('--label <text>', 'Set the display label shown by `agents view`. Empty string clears it (falls back to name).')
    .option('--description <text>', 'Set the description. Empty string clears it.')
    .option('--version <ver>', 'Pin the host CLI version. Empty string unpins (tracks latest).')
    .option('--fallback-model <id>', 'Set the fallback model. Empty string clears it.')
    .addHelpText(
      'after',
      `
Examples:
  # Upgrade the pinned model
  agents harness edit spark --model meta/muse-spark-2.0

  # Rename the display label without renaming the harness
  agents harness edit spark --label "Muse Spark 2.0"

  # Clear the display label (falls back to harness name)
  agents harness edit spark --label ""

  # Point to a new private endpoint
  agents harness edit corp --base-url https://gw.corp/v2

  # Set a fallback model for rate-limit resilience
  agents harness edit spark --fallback-model meta/muse-spark-lite
`,
    )
    .action((name: string, opts: EditProfileOptions) => {
      try {
        const changed = editProfile(name, opts);
        console.log(chalk.green(`Harness '${name}' updated.`));
        console.log(chalk.gray(`Model:  ${profileModelLabel(changed)}`));
        if (changed.label) console.log(chalk.gray(`Label:  ${changed.label}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('rename <name> <new-name>')
    .description('Rename a custom harness — updates the file name and its internal name field.')
    .addHelpText(
      'after',
      `
Examples:
  # Rename 'spark' to 'muse'
  agents harness rename spark muse

  # Rename then run under the new name
  agents harness rename deepseek ds && agents run ds "hello"
`,
    )
    .action((name: string, newName: string) => {
      try {
        renameProfile(name, newName);
        console.log(chalk.green(`Harness '${name}' renamed to '${newName}'.`));
        console.log(chalk.gray(`Run: agents run ${newName} "hello"`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
