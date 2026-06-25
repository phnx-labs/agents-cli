/**
 * Secrets bundle management commands.
 *
 * Registers the `agents secrets` command tree for creating, viewing,
 * and managing named bundles of environment variables backed by macOS
 * Keychain. Bundles are injected at run time via `agents run --secrets`.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import {
  bundleExists,
  deleteBundle,
  describeBundle,
  keychainItemsForBundle,
  keychainRef,
  listBundles,
  migrateLegacyBundles,
  parseDotenv,
  readBundle,
  renameBundle,
  rotateBundleSecret,
  validateBundleName,
  validateEnvKey,
  validateExpiresFutureDated,
  validateSecretType,
  writeBundle,
  type SecretsBundle,
  type VarMeta,
} from '../lib/secrets/bundles.js';
import {
  deleteKeychainToken,
  getKeychainToken,
  getKeychainTokens,
  hasKeychainToken,
  secretsKeychainItem,
  setKeychainToken,
} from '../lib/secrets/index.js';
import {
  assertOpAvailable,
  createPasswordItem,
  deleteItemByTitle,
  extractSecrets,
  itemExistsByTitle,
  listItems,
  listVaults,
  type OpVault,
} from '../lib/onepassword.js';
import { registerCommandGroups, setHelpSections } from '../lib/help.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { registerSecretsSyncCommands } from './secrets-sync.js';
import { registerSecretsMigrateAclCommand } from './secrets-migrate.js';

/** Prompt the user for a secret value with masked input. Requires an interactive TTY. */
async function promptForSecret(message: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A secret is required but the shell is not interactive. Pass --value, --value-stdin, or run from a TTY.');
  }
  const { password } = await import('@inquirer/prompts');
  return await password({ message, mask: true });
}

/** Prompt the user to pick an existing bundle by name. Requires an interactive TTY. */
async function pickBundleName(action: string): Promise<string> {
  const bundles = listBundles();
  if (bundles.length === 0) {
    throw new Error('No secrets bundles configured. Try: agents secrets create <name>');
  }
  if (!isInteractiveTerminal()) {
    throw new Error('A bundle name is required. Pass it as an argument or run from a TTY.');
  }
  const { select } = await import('@inquirer/prompts');
  return await select({
    message: `Which bundle to ${action}?`,
    choices: bundles.map((b) => ({
      name: b.name,
      value: b.name,
      description: b.description || undefined,
    })),
  });
}

/** Prompt the user to type a new bundle name. Requires an interactive TTY. */
async function promptBundleName(): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A bundle name is required. Pass it as an argument or run from a TTY.');
  }
  const { input } = await import('@inquirer/prompts');
  return await input({
    message: 'Bundle name',
    validate: (value: string) => {
      try {
        validateBundleName(value);
        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });
}

/** Prompt the user to pick an existing key from a bundle. Requires an interactive TTY. */
async function pickKey(bundle: SecretsBundle, action: string): Promise<string> {
  const keys = Object.keys(bundle.vars);
  if (keys.length === 0) {
    throw new Error(`Bundle '${bundle.name}' has no keys.`);
  }
  if (!isInteractiveTerminal()) {
    throw new Error('A key name is required. Pass it as an argument or run from a TTY.');
  }
  const { select } = await import('@inquirer/prompts');
  return await select({
    message: `Which key to ${action}?`,
    choices: keys.map((k) => ({ name: k, value: k })),
  });
}

/** Prompt the user to type a new key name for a bundle. Requires an interactive TTY. */
async function promptKeyName(bundleName: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A key name is required. Pass it as an argument or run from a TTY.');
  }
  const { input } = await import('@inquirer/prompts');
  return await input({
    message: `Key name to add to '${bundleName}'`,
    validate: (value: string) => {
      try {
        validateEnvKey(value);
        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });
}

/** Resolve a 1Password vault name — use the provided value, or prompt interactively. */
async function resolveVault(vaultOpt: string | undefined): Promise<string> {
  if (vaultOpt) return vaultOpt;
  const vaults: OpVault[] = listVaults();
  if (vaults.length === 0) throw new Error('No 1Password vaults found. Make sure you are signed in: op signin');
  if (vaults.length === 1) return vaults[0].name;
  if (!isInteractiveTerminal()) {
    throw new Error(`Multiple vaults found. Pass --vault <name> (available: ${vaults.map((v) => v.name).join(', ')})`);
  }
  const { select } = await import('@inquirer/prompts');
  return await select({
    message: 'Which 1Password vault?',
    choices: vaults.map((v) => ({ name: v.name, value: v.name })),
  });
}

/** Read all available data from stdin synchronously, trimmed. */
function readStdinSync(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * SSH target for `export --to-ssh`: a bare ssh-config host alias (e.g. `yosemite-s0`)
 * or `user@host`. The strict allowlist blocks shell metacharacters and a leading `-`
 * so a target can't be smuggled in as an ssh argv flag.
 */
export const SSH_TARGET_RE = /^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/;

export function assertValidSshTarget(host: string): void {
  if (!SSH_TARGET_RE.test(host)) {
    throw new Error(`Invalid SSH target ${JSON.stringify(host)}. Expected a host alias or user@host (letters, digits, '.', '_', '-').`);
  }
}

/** POSIX single-quote a string for safe interpolation into a remote shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Serialize a resolved env map to `.env` lines that round-trip losslessly through
 * `parseDotenv` on the remote: `KEY="VALUE"`. parseDotenv strips exactly one outer
 * quote pair and takes the inner bytes verbatim (no unescaping), so any single-line
 * value survives unchanged with no escaping. Newlines would break its line-based
 * parse, so multi-line values are rejected rather than silently corrupted.
 */
export function bundleEnvToDotenv(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (/[\r\n]/.test(v)) {
      throw new Error(
        `Key '${k}' has a multi-line value; the SSH .env transport can't carry newlines. ` +
        `Set it directly on the remote with 'agents secrets add ${k} --value-stdin'.`,
      );
    }
    lines.push(`${k}="${v}"`);
  }
  return lines.join('\n') + '\n';
}

/** Strip ANSI escape sequences so padding can be computed on visible width. */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** padEnd that respects ANSI color codes (chalk-wrapped strings have invisible bytes). */
function padVisible(s: string, n: number): string {
  const w = visibleWidth(s);
  if (w >= n) return s;
  return s + ' '.repeat(n - w);
}

/** Render an ISO-8601 timestamp as a compact relative age: "now", "5m", "1h", "3d", "2w", "4mo", "1y". */
function relativeAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  const deltaMs = Date.now() - t;
  if (deltaMs < 0) return 'now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  if (day < 30) return `${Math.floor(day / 7)}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}

/** Long-form relative age for the `view` command. "now" stays as "now"; otherwise appends " ago". */
function humanAge(iso: string): string {
  const age = relativeAge(iso);
  if (age === 'now' || age === '-') return age;
  return `${age} ago`;
}

/** Format a single bundle as a table row for the `secrets list` output. */
function renderBundleRow(b: SecretsBundle): string {
  const entries = describeBundle(b);
  const keys = entries.length;
  const expiringCount = countExpiringSoon(b.meta);
  const expiring = expiringCount > 0 ? chalk.yellow(String(expiringCount)) : chalk.gray('-');
  // Timestamp distinction:
  //   "?"     -> legacy bundle, never written under the timestamping code.
  //   "never" -> bundle has been written but the action never happened
  //              (currently only used for USED — CREATED/UPDATED are always
  //              set together by writeBundle).
  //   <age>   -> real data.
  const created = b.created_at ? relativeAge(b.created_at) : chalk.gray('?');
  const updated = b.updated_at ? relativeAge(b.updated_at) : chalk.gray('?');
  const used = b.last_used
    ? relativeAge(b.last_used)
    : (b.created_at ? chalk.gray('never') : chalk.gray('?'));
  const head =
    `${chalk.cyan(b.name.padEnd(20))} ` +
    `${String(keys).padEnd(5)} ` +
    `${padVisible(expiring, 9)} ` +
    `${padVisible(created, 9)} ` +
    `${padVisible(updated, 9)} ` +
    `${padVisible(used, 7)}`;
  return b.description ? `${head} ${chalk.gray(safePrint(b.description))}` : head.trimEnd();
}

/** Colorize a variable source kind (literal, keychain, env, file, exec). */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'literal': return chalk.gray('literal');
    case 'keychain': return chalk.green('keychain');
    case 'env': return chalk.blue('env');
    case 'file': return chalk.magenta('file');
    case 'exec': return chalk.red('exec');
    default: return kind;
  }
}

/** Mask a value with asterisks unless reveal is true. */
function redact(value: string, reveal: boolean): string {
  if (reveal) return value;
  if (!value) return '';
  return '*'.repeat(Math.min(value.length, 8));
}

/**
 * Strip ASCII / C1 control bytes from a string before printing it to the
 * terminal. Bundle descriptions, notes, and remote-supplied names can carry
 * arbitrary text and a malicious value containing ANSI escape sequences (e.g.
 * OSC 52 clipboard set, screen-clear, cursor moves) would otherwise be
 * interpreted by the user's terminal. Allow tab and newline so multi-line
 * notes still render; strip everything else in the C0/C1 ranges plus DEL.
 */
function safePrint(s: string): string {
  return s.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');
}

/**
 * Build a VarMeta patch from CLI flags. Validates each provided field. Returns
 * undefined if no meta flag was passed (so callers know to skip meta updates).
 *
 * `--note -` reads the note from stdin so users can pass long/multi-line notes
 * without shell-escaping. It's mutually exclusive with `--value-stdin`; both
 * trying to consume stdin would race and silently corrupt one or the other.
 */
function buildMetaPatch(
  raw: { type?: string; expires?: string; note?: string; valueStdin?: boolean },
): Partial<VarMeta> | undefined {
  if (raw.type === undefined && raw.expires === undefined && raw.note === undefined) {
    return undefined;
  }
  const patch: Partial<VarMeta> = {};
  if (raw.type !== undefined) {
    validateSecretType(raw.type);
    patch.type = raw.type;
  }
  if (raw.expires !== undefined) {
    validateExpiresFutureDated(raw.expires);
    patch.expires = raw.expires;
  }
  if (raw.note !== undefined) {
    if (raw.note === '-') {
      if (raw.valueStdin) {
        throw new Error('--note - and --value-stdin both want stdin; only one can read it.');
      }
      const fromStdin = readStdinSync();
      if (!fromStdin) throw new Error('No note received on stdin.');
      patch.note = fromStdin;
    } else {
      patch.note = raw.note;
    }
  }
  return patch;
}

/** Whole days from now until midnight-UTC of the given ISO date. Negative if past. */
function daysUntil(iso: string): number {
  const target = new Date(iso + 'T23:59:59Z').getTime();
  const now = Date.now();
  return Math.floor((target - now) / (24 * 60 * 60 * 1000));
}

/** Render the meta line under a var, indented. Returns empty string if nothing to show. */
function renderMetaLine(meta: VarMeta | undefined, reveal: boolean): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.type) parts.push(`type: ${meta.type}`);
  if (meta.expires) {
    const days = daysUntil(meta.expires);
    const tail = `(in ${days} days)`;
    let colored: string;
    if (days < 0) {
      colored = chalk.red(`expires: ${meta.expires} ${tail}`);
    } else if (days < 30) {
      colored = chalk.yellow(`expires: ${meta.expires} ${tail}`);
    } else {
      colored = chalk.gray(`expires: ${meta.expires} ${tail}`);
    }
    parts.push(colored);
  }
  if (meta.note) {
    let note = safePrint(meta.note);
    if (!reveal && note.length > 80) {
      note = note.slice(0, 79) + '\u2026';
    }
    parts.push(`note: ${note}`);
  }
  if (parts.length === 0) return '';
  return `    ${parts.join('  ')}`;
}

/** Count entries in `meta` whose `expires` falls in the next 30 days. */
function countExpiringSoon(meta: Record<string, VarMeta> | undefined): number {
  if (!meta) return 0;
  let n = 0;
  for (const m of Object.values(meta)) {
    if (!m.expires) continue;
    const d = daysUntil(m.expires);
    if (d >= 0 && d < 30) n++;
  }
  return n;
}

/** Register the `agents secrets` command tree. */
export function registerSecretsCommands(program: Command): void {
  const cmd = program
    .command('secrets')
    .description('Named bundles of env variables backed by macOS Keychain (device-local, biometry-gated). Inject into agents via `agents run --secrets <name>`.');

  setHelpSections(cmd, {
    examples: `
      # Create a bundle
      agents secrets create prod --description "Production keys for the api stack"

      # Add a keychain-backed secret (prompts for the value)
      agents secrets add prod STRIPE_API_KEY

      # Add a non-sensitive literal
      agents secrets add prod LOG_LEVEL --value info

      # Inject the bundle into an agent run
      agents run claude "deploy the worker" --secrets prod

      # See what's in the bundle (values masked)
      agents secrets view prod

      # Eval the bundle into your current shell
      eval "$(agents secrets export prod --plaintext)"

      # Push the bundle to remote machine(s) over SSH (lands as a native bundle there)
      agents secrets export prod --to-ssh --host yosemite-s0 --host yosemite-s1 --force

      # Run a one-off command with secrets injected
      agents secrets exec prod -- ./deploy.sh
    `,
    notes: `
      Bundles are containers; secrets are the variables inside them. Keychain values
      never touch disk in plaintext. Every item is device-local and gated by Touch ID
      or device passcode; cross-machine sync is handled by 'agents secrets push/pull'.

      See also:
        agents secrets rotate <bundle> <key>           rotate value, preserve metadata
        agents secrets import <bundle> --from .env     bulk import from .env
        agents secrets import <bundle> --from-1password --vault <name>
        agents secrets generate [length]               generate a random password / PIN / hex
        agents secrets migrate-acl                     upgrade legacy items to the biometry ACL
    `,
  });

  registerCommandGroups(cmd, [
    { title: 'Bundle commands', names: ['list', 'view', 'create', 'rename', 'describe', 'delete'] },
    { title: 'Secret commands', names: ['add', 'rotate', 'remove', 'import', 'export'] },
    { title: 'Raw item commands', names: ['get', 'set'] },
    { title: 'Sync commands', names: ['push', 'pull', 'remote-list'] },
    { title: 'Utilities', names: ['exec', 'generate', 'migrate-acl'] },
  ]);

  cmd
    .command('list')
    .alias('ls')
    .description('List configured secrets bundles')
    .action(() => {
      const bundles = listBundles();
      if (bundles.length === 0) {
        console.log(chalk.gray('No secrets bundles configured.'));
        console.log(chalk.gray('Try: agents secrets create <name>'));
        return;
      }
      console.log(chalk.bold(
        `${'NAME'.padEnd(20)} ${'KEYS'.padEnd(5)} ${'EXPIRING'.padEnd(9)} ${'CREATED'.padEnd(9)} ${'UPDATED'.padEnd(9)} ${'USED'.padEnd(7)} DESCRIPTION`,
      ));
      for (const b of bundles) {
        console.log(renderBundleRow(b));
      }
    });

  cmd
    .command('view [name]')
    .alias('show')
    .description('Show a bundle. Keychain values are masked by default — pass --reveal to see them.')
    .option('--reveal', 'Print keychain-backed values in the clear (TTY only unless --plaintext)')
    .option('--plaintext', 'Allow --reveal in non-interactive shells (use with care)')
    .action(async (name: string | undefined, opts: { reveal?: boolean; plaintext?: boolean }) => {
      try {
        const resolvedName = name ?? (await pickBundleName('view'));
        const bundle = readBundle(resolvedName);
        const entries = describeBundle(bundle);
        console.log(chalk.bold(bundle.name));
        if (bundle.description) console.log(chalk.gray(safePrint(bundle.description)));
        if (bundle.allow_exec) console.log(chalk.yellow('allow_exec: true'));
        if (bundle.created_at) console.log(chalk.gray(`created_at: ${bundle.created_at} (${humanAge(bundle.created_at)})`));
        if (bundle.updated_at) console.log(chalk.gray(`updated_at: ${bundle.updated_at} (${humanAge(bundle.updated_at)})`));
        if (bundle.last_used) console.log(chalk.gray(`last_used:  ${bundle.last_used} (${humanAge(bundle.last_used)})`));
        console.log();
        if (entries.length === 0) {
          console.log(chalk.gray('(no keys)'));
          return;
        }
        const reveal = Boolean(opts.reveal);
        if (reveal && !isInteractiveTerminal() && !opts.plaintext) {
          console.error(chalk.red('--reveal in a non-TTY requires --plaintext.'));
          process.exit(1);
        }
        // Batch every keychain read into one helper call so --reveal pops
        // Touch ID once for the whole bundle instead of once per key.
        const revealedValues = new Map<string, string>();
        if (reveal) {
          const items = entries
            .filter((e) => e.kind === 'keychain')
            .map((e) => secretsKeychainItem(bundle.name, e.detail));
          try {
            const fetched = getKeychainTokens(items);
            for (const [item, value] of fetched) revealedValues.set(item, value);
          } catch {
            // Fall through to masked output on cancellation / batch failure.
          }
        }
        for (const e of entries) {
          if (e.kind === 'keychain') {
            const item = secretsKeychainItem(bundle.name, e.detail);
            const stored = hasKeychainToken(item);
            const marker = stored ? chalk.green('stored') : chalk.red('missing');
            let valueCol = `[keychain:${e.detail}] ${marker}`;
            if (reveal && revealedValues.has(item)) {
              valueCol = redact(revealedValues.get(item)!, true);
            }
            console.log(`  ${chalk.cyan(e.key.padEnd(28))} ${kindLabel(e.kind).padEnd(18)} ${valueCol}`);
          } else if (e.kind === 'literal') {
            const raw = bundle.vars[e.key];
            const literalValue =
              typeof raw === 'string'
                ? raw
                : (raw && typeof raw === 'object' && 'value' in raw ? (raw as any).value : '');
            console.log(`  ${chalk.cyan(e.key.padEnd(28))} ${kindLabel(e.kind).padEnd(18)} ${redact(literalValue, reveal)}`);
          } else {
            console.log(`  ${chalk.cyan(e.key.padEnd(28))} ${kindLabel(e.kind).padEnd(18)} ${e.detail}`);
          }
          const metaLine = renderMetaLine(bundle.meta?.[e.key], reveal);
          if (metaLine) console.log(metaLine);
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('get <item>')
    .description('Print a raw keychain item by name (for shell hooks/automation). Cross-platform; no bundle required.')
    .action((item: string) => {
      try {
        // Routes through the platform keychain layer: macOS reads bare items
        // via /usr/bin/security (no Touch ID), Linux via secret-tool with the
        // encrypted-file fallback. The value goes to stdout (newline-terminated
        // so `$(agents secrets get NAME)` captures it cleanly); diagnostics go
        // to stderr so they never pollute the captured value.
        const value = getKeychainToken(item);
        process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
      } catch {
        // Missing item is a normal, quiet outcome for a hook probe: exit 1,
        // print nothing to stdout. Callers test the exit code / empty capture.
        process.exit(1);
      }
    });

  cmd
    .command('set <item>')
    .description('Store a raw keychain item by name (for shell hooks/automation). Cross-platform; no bundle required.')
    .option('--value <v>', 'Value to store (omit to read from stdin or be prompted)')
    .option('--value-stdin', 'Read the value from stdin')
    .action(async (item: string, opts: { value?: string; valueStdin?: boolean }) => {
      try {
        let value: string;
        if (opts.value !== undefined) {
          value = opts.value;
        } else if (opts.valueStdin) {
          value = readStdinSync();
          if (!value) throw new Error('No value received on stdin.');
        } else {
          value = await promptForSecret(`Enter value for ${item}`);
        }
        // setKeychainToken stores bare items WITHOUT the biometry ACL on macOS
        // so `agents secrets get` can read them back without a password sheet;
        // on Linux it goes through secret-tool / encrypted-file fallback.
        setKeychainToken(item, value);
        console.error(chalk.green(`Stored keychain item '${item}'.`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('create [name]')
    .description('Create an empty bundle')
    .option('--description <text>', 'Free-form description')
    .option('--allow-exec', 'Allow exec: refs in this bundle (off by default)')
    .option('--force', 'Overwrite an existing bundle')
    .action(async (name: string | undefined, opts: { description?: string; allowExec?: boolean; force?: boolean }) => {
      try {
        const resolvedName = name ?? (await promptBundleName());
        validateBundleName(resolvedName);
        if (bundleExists(resolvedName) && !opts.force) {
          console.error(chalk.red(`Bundle '${resolvedName}' already exists. Use --force to overwrite.`));
          process.exit(1);
        }
        const bundle: SecretsBundle = {
          name: resolvedName,
          description: opts.description,
          allow_exec: opts.allowExec,
          vars: {},
        };
        writeBundle(bundle);
        console.log(chalk.green(`Bundle '${resolvedName}' created.`));
        console.log(chalk.gray(`Try: agents secrets add ${resolvedName} MY_KEY`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('rename <old> <new>')
    .alias('mv')
    .description('Rename a bundle. Moves the metadata and every keychain-backed value to the new name.')
    .option('--force', 'Overwrite the destination bundle if it already exists (purges its keychain items first)')
    .action((oldName: string, newName: string, opts: { force?: boolean }) => {
      try {
        renameBundle(oldName, newName, { force: opts.force });
        console.log(chalk.green(`Bundle '${oldName}' renamed to '${newName}'.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('describe <name> [text...]')
    .description('Update the description of a bundle. Pass --clear to remove it.')
    .option('--clear', 'Remove the existing description')
    .action((name: string, textParts: string[], opts: { clear?: boolean }) => {
      try {
        const bundle = readBundle(name);
        const text = textParts.join(' ').trim();
        if (opts.clear) {
          if (text) {
            console.error(chalk.red('Pass either description text or --clear, not both.'));
            process.exit(1);
          }
          bundle.description = undefined;
        } else {
          if (!text) {
            console.error(chalk.red('Description text is required. Pass it as an argument or use --clear.'));
            process.exit(1);
          }
          bundle.description = text;
        }
        writeBundle(bundle);
        console.log(chalk.green(
          opts.clear
            ? `Bundle '${name}' description cleared.`
            : `Bundle '${name}' description updated.`,
        ));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('add [bundle] [key]')
    .description('Add a variable to a bundle. Defaults to keychain-backed; pass --value for literal, --env/--file/--exec for refs.')
    .option('--value <v>', 'Store as a plaintext literal in the bundle (non-sensitive values only)')
    .option('--value-stdin', 'Read the value from stdin (stored in keychain unless combined with --value)')
    .option('--env <VAR>', 'Store as an env: ref that reads from the parent process.env at run time')
    .option('--file <path>', 'Store as a file: ref that reads from a file at run time')
    .option('--exec <cmd>', 'Store as an exec: ref that runs a command at run time (requires allow_exec)')
    .option('--type <kind>', 'Tag this secret with a type (api-key, token, password, url, database-url, ssh-key, certificate, webhook, note)')
    .option('--expires <YYYY-MM-DD>', 'Mark when this secret expires (must be future-dated)')
    .option('--note <text>', 'Attach a freeform note. Pass `-` to read from stdin (mutually exclusive with --value-stdin).')
    .action(async (bundleName: string | undefined, key: string | undefined, opts: {
      value?: string;
      valueStdin?: boolean;
      env?: string;
      file?: string;
      exec?: string;
      type?: string;
      expires?: string;
      note?: string;
    }) => {
      try {
        const resolvedBundleName = bundleName ?? (await pickBundleName('add to'));
        const bundle = readBundle(resolvedBundleName);
        const resolvedKey = key ?? (await promptKeyName(resolvedBundleName));
        validateEnvKey(resolvedKey);
        if (resolvedKey in bundle.vars) {
          throw new Error(`Key '${resolvedKey}' already exists in bundle '${resolvedBundleName}'. Use 'agents secrets rotate' to refresh it.`);
        }
        const sources = [opts.value !== undefined, Boolean(opts.env), Boolean(opts.file), Boolean(opts.exec)].filter(Boolean).length;
        if (sources > 1) {
          throw new Error('Pick one of: --value, --env, --file, --exec.');
        }
        const metaPatch = buildMetaPatch(opts);
        const applyMeta = () => {
          if (!metaPatch) return;
          if (!bundle.meta) bundle.meta = {};
          bundle.meta[resolvedKey] = { ...(bundle.meta[resolvedKey] ?? {}), ...metaPatch };
        };
        if (opts.env) {
          bundle.vars[resolvedKey] = `env:${opts.env}`;
          applyMeta();
          writeBundle(bundle);
          console.log(chalk.green(`${resolvedBundleName}.${resolvedKey} -> env:${opts.env}`));
          return;
        }
        if (opts.file) {
          bundle.vars[resolvedKey] = `file:${opts.file}`;
          applyMeta();
          writeBundle(bundle);
          console.log(chalk.green(`${resolvedBundleName}.${resolvedKey} -> file:${opts.file}`));
          return;
        }
        if (opts.exec) {
          if (!bundle.allow_exec) {
            throw new Error(`Bundle '${resolvedBundleName}' does not allow exec refs. Re-create with --allow-exec.`);
          }
          bundle.vars[resolvedKey] = `exec:${opts.exec}`;
          applyMeta();
          writeBundle(bundle);
          console.log(chalk.green(`${resolvedBundleName}.${resolvedKey} -> exec:${opts.exec}`));
          return;
        }
        if (opts.value !== undefined) {
          bundle.vars[resolvedKey] = { value: opts.value };
          applyMeta();
          writeBundle(bundle);
          console.log(chalk.green(`${resolvedBundleName}.${resolvedKey} = <literal>`));
          return;
        }
        // Default path: keychain-backed.
        let secretValue: string;
        if (opts.valueStdin) {
          secretValue = readStdinSync();
          if (!secretValue) throw new Error('No value received on stdin.');
        } else {
          secretValue = await promptForSecret(`Enter value for ${resolvedBundleName}.${resolvedKey}`);
        }
        const item = secretsKeychainItem(resolvedBundleName, resolvedKey);
        setKeychainToken(item, secretValue);
        bundle.vars[resolvedKey] = keychainRef(resolvedKey);
        applyMeta();
        writeBundle(bundle);
        console.log(chalk.green(`${resolvedBundleName}.${resolvedKey} stored in keychain (${item}).`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('rotate [bundle] [key]')
    .description('Rotate an existing keychain-backed secret (replaces the value, preserves metadata unless overridden).')
    .option('--value <v>', 'New value (non-secret cases). Prompts interactively if omitted.')
    .option('--value-stdin', 'Read the new value from stdin (stored in keychain unless combined with --value)')
    .option('--type <kind>', 'Update the type metadata (api-key, token, password, url, database-url, ssh-key, certificate, webhook, note)')
    .option('--expires <YYYY-MM-DD>', 'Update the expiration date (must be future-dated)')
    .option('--note <text>', 'Update the note. Pass `-` to read from stdin (mutually exclusive with --value-stdin).')
    .option('--clear-meta', 'Wipe all metadata for this key while rotating')
    .addHelpText('after', `
Examples:
  # Rotate the value, preserve all metadata
  agents secrets rotate prod STRIPE_API_KEY

  # Rotate with a metadata refresh
  agents secrets rotate prod STRIPE_API_KEY --type api-key --expires 2027-01-15 --note "rotated after employee offboarding"
`)
    .action(async (bundleName: string | undefined, key: string | undefined, opts: {
      value?: string;
      valueStdin?: boolean;
      type?: string;
      expires?: string;
      note?: string;
      clearMeta?: boolean;
    }) => {
      try {
        const resolvedBundleName = bundleName ?? (await pickBundleName('rotate in'));
        const bundle = readBundle(resolvedBundleName);
        const resolvedKey = key ?? (await pickKey(bundle, 'rotate'));
        if (!(resolvedKey in bundle.vars)) {
          throw new Error(`Key '${resolvedKey}' not in bundle '${resolvedBundleName}'. Use 'agents secrets add' to add a new key.`);
        }
        const raw = bundle.vars[resolvedKey];
        if (typeof raw !== 'string' || !raw.startsWith('keychain:')) {
          throw new Error(`Key '${resolvedKey}' in bundle '${resolvedBundleName}' is not keychain-backed; cannot rotate.`);
        }
        const metaPatch = buildMetaPatch(opts);
        if (opts.clearMeta && metaPatch) {
          throw new Error('--clear-meta and --type/--expires/--note are mutually exclusive.');
        }
        // Resolve the new value: --value > --value-stdin > prompt.
        let newValue: string;
        if (opts.value !== undefined) {
          newValue = opts.value;
        } else if (opts.valueStdin) {
          newValue = readStdinSync();
          if (!newValue) throw new Error('No value received on stdin.');
        } else {
          newValue = await promptForSecret(`Enter new value for ${resolvedBundleName}.${resolvedKey}`);
        }
        rotateBundleSecret(bundle, resolvedKey, {
          newValue,
          clearMeta: opts.clearMeta,
          meta: metaPatch,
        });
        console.log(chalk.green(`${resolvedBundleName}.${resolvedKey} rotated in keychain.`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('remove [bundle] [key]')
    .description('Remove a key from the bundle. Purges the keychain item if the ref was keychain:. Use --keep-secret to retain it.')
    .option('--keep-secret', 'Leave the keychain item in place after removing the ref from the bundle')
    .option('-y, --yes', 'Skip the confirmation prompt when purging a keychain item')
    .action(async (bundleName: string | undefined, key: string | undefined, opts: { keepSecret?: boolean; yes?: boolean }) => {
      try {
        const resolvedBundleName = bundleName ?? (await pickBundleName('remove from'));
        const bundle = readBundle(resolvedBundleName);
        const resolvedKey = key ?? (await pickKey(bundle, 'remove'));
        if (!(resolvedKey in bundle.vars)) {
          console.error(chalk.red(`Key '${resolvedKey}' not found in bundle '${resolvedBundleName}'.`));
          process.exit(1);
        }
        const raw = bundle.vars[resolvedKey];
        const willPurge = !opts.keepSecret && typeof raw === 'string' && raw.startsWith('keychain:');
        if (willPurge && !opts.yes) {
          if (!isInteractiveTerminal()) {
            console.error(chalk.red(
              `Refusing to purge keychain item for ${resolvedBundleName}.${resolvedKey} non-interactively. ` +
              `Pass --yes to confirm or --keep-secret to retain the keychain entry.`,
            ));
            process.exit(1);
          }
          const { confirm } = await import('@inquirer/prompts');
          const ok = await confirm({
            message: `Purge keychain item for ${resolvedBundleName}.${resolvedKey}? (use --keep-secret to retain)`,
            default: false,
          });
          if (!ok) {
            console.log(chalk.gray('Aborted. Bundle metadata unchanged.'));
            return;
          }
        }
        delete bundle.vars[resolvedKey];
        writeBundle(bundle);
        if (willPurge) {
          const item = secretsKeychainItem(resolvedBundleName, raw.slice('keychain:'.length));
          const removed = deleteKeychainToken(item);
          if (removed) {
            console.log(chalk.green(`Removed ${resolvedBundleName}.${resolvedKey} and purged keychain item.`));
            return;
          }
        }
        console.log(chalk.green(`Removed ${resolvedBundleName}.${resolvedKey}.`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('delete [name]')
    .description('Delete a bundle and purge all its keychain items (use --keep-secrets to retain them).')
    .option('--keep-secrets', 'Leave keychain items in place after deleting the bundle')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (name: string | undefined, opts: { keepSecrets?: boolean; yes?: boolean }) => {
      try {
        const resolvedName = name ?? (await pickBundleName('delete'));
        const bundle = readBundle(resolvedName);
        if (!opts.yes) {
          if (!isInteractiveTerminal()) {
            console.error(chalk.red(`Refusing to delete '${resolvedName}' without --yes in a non-interactive shell.`));
            process.exit(1);
          }
          const keychainCount = describeBundle(bundle).filter((e) => e.kind === 'keychain').length;
          const suffix = keychainCount && !opts.keepSecrets
            ? ` and purge ${keychainCount} keychain item${keychainCount === 1 ? '' : 's'}`
            : '';
          const { confirm } = await import('@inquirer/prompts');
          const proceed = await confirm({
            message: `Delete bundle '${resolvedName}'${suffix}?`,
            default: false,
          });
          if (!proceed) {
            console.log(chalk.gray('Cancelled.'));
            return;
          }
        }
        if (!opts.keepSecrets) {
          for (const { item } of keychainItemsForBundle(bundle)) {
            deleteKeychainToken(item);
          }
        }
        const existed = deleteBundle(resolvedName);
        if (!existed) {
          console.error(chalk.red(`Bundle '${resolvedName}' not found.`));
          process.exit(1);
        }
        console.log(chalk.green(`Bundle '${resolvedName}' deleted.`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('migrate')
    .description('Interactively migrate legacy YAML bundles into Keychain')
    .action(async () => {
      try {
        if (!isInteractiveTerminal()) {
          console.error(chalk.red('Refusing to migrate legacy secrets without an interactive confirmation prompt.'));
          process.exit(1);
        }
        const { confirm } = await import('@inquirer/prompts');
        const migrated = await migrateLegacyBundles(async (candidate) => {
          console.log(chalk.bold(`Legacy bundle '${candidate.name}'`));
          console.log(chalk.gray(candidate.file));
          for (const key of candidate.keys) {
            console.log(`  ${key}`);
          }
          return await confirm({
            message: `Migrate legacy bundle '${candidate.name}' into Keychain?`,
            default: false,
          });
        });
        if (migrated === 0) {
          console.log(chalk.gray('No legacy bundles migrated.'));
          return;
        }
        console.log(chalk.green(`Migrated ${migrated} legacy bundle${migrated === 1 ? '' : 's'} into keychain.`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('import [bundle]')
    .description('Import keys from a .env file or a 1Password vault into a bundle. By default every key is stored in keychain.')
    .option('--from <path>', 'Path to a .env file')
    .option('--from-1password', 'Import secrets from a 1Password vault (requires the op CLI)')
    .option('--vault <name>', '1Password vault name (used with --from-1password)')
    .option('--all-plaintext', 'Store every imported value as a literal in the bundle metadata (skip keychain item creation)')
    .option('--force', 'Overwrite an existing key in the bundle')
    .action(async (bundleName: string | undefined, opts: {
      from?: string;
      from1password?: boolean;
      vault?: string;
      allPlaintext?: boolean;
      force?: boolean;
    }) => {
      try {
        if (!opts.from && !opts.from1password) {
          throw new Error('Pass --from <path> to import a .env file, or --from-1password to import from a 1Password vault.');
        }
        if (opts.from && opts.from1password) {
          throw new Error('--from and --from-1password are mutually exclusive.');
        }

        const resolvedBundleName = bundleName ?? (await pickBundleName('import into'));
        const bundle = readBundle(resolvedBundleName);
        let added = 0;
        let skipped = 0;

        if (opts.from1password) {
          assertOpAvailable();
          const vault = await resolveVault(opts.vault);
          const items = listItems(vault);
          const { secrets, skipped: opSkipped } = extractSecrets(items, vault);
          for (const { envKey, value } of secrets) {
            if (!opts.force && envKey in bundle.vars) {
              skipped++;
              continue;
            }
            if (opts.allPlaintext) {
              bundle.vars[envKey] = { value };
            } else {
              const item = secretsKeychainItem(resolvedBundleName, envKey);
              setKeychainToken(item, value);
              bundle.vars[envKey] = keychainRef(envKey);
            }
            added++;
          }
          writeBundle(bundle);
          if (opSkipped.length) {
            console.log(chalk.yellow(`Skipped ${opSkipped.length} item(s) with no importable fields.`));
          }
          console.log(chalk.green(`Imported ${added} key(s) from 1Password vault '${vault}'${skipped ? `, skipped ${skipped} (already set, pass --force)` : ''}.`));
        } else {
          const raw = fs.readFileSync(opts.from!, 'utf-8');
          const pairs = parseDotenv(raw);
          for (const [key, value] of Object.entries(pairs)) {
            if (!opts.force && key in bundle.vars) {
              skipped++;
              continue;
            }
            if (opts.allPlaintext) {
              bundle.vars[key] = { value };
            } else {
              const item = secretsKeychainItem(resolvedBundleName, key);
              setKeychainToken(item, value);
              bundle.vars[key] = keychainRef(key);
            }
            added++;
          }
          writeBundle(bundle);
          console.log(chalk.green(`Imported ${added} key(s)${skipped ? `, skipped ${skipped} (already set, pass --force)` : ''}.`));
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('export [bundle]')
    .description('Resolve a bundle and print KEY=VALUE lines, push it to a 1Password vault with --to-1password, or push it to remote machine(s) over SSH with --to-ssh.')
    .option('--plaintext', 'Acknowledge that the resolved values will be printed in the clear (shell export mode)')
    .option('--to-1password', 'Push every key in the bundle as a PASSWORD item in a 1Password vault')
    .option('--vault <name>', '1Password vault name (used with --to-1password)')
    .option('--to-ssh', 'Push the bundle to remote machine(s) over SSH via their native agents-cli import')
    .option('--host <target...>', 'SSH target(s) for --to-ssh: host alias or user@host (repeatable)')
    .option('--force', 'Overwrite existing keys/items on the target (used with --to-1password and --to-ssh)')
    .action(async (bundleName: string | undefined, opts: {
      plaintext?: boolean;
      to1password?: boolean;
      vault?: string;
      toSsh?: boolean;
      host?: string[];
      force?: boolean;
    }) => {
      try {
        const { readAndResolveBundleEnv, bundleToEnvPrefix, isReservedEnvName } = await import('../lib/secrets/bundles.js');
        const resolvedBundleName = bundleName ?? (await pickBundleName('export'));

        if (opts.toSsh) {
          const hosts = opts.host ?? [];
          if (hosts.length === 0) {
            throw new Error('--to-ssh requires at least one --host <target>.');
          }
          for (const h of hosts) assertValidSshTarget(h);
          const { env } = readAndResolveBundleEnv(resolvedBundleName, { caller: `ssh export` });
          const dotenv = bundleEnvToDotenv(env);
          const keyCount = Object.keys(env).length;
          // Drive the remote's own `agents secrets` CLI so values land in its native
          // backend (Keychain on macOS, libsecret / encrypted-file on Linux). Create
          // the bundle if missing, then import the piped .env. `bash -lc` so the login
          // PATH resolves `agents`; the .env flows over ssh stdin and is never parsed
          // by a remote shell.
          const force = opts.force ? ' --force' : '';
          const remoteAgents =
            `agents secrets create ${shellQuote(resolvedBundleName)} >/dev/null 2>&1 || true; ` +
            `agents secrets import ${shellQuote(resolvedBundleName)} --from /dev/stdin${force}`;
          const remoteCmd = `bash -lc ${shellQuote(remoteAgents)}`;
          let failures = 0;
          for (const host of hosts) {
            const res = spawnSync('ssh', ['-o', 'BatchMode=yes', host, remoteCmd], {
              input: dotenv,
              stdio: ['pipe', 'pipe', 'pipe'],
              encoding: 'utf-8',
            });
            if (res.error) {
              failures++;
              console.error(chalk.red(`${host}: ${res.error.message}`));
              continue;
            }
            if (res.status !== 0) {
              failures++;
              const msg = (res.stderr || res.stdout || '').trim();
              console.error(chalk.red(`${host}: remote import failed (exit ${res.status ?? 'signal'})${msg ? `: ${msg}` : ''}`));
              continue;
            }
            const remoteMsg = (res.stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
            console.log(chalk.green(`${host} -> '${resolvedBundleName}': ${remoteMsg || `${keyCount} key(s) exported`}`));
          }
          if (failures > 0) process.exit(1);
          return;
        }

        if (opts.to1password) {
          assertOpAvailable();
          const vault = await resolveVault(opts.vault);
          const { env } = readAndResolveBundleEnv(resolvedBundleName, { caller: `1Password vault ${vault}` });
          let created = 0;
          let overwritten = 0;
          let skipped = 0;
          for (const [key, value] of Object.entries(env)) {
            const exists = itemExistsByTitle(key, vault);
            if (exists) {
              if (!opts.force) {
                skipped++;
                continue;
              }
              deleteItemByTitle(key, vault);
              createPasswordItem(key, value, vault);
              overwritten++;
            } else {
              createPasswordItem(key, value, vault);
              created++;
            }
          }
          const parts: string[] = [];
          if (created) parts.push(`${created} created`);
          if (overwritten) parts.push(`${overwritten} overwritten`);
          if (skipped) parts.push(`${skipped} skipped (already exist, pass --force)`);
          console.log(chalk.green(`Exported to 1Password vault '${vault}': ${parts.join(', ')}.`));
          return;
        }

        if (!opts.plaintext) {
          console.error(chalk.red('export prints secrets in the clear and requires --plaintext (works for TTY and pipes alike).'));
          process.exit(1);
        }
        const { env } = readAndResolveBundleEnv(resolvedBundleName, { caller: `export to shell` });
        const prefix = bundleToEnvPrefix(resolvedBundleName);
        for (const [k, v] of Object.entries(env)) {
          const exportKey = isReservedEnvName(k) ? `${prefix}_${k}` : k;
          const needsQuotes = /[\s$`"'\\|&;<>(){}[\]!#~]/.test(v);
          const output = needsQuotes ? `'${v.replace(/'/g, `'\\''`)}'` : v;
          process.stdout.write(`export ${exportKey}=${output}\n`);
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('exec <bundle> [command...]')
    .description('Run a command with the bundle\'s secrets injected into the environment')
    .allowUnknownOption()
    .action(async (bundleName: string, commandParts: string[]) => {
      try {
        if (commandParts.length === 0) {
          console.error(chalk.red('Usage: agents secrets exec <bundle> -- <command...>'));
          process.exit(1);
        }
        const { readAndResolveBundleEnv } = await import('../lib/secrets/bundles.js');
        const [cmd, ...args] = commandParts;
        const { env: secretEnv } = readAndResolveBundleEnv(bundleName, { caller: `command ${cmd}` });
        const { spawn } = await import('child_process');
        const proc = spawn(cmd, args, {
          stdio: 'inherit',
          env: { ...process.env, ...secretEnv },
        });
        proc.on('close', (code) => process.exit(code ?? 0));
        proc.on('error', (err) => {
          console.error(chalk.red(`Failed to run '${cmd}': ${err.message}`));
          process.exit(1);
        });
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('generate [length]')
    .description('Generate a random password')
    .option('-U, --uppercase', 'Include A-Z (default: on)')
    .option('-l, --lowercase', 'Include a-z (default: on)')
    .option('-d, --digits', 'Include 0-9 (default: on)')
    .option('-s, --symbols', 'Include symbols (default: on)')
    .option('--no-uppercase', 'Exclude A-Z')
    .option('--no-lowercase', 'Exclude a-z')
    .option('--no-digits', 'Exclude 0-9')
    .option('--no-symbols', 'Exclude symbols')
    .option('--strong', 'Include all character classes')
    .option('--pin', 'Digits only (shortcut for -d --no-uppercase --no-lowercase --no-symbols)')
    .option('--hex', 'Hex characters only (0-9, a-f)')
    .option('-c, --copy', 'Copy to clipboard (does not print)')
    .action(async (lengthArg: string | undefined, opts: {
      uppercase?: boolean;
      lowercase?: boolean;
      digits?: boolean;
      symbols?: boolean;
      strong?: boolean;
      pin?: boolean;
      hex?: boolean;
      copy?: boolean;
    }) => {
      const length = lengthArg ? parseInt(lengthArg, 10) : 32;
      if (isNaN(length) || length < 1 || length > 1024) {
        console.error(chalk.red('Length must be a number between 1 and 1024.'));
        process.exit(1);
      }

      const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const LOWER = 'abcdefghijklmnopqrstuvwxyz';
      const DIGITS = '0123456789';
      const SYMBOLS = '!@#$%^&*()-_=+[]{}|;:,.<>?';
      const HEX_LOWER = '0123456789abcdef';

      let charClasses: string[] = [];

      if (opts.hex) {
        charClasses = [HEX_LOWER];
      } else if (opts.pin) {
        charClasses = [DIGITS];
      } else {
        const useUpper = opts.strong || opts.uppercase !== false;
        const useLower = opts.strong || opts.lowercase !== false;
        const useDigits = opts.strong || opts.digits !== false;
        const useSymbols = opts.strong || opts.symbols !== false;

        if (useUpper) charClasses.push(UPPER);
        if (useLower) charClasses.push(LOWER);
        if (useDigits) charClasses.push(DIGITS);
        if (useSymbols) charClasses.push(SYMBOLS);
      }

      if (charClasses.length === 0) {
        console.error(chalk.red('At least one character class must be enabled.'));
        process.exit(1);
      }

      const randomBytes = crypto.getRandomValues(new Uint32Array(length * 2));
      let password = '';
      for (let i = 0; i < length; i++) {
        const classIndex = randomBytes[i * 2] % charClasses.length;
        const charClass = charClasses[classIndex];
        const charIndex = randomBytes[i * 2 + 1] % charClass.length;
        password += charClass[charIndex];
      }

      if (opts.copy) {
        try {
          await copyToClipboard(password);
          console.log(chalk.green(`Password copied to clipboard (${length} chars)`));
        } catch (err) {
          console.error(chalk.red(`Clipboard copy failed: ${(err as Error).message}`));
          console.error(chalk.gray('Re-run without --copy to print the password instead.'));
          process.exitCode = 1;
        }
      } else {
        console.log(password);
      }
    });

  registerSecretsSyncCommands(cmd);
  registerSecretsMigrateAclCommand(cmd);
}

/**
 * Copy text to the system clipboard, cross-platform.
 * macOS: `pbcopy`. Windows: `clip`. Linux: tries `wl-copy` (Wayland), then
 * `xclip`, then `xsel` (X11). Throws with an install hint if none are present.
 */
async function copyToClipboard(text: string): Promise<void> {
  const { spawn } = await import('child_process');
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];

  let lastErr: Error | null = null;
  for (const [cmd, args] of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
        proc.stdin.write(text);
        proc.stdin.end();
      });
      return;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  const hint =
    process.platform === 'linux'
      ? ' Install one: wl-clipboard (Wayland) or xclip / xsel (X11).'
      : '';
  throw new Error(`no clipboard tool available (${lastErr?.message ?? 'none found'}).${hint}`);
}
