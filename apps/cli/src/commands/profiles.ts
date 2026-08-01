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
} from '../lib/secrets/profiles.js';
import { isInteractiveTerminal } from './utils.js';
import { getAgentsInvocation } from '../lib/daemon.js';
import {
  getActiveResourceProfileName,
  getResourceProfilePreset,
  listResourceProfileNames,
  setActiveResourceProfile,
  upsertResourceProfilePreset,
  validateResourceProfileName,
  type PatternedProfileKind,
} from '../lib/resource-profiles.js';
import { AGENTS, ALL_AGENT_IDS } from '../lib/agents.js';
import { listInstalledVersions, syncResourcesToVersion } from '../lib/versions.js';
import type { ResourceProfilePreset } from '../lib/types.js';

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
async function ensureProviderToken(provider: string, signupUrl?: string, fromStdin?: boolean): Promise<void> {
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
  version?: string;
  keyStdin?: boolean;
  force?: boolean;
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
      await ensureProviderToken(opts.authProvider, undefined, opts.keyStdin);
    }

    const profile = profileFromHostModel(name, host, opts.model, {
      version: opts.version,
      baseUrl: opts.baseUrl,
      provider: opts.authProvider,
      authEnvVar,
    });
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
  if (!preset.authOptional) {
    await ensureProviderToken(preset.provider, preset.signupUrl, opts.keyStdin);
  }
  const profile = profileFromPreset(name, preset, opts.version);
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

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function buildResourceProfileFromOptions(
  existing: ResourceProfilePreset | null,
  opts: Record<string, string | undefined>,
): ResourceProfilePreset {
  const next: ResourceProfilePreset = { ...(existing ?? {}) };
  if (opts.description !== undefined) next.description = opts.description || undefined;
  const keys: PatternedProfileKind[] = ['commands', 'skills', 'hooks', 'subagents', 'plugins', 'workflows', 'permissions', 'mcp'];
  for (const key of keys) {
    const parsed = splitList(opts[key]);
    if (parsed !== undefined) next[key] = parsed;
  }
  const secrets = splitList(opts.secrets);
  if (secrets !== undefined) next.secrets = secrets;
  if (opts.rules !== undefined) next.rules = opts.rules || undefined;
  return next;
}

function printResourceProfile(name: string, preset: ResourceProfilePreset, activeName: string | null): void {
  const activeMark = activeName === name ? '*' : ' ';
  const description = preset.description ? `  ${chalk.gray(preset.description)}` : '';
  console.log(`${activeMark} ${chalk.cyan(name)}${description}`);
}

function syncInstalledVersionsForActiveProfile(cwd: string): number {
  let synced = 0;
  for (const agent of Object.keys(AGENTS) as Array<keyof typeof AGENTS>) {
    for (const version of listInstalledVersions(agent)) {
      syncResourcesToVersion(agent, version, undefined, { cwd, force: true });
      synced++;
    }
  }
  return synced;
}

function registerResourceProfileCommands(program: Command): void {
  const cmd = program
    .command('profile')
    .description('Activate top-level resource profiles across commands, skills, hooks, rules, MCP, permissions, and secrets.');

  cmd
    .command('list')
    .alias('ls')
    .description('List top-level resource profiles')
    .action(() => {
      const names = listResourceProfileNames();
      if (names.length === 0) {
        console.log(chalk.gray('No resource profiles configured.'));
        console.log(chalk.gray('Try: agents profile set work --skills user:code-review --secrets work'));
        return;
      }
      const active = getActiveResourceProfileName();
      for (const name of names) {
        printResourceProfile(name, getResourceProfilePreset(name)!, active);
      }
    });

  cmd
    .command('status')
    .description('Show the active top-level resource profile')
    .action(() => {
      const active = getActiveResourceProfileName();
      if (!active) {
        console.log(chalk.gray('No resource profile active.'));
        return;
      }
      const preset = getResourceProfilePreset(active);
      console.log(chalk.bold(active));
      if (!preset) {
        console.log(chalk.red('Configured active profile is missing from profiles.presets.'));
        return;
      }
      if (preset.description) console.log(chalk.gray(preset.description));
      for (const [key, value] of Object.entries(preset)) {
        if (key === 'description') continue;
        console.log(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
    });

  cmd
    .command('set <name>')
    .alias('define')
    .description('Create or update a top-level resource profile')
    .option('--description <text>', 'Free-form description')
    .option('--commands <patterns>', 'Comma-separated command selectors, e.g. system:commit,user:*')
    .option('--skills <patterns>', 'Comma-separated skill selectors')
    .option('--hooks <patterns>', 'Comma-separated hook selectors')
    .option('--subagents <patterns>', 'Comma-separated subagent selectors')
    .option('--plugins <patterns>', 'Comma-separated plugin selectors')
    .option('--workflows <patterns>', 'Comma-separated workflow selectors')
    .option('--permissions <patterns>', 'Comma-separated permission group selectors')
    .option('--mcp <patterns>', 'Comma-separated MCP server selectors')
    .option('--rules <preset>', 'Rules preset to compose while active')
    .option('--secrets <names>', 'Comma-separated secrets bundles, or "*"')
    .action((name: string, opts: Record<string, string | undefined>) => {
      try {
        validateResourceProfileName(name);
        const preset = buildResourceProfileFromOptions(getResourceProfilePreset(name), opts);
        upsertResourceProfilePreset(name, preset);
        console.log(chalk.green(`Profile '${name}' saved.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('use <name>')
    .description('Activate a top-level resource profile and reconcile installed versions')
    .action((name: string) => {
      try {
        setActiveResourceProfile(name);
        const synced = syncInstalledVersionsForActiveProfile(process.cwd());
        console.log(chalk.green(`Profile '${name}' active.`));
        console.log(chalk.gray(`Reconciled ${synced} installed version${synced === 1 ? '' : 's'}.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('clear')
    .description('Clear the active top-level resource profile and reconcile installed versions')
    .action(() => {
      setActiveResourceProfile(null);
      const synced = syncInstalledVersionsForActiveProfile(process.cwd());
      console.log(chalk.green('Resource profile cleared.'));
      console.log(chalk.gray(`Reconciled ${synced} installed version${synced === 1 ? '' : 's'}.`));
    });
}

/** Register the `agents profiles` command tree. */
export function registerProfilesCommands(program: Command): void {
  registerResourceProfileCommands(program);

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
    .command('use <name>')
    .description('Alias for `agents profile use <name>`')
    .action((name: string) => {
      try {
        setActiveResourceProfile(name);
        const synced = syncInstalledVersionsForActiveProfile(process.cwd());
        console.log(chalk.green(`Profile '${name}' active.`));
        console.log(chalk.gray(`Reconciled ${synced} installed version${synced === 1 ? '' : 's'}.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('status')
    .description('Alias for `agents profile status`')
    .action(() => {
      const active = getActiveResourceProfileName();
      console.log(active ? active : chalk.gray('No resource profile active.'));
    });

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
    .option('--key-stdin', 'Read API key from stdin instead of prompting (for scripts/CI)')
    .option('--force', 'Overwrite an existing profile with the same name')
    .addHelpText('after', '\nTo build a custom harness from a host CLI + model in one shot, use `agents harness add`.\n')
    .action(async (name: string, opts: AddProfileOptions) => {
      // Preset-only surface here — `--host` on `profiles` is reserved for remote
      // device routing (see lib/hosts/passthrough.ts). The host+model one-shot
      // lives on `agents harness add`, which owns its own `--host`.
      try {
        await addProfile(name, { preset: opts.preset, version: opts.version, keyStdin: opts.keyStdin, force: opts.force }, 'Profile');
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
