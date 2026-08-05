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
import { addProfile, ensureProviderToken, applyFromSecrets, type AddProfileOptions } from './profiles.js';
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
  editProfile,
  renameProfile,
  profileFromHostModel,
  authEnvKeyForHost,
  getProfilePath,
  validateProfileName,
  editProfile,
  renameProfile,
  type Profile,
  type ForkProfileOptions,
} from '../lib/profiles.js';
import { listPresets, getPreset } from '../lib/profiles-presets.js';
import { listBundles } from '../lib/secrets/bundles.js';
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
  description?: string;
  /** `<bundle>` or `<bundle>:<key>` — see {@link applyFromSecrets} in ./profiles.js. */
  fromSecrets?: string;
  keyStdin?: boolean;
  force?: boolean;
}

/** Options accepted by `agents harness edit`. */
export interface EditOptions {
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  /** Empty string ('') unpins the host CLI version. */
  version?: string;
  description?: string;
  /** Empty string ('') clears the fallback model. */
  fallbackModel?: string;
  /** `<bundle>` or `<bundle>:<key>` — see {@link applyFromSecrets} in ./profiles.js. */
  fromSecrets?: string;
  keyStdin?: boolean;
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

/** Map `agents harness edit` flags onto {@link ForkProfileOptions} — the same
 * override shape `editProfile`/`forkProfile` apply. `--version ''` (unpin) is
 * handled by the caller ({@link buildEdit}), not here: `forkProfile`'s own
 * ternary treats an empty string as "no override" and would otherwise inherit
 * the source's version instead of clearing it. */
export function buildEditOverrides(opts: EditOptions): ForkProfileOptions {
  const overrides: ForkProfileOptions = {};
  if (opts.model !== undefined) overrides.model = opts.model;
  if (opts.baseUrl !== undefined) overrides.baseUrl = opts.baseUrl;
  if (opts.authProvider !== undefined) overrides.provider = opts.authProvider;
  if (opts.version) overrides.version = opts.version;
  if (opts.description !== undefined) overrides.description = opts.description;
  return overrides;
}

/** True when at least one recognized edit flag was given. */
export function hasEditFlags(opts: EditOptions): boolean {
  return (
    opts.model !== undefined ||
    opts.baseUrl !== undefined ||
    opts.authProvider !== undefined ||
    opts.version !== undefined ||
    opts.description !== undefined ||
    opts.fallbackModel !== undefined ||
    opts.fromSecrets !== undefined
  );
}

const EDIT_FLAGS_HELP =
  'No changes given. Available flags: --model, --base-url, --auth-provider, --version, --description, --fallback-model, --from-secrets.';

/**
 * Build the edited harness for `agents harness edit <name>` — the profile-shape
 * transform only; the caller applies `--from-secrets`/`--auth-provider` (async
 * keychain side effects) and persists with `writeProfile`. Mirrors
 * {@link buildFork}'s split between a pure builder and the action's IO.
 */
export function buildEdit(name: string, opts: EditOptions): Profile {
  if (!profileExists(name)) {
    throw new Error(`Harness '${name}' not found. Create it first: agents harness add ${name} ...`);
  }
  if (!hasEditFlags(opts)) {
    throw new Error(EDIT_FLAGS_HELP);
  }
  const source = readProfile(name);
  const edited = editProfile(source, buildEditOverrides(opts));
  if (opts.version === '') delete edited.host.version;
  if (opts.fallbackModel !== undefined) {
    if (opts.fallbackModel === '') delete edited.fallback_model;
    else edited.fallback_model = opts.fallbackModel;
  }
  return edited;
}

/** True when `agents harness fork` was given too little to proceed without the wizard. */
export function forkNeedsWizard(source: string | undefined, name: string | undefined, opts: ForkOptions): boolean {
  if (!source || !name) return true;
  if (!profileExists(source) && resolveAgentName(source) && !opts.model) return true;
  return false;
}

/** True when `agents harness add` was given too little to proceed without the wizard.
 * Mirrors {@link addProfile}'s own error condition in ./profiles.js so a bare
 * `agents harness add <preset-name>` (no flags) still resolves via the preset
 * fallback instead of being routed into the wizard. */
export function addNeedsWizard(name: string | undefined, opts: AddProfileOptions): boolean {
  if (!name) return true;
  if (opts.preset) return false;
  if (opts.host && opts.model) return false;
  if (opts.host || opts.model) return true;
  return !getPreset(name);
}

/**
 * Shared build+persist flow for a fork — used by `agents harness fork`'s
 * flag-driven path AND by the wizard (both for `fork` and, when it falls back
 * to the wizard, `add`), so a wizard run and a hand-written `fork` call build an
 * identical profile.
 */
async function runForkFlow(source: string, name: string, opts: ForkOptions): Promise<void> {
  validateProfileName(name);
  if (profileExists(name) && !opts.force) {
    throw new Error(`Harness '${name}' already exists. Use --force to overwrite.`);
  }
  // Build first so a bad source/flag combination fails before prompting for a
  // key (or copying one from a bundle) the user would then have stored for
  // nothing.
  const forked = buildFork(source, name, opts);
  if (opts.fromSecrets) {
    await applyFromSecrets(forked, opts.fromSecrets, opts.authProvider);
  } else if (opts.authProvider) {
    await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
  }
  writeProfile(forked);
  console.log(chalk.green(`Harness '${name}' forked from ${source}.`));
  console.log(chalk.gray(`Try: agents run ${name} "hello"`));
}

/** The first `_MODEL`-suffixed env var in a preset's static env block, if any. */
function presetModel(preset: ReturnType<typeof listPresets>[number]): string | undefined {
  return Object.entries(preset.env).find(([k]) => k.endsWith('_MODEL'))?.[1];
}

/**
 * Interactive `agents harness add`/`fork` wizard — runs when required info is
 * missing and stdout is a TTY (see {@link forkNeedsWizard}, {@link addNeedsWizard}).
 * Always resolves to the same `(source, name, opts)` shape {@link buildFork}
 * accepts via {@link runForkFlow}, so a wizard run and a hand-written fork call
 * build an identical profile.
 */
async function runHarnessWizard(): Promise<{ source: string; name: string; opts: ForkOptions }> {
  const { select, input } = await import('@inquirer/prompts');

  const customNames = listProfiles().map((p) => p.name);
  const source = await select<string>({
    message: 'Fork from',
    choices: [
      ...ALL_AGENT_IDS.map((id) => ({ name: `${AGENTS[id].name}  ${chalk.gray('(native)')}`, value: id as string })),
      ...customNames.map((n) => ({ name: `${n}  ${chalk.gray('(custom harness)')}`, value: n })),
    ],
  });

  const presets = listPresets();
  const CUSTOM = '__custom__';
  const presetChoice = await select<string>({
    message: 'Preset',
    choices: [
      ...presets.map((p) => ({ name: `${p.name}  ${chalk.gray(p.description.slice(0, 60))}`, value: p.name })),
      { name: 'Build custom (host + model + provider)', value: CUSTOM },
    ],
  });

  let model: string | undefined;
  let baseUrl: string | undefined;
  let authProvider: string | undefined;
  let defaultName = source;

  if (presetChoice === CUSTOM) {
    model = await input({ message: 'Model id' });
    const NO_AUTH = '__none__';
    const providers = [...new Set(presets.map((p) => p.provider))];
    const providerChoice = await select<string>({
      message: 'Provider',
      choices: [
        ...providers.map((p) => ({ name: p, value: p })),
        { name: 'no auth / host manages its own login', value: NO_AUTH },
      ],
    });
    authProvider = providerChoice === NO_AUTH ? undefined : providerChoice;
    const baseUrlInput = await input({ message: 'Base URL (optional)', default: '' });
    baseUrl = baseUrlInput || undefined;
  } else {
    const preset = getPreset(presetChoice)!;
    model = presetModel(preset);
    baseUrl = preset.env.ANTHROPIC_BASE_URL || preset.env.OPENAI_BASE_URL;
    authProvider = preset.authOptional ? undefined : preset.provider;
    // Pre-fill with the preset's own name (e.g. 'deepseek'), not a model
    // detail, so users aren't nudged toward baking one into the identity name.
    defaultName = preset.name;
  }

  const name = await input({
    message: 'Harness name',
    default: defaultName,
    validate: (v) => {
      try {
        validateProfileName(v);
        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });

  const opts: ForkOptions = { model, baseUrl, authProvider };

  if (authProvider) {
    const bundles = listBundles();
    const TYPE_NOW = 'type';
    const FROM_SECRETS = 'secrets';
    const keySource = bundles.length > 0
      ? await select<string>({
          message: `How should '${authProvider}' get its key?`,
          choices: [
            { name: 'Type a key now', value: TYPE_NOW },
            { name: 'Use an existing agents secrets bundle', value: FROM_SECRETS },
          ],
        })
      : TYPE_NOW;
    if (keySource === FROM_SECRETS) {
      const bundleName = await select<string>({
        message: 'Bundle',
        choices: bundles.map((b) => ({
          name: b.description ? `${b.name}  ${chalk.gray(b.description)}` : b.name,
          value: b.name,
        })),
      });
      const bundle = bundles.find((b) => b.name === bundleName)!;
      const keys = Object.keys(bundle.vars);
      const key = keys.length === 1
        ? keys[0]
        : await select<string>({ message: 'Key', choices: keys.map((k) => ({ name: k, value: k })) });
      opts.fromSecrets = `${bundleName}:${key}`;
    }
  }

  return { source, name, opts };
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

  # Edit a harness in place, or give it a new name
  agents harness edit deepseek --fallback-model deepseek/deepseek-chat-v3
  agents harness rename deepseek deepseek-classic

  # No args, in an interactive terminal: a wizard walks you through host, model, provider, key
  agents harness add

  # See custom harnesses, addable presets, and native harnesses
  agents harness list

  # Private OpenAI/Anthropic-compatible endpoint (stores a keychain key)
  agents harness add corp --host claude --model gpt-x --base-url https://gw.corp/v1 --auth-provider corp

  # Custom harnesses are just profiles — this also works via 'agents profiles'
`,
    );

  cmd
    .command('add [name]')
    .description('Create a custom harness from a host + model (or apply a built-in preset). Omit flags in a terminal for the interactive wizard.')
    .option('--host <agent>', 'Host CLI to run under (opencode, claude, codex, grok, antigravity, ...) — pair with --model')
    .option('--model <id>', 'Model id to pin on the host (e.g., meta/muse-spark-1.1) — pair with --host')
    .option('--base-url <url>', 'Custom endpoint base URL (claude/codex hosts)')
    .option('--auth-provider <provider>', 'Attach a keychain-backed API key under this provider (for private endpoints)')
    .option('--preset <preset>', 'Apply a built-in preset instead of --host/--model')
    .option('--version <version>', 'Pin the host CLI version (e.g., 1.16.0)')
    .option('--from-secrets <bundle>[:<key>]', "Copy a value from an agents secrets bundle into this harness's own keychain item, once (not a live link)")
    .option('--key-stdin', 'Read API key from stdin instead of prompting (for scripts/CI)')
    .option('--force', 'Overwrite an existing harness with the same name')
    .action(async (name: string | undefined, opts: AddProfileOptions & ForkOptions) => {
      try {
        if (addNeedsWizard(name, opts)) {
          if (!process.stdout.isTTY) {
            throw new Error(
              "'agents harness add' needs --preset or --host + --model (or a name and an interactive terminal for the wizard).",
            );
          }
          const wiz = await runHarnessWizard();
          await runForkFlow(wiz.source, wiz.name, { ...wiz.opts, force: opts.force, keyStdin: opts.keyStdin });
          return;
        }
        await addProfile(name!, opts, 'Harness');
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('fork [source] [name]')
    .description('Fork a native harness (claude, opencode, ...) or an existing custom one into a new named harness. Omit args in a terminal for the interactive wizard.')
    .option('--model <id>', 'Model to pin on the fork (required when forking a native harness)')
    .option('--base-url <url>', 'Custom endpoint base URL (claude/codex hosts)')
    .option('--auth-provider <provider>', 'Attach a keychain-backed API key under this provider')
    .option('--version <version>', 'Pin the host CLI version (e.g., 1.16.0)')
    .option('--description <text>', 'One-line description')
    .option('--from-secrets <bundle>[:<key>]', "Copy a value from an agents secrets bundle into this harness's own keychain item, once (not a live link)")
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

  # Copy a key out of an existing secrets bundle instead of typing it
  agents harness fork claude corp --model gpt-x --auth-provider corp --from-secrets prod:OPENROUTER_KEY

  # No args, in an interactive terminal: walks through source, preset/model, name, key
  agents harness fork
`,
    )
    .action(async (source: string | undefined, name: string | undefined, opts: ForkOptions) => {
      try {
        if (forkNeedsWizard(source, name, opts)) {
          if (!process.stdout.isTTY) {
            throw new Error("'agents harness fork' needs <source> and <name> (or an interactive terminal for the wizard).");
          }
          const wiz = await runHarnessWizard();
          await runForkFlow(wiz.source, wiz.name, { ...wiz.opts, force: opts.force, keyStdin: opts.keyStdin });
          return;
        }
        await runForkFlow(source!, name!, opts);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('edit <name>')
    .description('Edit an existing custom harness in place — model, endpoint, auth, version, description, fallback.')
    .option('--model <id>', 'Swap the pinned model')
    .option('--base-url <url>', 'Swap the custom endpoint base URL')
    .option('--auth-provider <provider>', 'Repoint auth at a different provider (keychain-backed)')
    .option('--version <version>', 'Re-pin the host CLI version (pass an empty string to unpin)')
    .option('--description <text>', 'Update the one-line description')
    .option('--fallback-model <id>', 'Secondary model retried on the same host on a rate limit (pass an empty string to clear it)')
    .option('--from-secrets <bundle>[:<key>]', "Copy a value from an agents secrets bundle into this harness's own keychain item, once (not a live link)")
    .option('--key-stdin', 'Read the API key from stdin instead of prompting (for scripts/CI)')
    .addHelpText(
      'after',
      `
Examples:
  # Swap the pinned model
  agents harness edit deepseek --model deepseek/deepseek-v3.2

  # Repoint auth at a different provider and re-enter the key
  agents harness edit corp --auth-provider corp2

  # Unpin the host CLI version
  agents harness edit spark --version ""

  # Add a same-host fallback model for rate-limit retries
  agents harness edit deepseek --fallback-model deepseek/deepseek-chat-v3

  # Copy a key out of an existing secrets bundle instead of typing it
  agents harness edit corp --from-secrets prod:OPENROUTER_KEY
`,
    )
    .action(async (name: string, opts: EditOptions) => {
      try {
        const edited = buildEdit(name, opts);
        if (opts.fromSecrets) {
          await applyFromSecrets(edited, opts.fromSecrets, opts.authProvider);
        } else if (opts.authProvider) {
          await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
        }
        writeProfile(edited);
        console.log(chalk.green(`Harness '${name}' updated.`));
        console.log(chalk.gray(`Try: agents run ${name} "hello"`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('rename <old-name> <new-name>')
    .description('Rename a custom harness (updates forkedFrom lineage on any harness forked from it). Errors on a name collision.')
    .action((oldName: string, newName: string) => {
      try {
        renameProfile(oldName, newName);
        console.log(chalk.green(`Harness '${oldName}' renamed to '${newName}'.`));
        console.log(chalk.gray(`Try: agents run ${newName} "hello"`));
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
    .description('Edit a custom harness in place (model, endpoint, host version, description).')
    // Flags mirror ForkProfileOptions exactly — `editProfile` reuses
    // `forkProfile`'s override logic, so anything it does not accept would be a
    // flag that parses and does nothing. There is deliberately no --label: the
    // header `agents view` prints is derived from the harness name.
    .option('--model <id>', 'Swap the pinned model (e.g., meta/muse-spark-2.0)')
    .option('--base-url <url>', 'Set or replace the endpoint base URL (claude/codex hosts)')
    .option('--version <ver>', 'Re-pin the host CLI version. Empty string unpins (tracks latest).')
    .option('--description <text>', 'Set the one-line description')
    .addHelpText(
      'after',
      `
Examples:
  # Upgrade the pinned model
  agents harness edit spark --model meta/muse-spark-2.0

  # Point to a new private endpoint
  agents harness edit corp --base-url https://gw.corp/v2

  # Track the host's latest instead of a pinned version
  agents harness edit spark --version ""

  # The display name is derived from the harness name, so to change it, rename:
  agents harness rename spark muse-spark
`,
    )
    .action((name: string, opts: ForkProfileOptions) => {
      try {
        const edited = editProfile(readProfile(name), opts);
        writeProfile(edited);
        console.log(chalk.green(`Harness '${name}' updated.`));
        console.log(chalk.gray(`Model:  ${profileModelLabel(edited)}`));
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
