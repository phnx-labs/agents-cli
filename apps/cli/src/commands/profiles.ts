/**
 * Profile management commands.
 *
 * Registers the `agents profiles` command tree for creating, viewing,
 * and removing named bundles of (host CLI, endpoint, model, keychain auth).
 * Profiles let users run non-default providers (Kimi, DeepSeek, Qwen, etc.)
 * through a standard agent CLI with no local proxy.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { readStdinSync } from '../lib/format.js';
import { spawn } from 'child_process';
import {
  listProfiles,
  readProfile,
  writeProfile,
  deleteProfile,
  profileExists,
  profileFromPreset,
  profileFromHostModel,
  baseUrlEnvKeyForHost,
  authEnvKeyForHost,
  validateProfileName,
  getPresetForProfile,
  type Profile,
} from '../lib/profiles.js';
import { getPreset, listPresets, expandPreset, type Preset } from '../lib/profiles-presets.js';
import type { AgentId } from '../lib/types.js';
import {
  hasKeychainToken,
  keychainItemName,
  setKeychainToken,
  deleteKeychainToken,
  getKeychainToken,
} from '../lib/secrets/profiles.js';
import { parseBundleValue, secretsKeychainItem } from '../lib/secrets/index.js';
import { readBundle } from '../lib/secrets/bundles.js';
import { isInteractiveTerminal } from './utils.js';
import { getAgentsInvocation } from '../lib/daemon/daemon.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import { findAccount } from '../lib/account-registry.js';

/**
 * Pure helper: builds a Profile from collected wizard inputs. Extracted so the
 * shape of preset->profile mapping for the `create` wizard is unit-testable
 * without mocking @inquirer/prompts.
 */
export function buildProfileFromCollection(
  name: string,
  preset: Preset,
  collected: Record<string, string>,
  version?: string,
): Profile {
  return {
    name,
    host: { agent: preset.host, version },
    env: { ...preset.env, ...collected },
    auth: {
      envVar: preset.authEnvVar,
      keychainItem: keychainItemName(preset.provider),
    },
    authOptional: preset.authOptional,
    description: preset.description,
    preset: preset.name,
    provider: preset.provider,
  };
}

/** Prompt the user for a secret value with masked input. Requires an interactive TTY. */
async function promptForSecret(message: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A secret is required but the shell is not interactive. Pipe the key via stdin (--key-stdin).');
  }
  const { password } = await import('@inquirer/prompts');
  return await password({ message, mask: true });
}

/** Read all available data from stdin synchronously, trimmed. */

/** Ensure a provider API key exists in keychain, prompting or reading stdin if missing. */
export async function ensureProviderToken(provider: string, signupUrl?: string, fromStdin?: boolean): Promise<void> {
  const item = keychainItemName(provider);
  if (hasKeychainToken(item)) {
    return;
  }
  let token: string;
  if (fromStdin) {
    token = readStdinSync();
    if (!token) {
      throw new Error('No key received on stdin.');
    }
  } else {
    const hint = signupUrl ? ` (get one at ${signupUrl})` : '';
    token = await promptForSecret(`Enter API key for ${provider}${hint}`);
  }
  setKeychainToken(item, token);
  console.log(chalk.green(`Stored in keychain: ${item}`));
}

/** Options accepted by {@link addProfile} — shared by `agents profiles add` and `agents harness add`. */
export interface AddProfileOptions {
  preset?: string;
  host?: string;
  model?: string;
  baseUrl?: string;
  authProvider?: string;
  account?: string;
  version?: string;
  keyStdin?: boolean;
  force?: boolean;
  /** `<bundle>` or `<bundle>:<key>` — see {@link applyFromSecrets}. */
  fromSecrets?: string;
}

/**
 * Copy a value from an `agents secrets` bundle into a profile's own keychain
 * item — a one-time copy, not a live link. `spec` is `<bundle>` or
 * `<bundle>:<key>`; the key is required only when the bundle has more than one.
 *
 * Reads the bundle value via {@link getKeychainToken} — this pops Touch ID on
 * macOS once, for that bundle-namespaced item (`agents-cli.secrets.*`, gated by
 * `keychainItemRequiresUserPresence` in `../lib/secrets/index.ts`) — then writes
 * it to `keychainItemName(provider)`, a plain `agents-cli.<provider>.token`
 * item. That item matches neither the `agents-cli.secrets.` nor
 * `agents-cli.bundles.` prefix, so every later read of the harness's own key is
 * silent — no repeat Touch ID prompt.
 *
 * Provider precedence: an explicit `--auth-provider` on the same call always
 * wins (freshest intent); otherwise, only when the profile already has a real
 * auth binding (`profile.auth` is set), its own `provider` (so editing an
 * already-provisioned harness rotates its existing key without repeating
 * `--auth-provider`); otherwise the bundle's own name. The `profile.auth`
 * gate matters because `profileFromHostModel`/`forkProfile` default
 * `profile.provider` to the *host* id (e.g. `claude`) even when no auth is
 * attached yet — trusting that default here would silently overwrite the
 * host's own keychain item (`agents-cli.claude.token`) on a bare `--host
 * --model --from-secrets` add with no `--auth-provider`.
 *
 * Attaches `profile.auth` when the profile has none yet (a bare `--host
 * --model` harness, or a native-host fork with no prior auth binding).
 *
 * `allowInheritedAuth` (default `true`) gates the "reuse `profile.auth`'s own
 * provider" branch above. It must be `false` when `profile` came from
 * **forking** an already-provisioned harness: `forkProfile` copies `auth` by
 * reference from the source when no `--auth-provider` override is given, so
 * `profile.auth` being set there means "the SOURCE harness's binding", not
 * "this harness's own" — trusting it would silently overwrite the source's
 * shared keychain item. Editing a harness's own already-established auth is
 * the one case where reuse is genuinely correct, so callers on that path keep
 * the default.
 */
export async function applyFromSecrets(
  profile: Profile,
  spec: string,
  explicitAuthProvider?: string,
  opts?: { allowInheritedAuth?: boolean },
): Promise<void> {
  const sep = spec.indexOf(':');
  const bundleName = sep === -1 ? spec : spec.slice(0, sep);
  const requestedKey = sep === -1 ? undefined : spec.slice(sep + 1);
  const bundle = readBundle(bundleName);
  const keys = Object.keys(bundle.vars);
  const key = requestedKey ?? (keys.length === 1 ? keys[0] : undefined);
  if (!key) {
    throw new Error(
      keys.length === 0
        ? `Bundle '${bundleName}' has no keys.`
        : `Bundle '${bundleName}' has ${keys.length} keys (${keys.join(', ')}); pick one with --from-secrets ${bundleName}:<key>.`,
    );
  }
  if (!(key in bundle.vars)) {
    throw new Error(`Bundle '${bundleName}' has no key '${key}'. Available: ${keys.join(', ') || '(none)'}.`);
  }

  const parsed = parseBundleValue(bundle.vars[key]);
  let value: string;
  if ('literal' in parsed) {
    value = parsed.literal;
  } else if (parsed.ref.provider === 'keychain') {
    value = getKeychainToken(secretsKeychainItem(bundle.name, parsed.ref.value));
  } else {
    throw new Error(
      `Bundle '${bundleName}' key '${key}' is a '${parsed.ref.provider}:' reference, not a keychain-backed secret — --from-secrets only copies keychain-backed values.`,
    );
  }

  if (profile.auth && !explicitAuthProvider && opts?.allowInheritedAuth === false) {
    throw new Error(
      `Harness '${profile.name}' inherited its auth binding from the harness it was forked from ` +
        `(provider '${profile.provider}') — pass --auth-provider <name> explicitly with --from-secrets ` +
        `on a fork, so it never silently overwrites the source harness's shared keychain item.`,
    );
  }
  const provider = explicitAuthProvider || (profile.auth ? profile.provider : undefined) || bundleName;
  const item = keychainItemName(provider);
  setKeychainToken(item, value);

  if (!profile.auth) {
    const envVar = authEnvKeyForHost(profile.host.agent);
    if (!envVar) {
      throw new Error(`Host '${profile.host.agent}' has no known auth env var; --from-secrets cannot attach auth to this harness.`);
    }
    profile.provider = provider;
    profile.auth = { envVar, keychainItem: item };
    profile.authOptional = false;
  }
}

/**
 * Create a profile ("custom harness"). Two paths:
 *  - `--host <agent> --model <id>`: one-shot custom harness from a host + model
 *    (no preset needed). This is what makes a model like Muse Spark a named,
 *    runnable harness.
 *  - otherwise: apply a built-in preset (existing behavior).
 * `label` only tunes the success wording (Profile vs Harness). Throws on error.
 */
export async function addProfile(name: string, opts: AddProfileOptions, label: 'Profile' | 'Harness' = 'Profile'): Promise<void> {
  validateProfileName(name);
  const account = opts.account ? findAccount(opts.account) : null;
  if (opts.account && !account) throw new Error(`Unknown account '${opts.account}'.`);
  if (profileExists(name) && !opts.force) {
    throw new Error(`${label} '${name}' already exists. Use --force to overwrite.`);
  }

  // One-shot host + model → custom harness, no preset required.
  if (opts.host || opts.model) {
    if (!opts.host || !opts.model) {
      throw new Error('Both --host <agent> and --model <id> are required to build a harness from a host + model.');
    }
    if (!ALL_AGENT_IDS.includes(opts.host as AgentId)) {
      throw new Error(`Unknown host '${opts.host}'. Valid hosts: ${ALL_AGENT_IDS.join(', ')}`);
    }
    const host = opts.host as AgentId;
    if (opts.baseUrl && !baseUrlEnvKeyForHost(host)) {
      console.error(chalk.yellow(`Note: --base-url has no known env var for host '${host}'; ignoring it.`));
    }

    let authEnvVar: string | undefined;
    if (opts.authProvider) {
      const key = authEnvKeyForHost(host);
      if (!key) {
        throw new Error(`--auth-provider is set but host '${host}' has no known auth env var. Use a preset or a hand-written profile YAML.`);
      }
      authEnvVar = key;
      if (!opts.fromSecrets) await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
    }

    const profile = profileFromHostModel(name, host, opts.model, {
      version: opts.version,
      baseUrl: opts.baseUrl,
      provider: opts.authProvider,
      authEnvVar,
    });
    if (account) {
      profile.account = account.id;
      profile.provider = account.provider;
    }
    if (opts.fromSecrets) await applyFromSecrets(profile, opts.fromSecrets, opts.authProvider);
    writeProfile(profile);
    console.log(chalk.green(`${label} '${name}' added — ${host} + ${opts.model}.`));
    console.log(chalk.gray(`Try: agents run ${name} "hello"`));
    return;
  }

  // Preset path.
  const presetName = opts.preset || name;
  const preset = getPreset(presetName);
  if (!preset) {
    throw new Error(
      `No preset '${presetName}'.\nAvailable presets: ${listPresets().map((p) => p.name).join(', ')}\n` +
        'Or build a custom harness: --host <agent> --model <id>.',
    );
  }
  if (!account && !opts.fromSecrets && !preset.authOptional) {
    await ensureProviderToken(preset.provider, preset.signupUrl, opts.keyStdin);
  }
  const profile = profileFromPreset(name, preset, opts.version);
  if (account) {
    profile.account = account.id;
    profile.provider = account.provider;
  }
  if (opts.fromSecrets) await applyFromSecrets(profile, opts.fromSecrets, opts.authProvider);
  writeProfile(profile);
  console.log(chalk.green(`${label} '${name}' added.`));
  console.log(chalk.gray(`Try: agents run ${name} "hello"`));
}

/** Format a single profile as a table row for the `profiles list` output. */
function renderProfileRow(p: ReturnType<typeof listProfiles>[number]): string {
  const host = p.host.version ? `${p.host.agent}@${p.host.version}` : p.host.agent;
  const model = p.env.ANTHROPIC_MODEL || p.env.OPENAI_MODEL || p.env.GEMINI_MODEL || '-';
  const provider = p.provider || (p.auth?.keychainItem?.split('.')[1]) || '-';
  return `${chalk.cyan(p.name.padEnd(16))} ${host.padEnd(14)} ${provider.padEnd(12)} ${chalk.gray(model)}`;
}

/** Register the `agents profiles` command tree. */
export function registerProfilesCommands(program: Command): void {
  const cmd = program
    .command('profiles')
    .description('Named bundles of (host CLI, endpoint, model, auth) — run Kimi/DeepSeek/Qwen/etc through Claude Code without a proxy.')
    .addHelpText(
      'after',
      `
A profile pins a host CLI (claude, codex, antigravity, ...) to a non-default endpoint
and model, with a keychain-backed API key. Running 'agents run <profile>' spawns
the host CLI with the right env vars — no plaintext tokens, no local proxy.

Built-in presets (via OpenRouter, one shared key):
  kimi       Kimi K2.5           (top HumanEval, reasoning — interactive only)
  kimi-chat  Kimi K2 0905        (non-reasoning, print-safe)
  minimax    MiniMax M2.5        (top SWE-bench, reasoning)
  glm        GLM 5               (top Chatbot Arena among open-weight, reasoning)
  qwen       Qwen3 Coder Next    (latest coding Qwen, print-safe)
  deepseek   DeepSeek Chat V3    (latest non-reasoning chat, print-safe)

Run 'agents profiles presets' for the full list with pricing and context sizes.

Typical flow:
  agents profiles create               # interactive wizard for any provider
  agents profiles add kimi             # one-line preset (existing)
  agents run kimi "refactor this"      # Claude Code UI, Kimi model responses
  agents profiles add deepseek         # reuses OpenRouter key, no re-prompt

Managing keys:
  agents profiles login openrouter     # rotate the key (shared across openrouter profiles)
  agents profiles logout openrouter    # remove from Keychain

Custom endpoints — drop a YAML file at ~/.agents/profiles/<name>.yml:
  name: local-llama
  host: { agent: claude }
  env:
    ANTHROPIC_BASE_URL: http://localhost:11434
    ANTHROPIC_MODEL: llama-3.3-70b
  auth:
    envVar: ANTHROPIC_AUTH_TOKEN
    keychainItem: agents-cli.ollama.token

Profiles store no secrets — safe to 'agents push' to a shared repo.

Examples:
  # One-time: store the OpenRouter key (every preset reuses it)
  agents profiles login openrouter

  # Add Kimi (top HumanEval) and run it through the Claude Code UI
  agents profiles add kimi
  agents run kimi "refactor api/handlers/checkout.py to use async sqlalchemy"

  # Add MiniMax for SWE-bench style fixes; reuses the same OpenRouter key
  agents profiles add minimax
  agents run minimax "investigate PROJ-456 and patch the off-by-one in pagination"

  # Add DeepSeek for cheap, fast non-reasoning work
  agents profiles add deepseek
  agents run deepseek "rename UserSession -> AuthSession across the codebase"

  # See every profile and which provider it talks to
  agents profiles list

  # Browse the catalog (pricing, context sizes, reasoning vs print-safe)
  agents profiles presets

  # Rotate the OpenRouter key (every openrouter profile picks it up)
  agents profiles login openrouter

  # Drop a profile, keep the key in Keychain for the next one
  agents profiles remove kimi

  # Fully remove the OpenRouter key from Keychain
  agents profiles logout openrouter
`,
    );

  cmd
    .command('list')
    .alias('ls')
    .description('List configured profiles')
    .action(() => {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        console.log(chalk.gray('No profiles configured.'));
        console.log(chalk.gray('Try: agents profiles add kimi'));
        console.log(chalk.gray('     agents profiles presets'));
        return;
      }
      console.log(chalk.bold(`${'NAME'.padEnd(16)} ${'HOST'.padEnd(14)} ${'PROVIDER'.padEnd(12)} MODEL`));
      for (const p of profiles) {
        console.log(renderProfileRow(p));
      }
    });

  cmd
    .command('presets')
    .description('List built-in presets (OpenRouter + direct providers)')
    .action(() => {
      const presets = listPresets();
      console.log(chalk.bold(`${'NAME'.padEnd(14)} ${'PROVIDER'.padEnd(12)} DESCRIPTION`));
      for (const p of presets) {
        console.log(`${chalk.cyan(p.name.padEnd(14))} ${p.provider.padEnd(12)} ${chalk.gray(p.description)}`);
      }
    });

  cmd
    .command('view <name>')
    .alias('show')
    .description('Show a profile (env, host, auth source, preset link)')
    .action((name: string) => {
      try {
        const p = readProfile(name);
        console.log(chalk.bold(p.name));
        if (p.description) console.log(chalk.gray(p.description));
        console.log();
        console.log(chalk.bold('Host:'), p.host.agent + (p.host.version ? `@${p.host.version}` : ''));
        if (p.provider) console.log(chalk.bold('Provider:'), p.provider);
        if (p.preset) console.log(chalk.bold('Preset:'), p.preset);
        console.log();
        console.log(chalk.bold('Env:'));
        for (const [k, v] of Object.entries(p.env)) {
          console.log(`  ${k}=${v}`);
        }
        if (p.auth) {
          console.log();
          console.log(chalk.bold('Auth:'));
          const tokenStatus = hasKeychainToken(p.auth.keychainItem) ? chalk.green('stored') : chalk.red('missing');
          console.log(`  ${p.auth.envVar} <- keychain:${p.auth.keychainItem} (${tokenStatus})`);
        }
        const preset = getPresetForProfile(p);
        if (preset?.signupUrl) {
          console.log();
          console.log(chalk.gray(`Sign up: ${preset.signupUrl}`));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('create')
    .description('Interactive profile creation wizard (any provider, with prompts for endpoints + keys).')
    .option('--name <name>', 'Profile name (skips the name prompt)')
    .option('--provider <provider>', 'Provider preset name (skips the provider prompt)')
    .option('--no-smoke-test', 'Skip the post-create smoke test prompt')
    .action(async (opts: { name?: string; provider?: string; smokeTest?: boolean }) => {
      if (!isInteractiveTerminal()) {
        console.error(
          chalk.red(
            'agents profiles create requires an interactive terminal. Use `agents profiles add <preset>` for scriptable creation.',
          ),
        );
        process.exit(1);
      }

      const { input, select, confirm } = await import('@inquirer/prompts');

      const name = opts.name
        ? opts.name
        : await input({
            message: 'Profile name',
            validate: (v) =>
              /^[a-z0-9][a-z0-9-_]{0,48}$/i.test(v) || 'lowercase alphanumeric + -_ only, max 48 chars',
          });
      validateProfileName(name);

      if (profileExists(name)) {
        const overwrite = await confirm({
          message: `Profile '${name}' already exists. Overwrite?`,
          default: false,
        });
        if (!overwrite) {
          console.log(chalk.gray('Cancelled.'));
          return;
        }
      }

      const presets = listPresets();
      const providerName = opts.provider
        ? opts.provider
        : await select({
            message: 'Provider',
            choices: presets.map((p) => ({
              name: `${p.name.padEnd(18)} ${chalk.gray(p.description.slice(0, 70))}`,
              value: p.name,
            })),
          });
      const preset = getPreset(providerName);
      if (!preset) {
        console.error(
          chalk.red(`Unknown provider '${providerName}'. Run 'agents profiles presets' for the list.`),
        );
        process.exit(1);
      }

      const expanded = expandPreset(preset);
      const collected: Record<string, string> = {};

      for (const v of expanded.prompts) {
        if (v.secret) {
          collected[v.envVar] = await promptForSecret(v.prompt);
        } else {
          const value = await input({
            message: v.hint ? `${v.prompt}  ${chalk.gray('(' + v.hint + ')')}` : v.prompt,
            default: v.default,
            validate: v.pattern
              ? (val: string) => new RegExp(v.pattern!).test(val) || `must match ${v.pattern}`
              : undefined,
          });
          collected[v.envVar] = value;
        }
      }

      if (!preset.authOptional) {
        await ensureProviderToken(preset.provider, preset.signupUrl);
      }

      const profile = buildProfileFromCollection(name, preset, collected);
      writeProfile(profile);
      console.log(chalk.green(`Profile '${name}' created.`));
      if (preset.docPath) {
        console.log(chalk.gray(`See docs/profiles/${preset.docPath}.md for provider-specific caveats.`));
      }

      if (opts.smokeTest !== false) {
        const run = await confirm({ message: 'Run smoke test now?', default: true });
        if (run) {
          console.log(
            chalk.gray(`Spawning: agents run ${name} "say alive in one word" (60s timeout)`),
          );
          const inv = getAgentsInvocation([
            'run',
            name,
            'say alive in one word',
            '--headless',
            '--timeout',
            '60s',
          ]);
          const child = spawn(inv.command, inv.args, { stdio: 'inherit' });
          child.on('exit', (code) => process.exit(code ?? 0));
        } else {
          console.log(chalk.gray(`Try later: agents run ${name} "hello"`));
        }
      }
    });

  cmd
    .command('add <name>')
    .description('Add a profile. If <name> matches a built-in preset, the preset is applied. Prompts for API key (once per provider).')
    .option('--preset <preset>', 'Use a named preset (defaults to <name> if a preset by that name exists)')
    .option('--version <version>', 'Pin the host CLI version (e.g., 2.1.113)')
    .option('--account <name>', 'Attach an existing durable credential account')
    .option('--key-stdin', 'Read API key from stdin instead of prompting (for scripts/CI)')
    .option('--force', 'Overwrite an existing profile with the same name')
    .addHelpText('after', '\nTo build a custom harness from a host CLI + model in one shot, use `agents harness add`.\n')
    .action(async (name: string, opts: AddProfileOptions) => {
      // Preset-only surface here — `--device` on `profiles` is reserved for remote
      // device routing (see lib/hosts/passthrough.ts). The host+model one-shot
      // lives on `agents harness add`, which owns its own `--host`.
      try {
        await addProfile(name, { preset: opts.preset, version: opts.version, account: opts.account, keyStdin: opts.keyStdin, force: opts.force }, 'Profile');
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('remove <name>')
    .alias('rm')
    .description('Delete a profile (keychain token is kept — use `profiles logout <provider>` to remove)')
    .action((name: string) => {
      const existed = deleteProfile(name);
      if (!existed) {
        console.error(chalk.red(`Profile '${name}' not found.`));
        process.exit(1);
      }
      console.log(chalk.green(`Profile '${name}' removed.`));
    });

  cmd
    .command('login <provider>')
    .description('Store or rotate the API key for a provider (e.g., openrouter). Shared across profiles using that provider.')
    .option('--key-stdin', 'Read API key from stdin')
    .action(async (provider: string, opts: { keyStdin?: boolean }) => {
      try {
        const item = keychainItemName(provider);
        let token: string;
        if (opts.keyStdin) {
          token = readStdinSync();
          if (!token) throw new Error('No key received on stdin.');
        } else {
          token = await promptForSecret(`Enter API key for ${provider}`);
        }
        setKeychainToken(item, token);
        console.log(chalk.green(`Stored in keychain: ${item}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('logout <provider>')
    .description('Remove a stored provider key from keychain')
    .action((provider: string) => {
      try {
        const item = keychainItemName(provider);
        const existed = deleteKeychainToken(item);
        if (!existed) {
          console.error(chalk.yellow(`No keychain item '${item}' to remove.`));
          process.exit(1);
        }
        console.log(chalk.green(`Removed keychain item: ${item}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
