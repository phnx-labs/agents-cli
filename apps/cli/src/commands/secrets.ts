/**
 * Secrets bundle management commands.
 *
 * Registers the `agents secrets` command tree for creating, viewing,
 * and managing named bundles of environment variables backed by macOS
 * Keychain. Bundles are injected at run time via `agents run --secrets`.
 */

import { Option, type Command } from 'commander';
import chalk from 'chalk';
import { visibleWidth, padVisible, readStdinSync } from '../lib/format.js';
import { terminalWidth, truncateToWidth, stringWidth } from '../lib/session/width.js';
import * as fs from 'fs';
import { SSH_TARGET_RE, assertValidSshTarget, sshExec, type SshExecResult } from '../lib/ssh-exec.js';
import { quoteWin32ExecArg, composeWin32CommandLine } from '../lib/platform/index.js';
import { ensureDaemonStarted, isDaemonRunning } from '../lib/daemon.js';
import {
  parseHostsOption,
  remoteResolveEnv,
  remoteSecretsRaw,
  remoteSecretsStream,
  resolveSshTarget,
} from '../lib/secrets/remote.js';
import { remoteShellFor, buildWindowsStdinImportCommand } from '../lib/hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import {
  bundleBackend,
  bundleExists,
  bundleItemStore,
  bundlePolicy,
  deleteBundle,
  describeBundle,
  keychainItemsForBundle,
  keychainRef,
  listBundles,
  migrateLegacyBundles,
  parseDotenv,
  readAndResolveBundleEnv,
  isHeadlessSecretsContext,
  readBundle,
  renameBundle,
  rotateBundleSecret,
  sanitizeProcessEnv,
  validateBundleName,
  validateEnvKey,
  validateExpiresFutureDated,
  validateSecretType,
  writeBundle,
  type SecretsBackend,
  type SecretsBundle,
  type SecretsPolicy,
  type VarMeta,
} from '../lib/secrets/bundles.js';
import { encryptForFallback, decryptForFallback, type EncFile } from '../lib/secrets/filestore.js';
import {
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
import {
  secretsHoldMs,
  secretsAgentDurable,
  agentLoad,
  agentLock,
  agentPing,
  agentStatus,
  ensureAgentRunning,
  runAgentLoadFromStdin,
  runSecretsAgent,
  uninstallSecretsAgentService,
} from '../lib/secrets/agent.js';
import { saveSession, deleteSession, deleteAllSessions } from '../lib/secrets/session-store.js';
import { getCliVersionFresh } from '../lib/version.js';
import { readMeta } from '../lib/state.js';
import { parseDuration } from '../lib/hooks/cache.js';
import { emit } from '../lib/events.js';
import { registerCommandGroups, setHelpSections } from '../lib/help.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import {
  discoverSyncedBundles,
  importSyncedBundle,
  type SyncedBundleCandidate,
} from '../lib/secrets/icloud-import.js';
import { registerSecretsSyncCommands } from './secrets-sync.js';
import { registerSecretsMigrateAclCommand } from './secrets-migrate.js';
import { registerSecretsImportKeyringCommand } from './secrets-import.js';

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

/**
 * Read the raw `.env` text for `import --from <path|->`. A `-` reads the .env
 * from stdin (the SSH push path: `export --host` pipes the resolved dotenv over
 * ssh stdin, which has no `/dev/stdin` on a Windows remote); any other value is
 * a filesystem path.
 */
export function readImportDotenv(from: string): string {
  return from === '-' ? readStdinSync() : fs.readFileSync(from, 'utf-8');
}

/** Where `secrets import` pulls keys from, parsed off the unified `--from`. */
export type ImportSource =
  | { kind: 'dotenv'; path: string }
  | { kind: '1password'; vault?: string }
  | { kind: 'icloud' };

/**
 * Parse the unified `--from <source>` value: a .env path (`-` reads stdin),
 * `1password:<vault>` (bare `1password` prompts for the vault), or `icloud`
 * (legacy iCloud Keychain bundles). The deprecated `--from-1password --vault`
 * pair maps onto the 1password source. A file literally named `icloud` or
 * `1password` can still be imported via an explicit path (`./icloud`).
 */
export function parseImportSource(opts: {
  from?: string;
  from1password?: boolean;
  vault?: string;
}): ImportSource {
  if (opts.from && opts.from1password) {
    throw new Error('--from and --from-1password are mutually exclusive.');
  }
  if (opts.from1password) return { kind: '1password', vault: opts.vault };
  if (!opts.from) {
    throw new Error(
      "Pass --from <source>: a .env path (- reads stdin), '1password:<vault>', or 'icloud'.",
    );
  }
  if (opts.from === 'icloud') return { kind: 'icloud' };
  if (opts.from === '1password') return { kind: '1password', vault: opts.vault };
  if (opts.from.startsWith('1password:')) {
    const vault = opts.from.slice('1password:'.length);
    return { kind: '1password', vault: vault || opts.vault };
  }
  return { kind: 'dotenv', path: opts.from };
}

/**
 * `secrets import --from icloud` — recover bundles stranded in the iCloud
 * Keychain by the device-local cutover. With a bundle name, imports exactly
 * that bundle; without one, interactively multi-selects from everything
 * discovered (all pre-checked — the common case is "bring them all back").
 */
async function importFromICloud(
  bundleName: string | undefined,
  opts: { force?: boolean; allPlaintext?: boolean; backend?: 'file'; purge?: boolean },
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('--from icloud reads the macOS iCloud Keychain and is only available on macOS.');
  }
  const candidates = discoverSyncedBundles();
  if (candidates.length === 0) {
    console.log('No legacy iCloud Keychain bundles found.');
    return;
  }
  const describe = (c: SyncedBundleCandidate) =>
    `${c.name} (${c.keys.length} key${c.keys.length === 1 ? '' : 's'}${c.hasMeta ? '' : ', no metadata'})`;
  let chosen: SyncedBundleCandidate[];
  if (bundleName) {
    const hit = candidates.find((c) => c.name === bundleName);
    if (!hit) {
      throw new Error(
        `No iCloud Keychain bundle named '${bundleName}'. Found: ${candidates.map((c) => c.name).join(', ')}`,
      );
    }
    chosen = [hit];
  } else if (!isInteractiveTerminal()) {
    throw new Error(
      `Found ${candidates.length} iCloud Keychain bundle(s): ${candidates.map((c) => c.name).join(', ')}. ` +
        'Pass a bundle name to import non-interactively.',
    );
  } else {
    const { checkbox } = await import('@inquirer/prompts');
    chosen = await checkbox({
      message: 'Which iCloud Keychain bundles to import?',
      choices: candidates.map((c) => ({ name: describe(c), value: c, checked: true })),
    });
    if (chosen.length === 0) {
      console.log('Nothing selected.');
      return;
    }
  }
  for (const candidate of chosen) {
    const result = importSyncedBundle(candidate, opts);
    const parts = [`imported ${result.added} key(s)`];
    if (result.skipped) parts.push(`skipped ${result.skipped} (already set, pass --force)`);
    if (result.missing.length) parts.push(`unreadable (left in iCloud): ${result.missing.join(', ')}`);
    if (result.unimportable.length) parts.push(`reserved, not importable (left in iCloud): ${result.unimportable.join(', ')}`);
    if (opts.purge) parts.push(`purged ${result.purged} iCloud item(s)`);
    const line = `${candidate.name}: ${parts.join(', ')}`;
    const warn = result.missing.length > 0 || result.unimportable.length > 0;
    console.log(warn ? chalk.yellow(line) : chalk.green(line));
  }
}

/**
 * Printed under a "bundle not found" failure: if the name matches a bundle
 * stranded in the iCloud Keychain (pre-device-local-cutover era), point at the
 * recovery command instead of leaving a dead end.
 */
function maybePrintSyncedHint(name: string): void {
  if (process.platform !== 'darwin') return;
  try {
    if (discoverSyncedBundles().some((c) => c.name === name)) {
      console.error(
        chalk.yellow(
          `A legacy iCloud Keychain copy of '${name}' exists. Recover it with: agents secrets import ${name} --from icloud`,
        ),
      );
    }
  } catch {
    // Hint only — never mask the original error.
  }
}

/**
 * Build the remote `agents secrets unlock` argv for `unlock --host`. `--all`
 * forwards verbatim; otherwise the explicit bundle names. A `--ttl` is passed
 * through as-is so the REMOTE parses its own duration (its platform rules, its
 * defaults). Shared with the command action so the wiring is unit-testable
 * without a live SSH session.
 */
export function buildRemoteUnlockArgs(names: string[], opts: { all?: boolean; ttl?: string; durable?: boolean }): string[] {
  return [
    'unlock',
    ...(opts.all ? ['--all'] : names),
    ...(opts.ttl ? ['--ttl', opts.ttl] : []),
    // Forward --durable so a remote unlock honors it too; without this the remote
    // silently falls back to its own secrets.agent.durable default (off).
    ...(opts.durable ? ['--durable'] : []),
  ];
}

// SSH target validation is defined canonically in src/lib/ssh-exec.ts and
// re-exported here for back-compat with existing importers of these symbols.
export { SSH_TARGET_RE, assertValidSshTarget };

/**
 * Build the child environment for `agents secrets exec`. Strips
 * loader/interpreter hijack vars (matching agent spawns in exec.ts) and never
 * forwards AGENTS_SECRETS_PASSPHRASE — the master decryption key must not reach
 * the executed command.
 */
export function buildSecretsExecEnv(
  parentEnv: NodeJS.ProcessEnv,
  secretEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sanitizeProcessEnv(parentEnv), ...secretEnv };
  delete env.AGENTS_SECRETS_PASSPHRASE;
  return env;
}

/**
 * Resolve the CLI version for the MCP server's `serverInfo.version`. package.json
 * sits at the repo root — two levels up from both `src/commands/` (bun/tsx dev)
 * and `dist/commands/` (built). Cosmetic only, so any failure falls back cleanly.
 */
function getCliVersion(): string {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
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

/**
 * Encrypt a resolved env map to an offline bundle file using AES-256-GCM
 * (the same EncFile envelope as the per-item file store). Inner plaintext is
 * JSON so multi-line values round-trip losslessly. Written with mode 0600;
 * the passphrase must be supplied explicitly — never auto-provisioned.
 */
export function exportBundleToFile(
  env: Record<string, string>,
  filePath: string,
  passphrase: string,
): void {
  const enc = encryptForFallback(JSON.stringify(env), passphrase);
  fs.writeFileSync(filePath, JSON.stringify(enc), { mode: 0o600 });
}

/**
 * Decrypt and parse an offline bundle file produced by exportBundleToFile.
 * Throws on a missing file, an invalid JSON envelope, or a wrong passphrase.
 */
export function importBundleFromFile(
  filePath: string,
  passphrase: string,
): Record<string, string> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let enc: EncFile;
  try {
    enc = JSON.parse(raw) as EncFile;
  } catch {
    throw new Error(`Encrypted bundle file ${filePath} is corrupt (not valid JSON).`);
  }
  let plaintext: string;
  try {
    plaintext = decryptForFallback(enc, passphrase);
  } catch {
    throw new Error(`Failed to decrypt bundle file ${filePath}. Wrong passphrase or tampered file.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error(`Decrypted bundle file ${filePath} has invalid content (expected JSON).`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Bundle file ${filePath} has unexpected structure.`);
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    result[k] = typeof v === 'string' ? v : String(v);
  }
  return result;
}

/**
 * Browse `agents secrets <args>` on one or more remote hosts over SSH and print
 * each host's stdout verbatim (lossless — no parsing). With >1 host the output
 * is grouped under a `── <host> ──` header. `tty` forces an interactive ssh
 * session (run sequentially) so a remote Touch-ID / passphrase prompt can
 * surface (e.g. `view --reveal`); otherwise hosts are queried in parallel.
 * Exits non-zero if any host fails.
 */
async function browseRemote(targets: string[], args: string[], tty: boolean): Promise<void> {
  const multi = targets.length > 1;
  let failures = 0;
  const render = (name: string, res: SshExecResult) => {
    if (multi) console.log(chalk.bold.cyan(`\n── ${name} ──`));
    if (res.code === 0) {
      if (res.stdout) process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
      if (res.stderr.trim()) process.stderr.write(chalk.gray(res.stderr));
    } else {
      failures++;
      const msg = (res.stderr || res.stdout || '').trim();
      const why = res.timedOut ? 'timed out' : res.code === null ? 'ssh failed' : `exit ${res.code}`;
      console.error(chalk.red(`${name}: ${why}${msg ? `: ${msg}` : ''}`));
    }
  };
  if (tty) {
    for (const t of targets) {
      const target = await resolveSshTarget(t);
      render(t, remoteSecretsRaw(target, args, { tty: true, osLookupName: t }));
    }
  } else {
    const resolved = await Promise.all(targets.map(async (t) => ({ name: t, target: await resolveSshTarget(t) })));
    const results = resolved.map(({ name, target }) => remoteSecretsRaw(target, args, { osLookupName: name }));
    targets.forEach((t, i) => render(t, results[i]));
  }
  if (failures > 0) process.exit(1);
}

/** Strip ANSI escape sequences so padding can be computed on visible width. */

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

/** Compact remaining-time for the list POLICY column: "19h" / "45m" / "2d". */
function compactRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The POLICY column for `secrets list`: the prompt policy, plus a concise
 * state hint. `daily` shows `held Nh` when the secrets-agent is currently
 * caching the bundle; `always` and `never` show whether they prompt. `held`
 * maps bundle name → expiry epoch-ms (from agentStatus()). */
export function renderPolicyCol(b: SecretsBundle, held?: Map<string, number>): string {
  // `never` is loud on purpose — it's the only tier with no user-presence gate.
  if (bundlePolicy(b) === 'never') return chalk.red.bold('never · no prompt');
  if (bundlePolicy(b) === 'always') return chalk.yellow('always · prompt');
  const exp = held?.get(b.name);
  return exp ? chalk.green(`daily · held ${compactRemaining(exp)}`) : chalk.gray('daily');
}

/** Human-readable hold window for `secrets status`. Sub-hour values render in
 * minutes (so a near-floor `holdMs` never shows a confusing "0 hours"), whole
 * hours up to 2 days, whole days beyond. Pure — unit-tested. */
export function formatHoldWindow(ms: number): string {
  if (ms < 3_600_000) { // under an hour → minutes (never a confusing "0 hours")
    const mins = Math.max(1, Math.round(ms / 60_000));
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
    // 59.99m rounds to 60 — call it 1 hour rather than "60 minutes".
  }
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'}`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Below this width the fixed date columns no longer fit; `list` uses cards. */
const SECRETS_WIDE = 96;

/** Format a single bundle as a table row for the `secrets list` output. */
function renderBundleRow(b: SecretsBundle, held?: Map<string, number>, cols = terminalWidth()): string {
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
    `${padVisible(renderPolicyCol(b, held), 18)} ` +
    `${padVisible(expiring, 9)} ` +
    `${padVisible(created, 9)} ` +
    `${padVisible(updated, 9)} ` +
    `${padVisible(used, 7)}`;
  // Mark file-backed bundles so `list` distinguishes them from keychain ones.
  const tag = b.backend === 'file' ? chalk.magenta('[file] ') : '';
  // Cap the free-form description to whatever space is left on the line so a long
  // description can't push the row to 200+ chars and wrap into a smear.
  const budget = cols - stringWidth(head) - 1 - stringWidth(tag);
  const desc = b.description && budget > 3
    ? chalk.gray(truncateToWidth(safePrint(b.description), budget))
    : '';
  const trailer = `${tag}${desc}`.trimEnd();
  return trailer ? `${head} ${trailer}` : head.trimEnd();
}

/** Narrow-terminal card: name + compact meta on one line, description below. */
function renderBundleCard(b: SecretsBundle, held: Map<string, number> | undefined, cols: number): string {
  const keys = describeBundle(b).length;
  const used = b.last_used ? relativeAge(b.last_used) : (b.created_at ? 'never' : '?');
  const tag = b.backend === 'file' ? chalk.magenta(' [file]') : '';
  const meta = chalk.gray(`${keys} key${keys === 1 ? '' : 's'} · `) + renderPolicyCol(b, held) + chalk.gray(` · used ${used}`);
  const line1 = `${chalk.cyan(b.name)}  ${meta}${tag}`;
  if (!b.description) return line1;
  return `${line1}\n    ${chalk.gray(truncateToWidth(safePrint(b.description), cols - 4))}`;
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

/**
 * Resolve an existing import target bundle (inheriting its backend) or create a
 * new one with the requested backend. Refuses to silently downgrade a
 * keychain-backed bundle to `file` — shared by every `import` source so the
 * guard can't drift between them.
 */
function resolveImportBundle(name: string, backendOpt: string | undefined): SecretsBundle {
  const requestedBackend = parseBackendOpt(backendOpt);
  if (bundleExists(name)) {
    const bundle = readBundle(name);
    if (requestedBackend === 'file' && bundle.backend !== 'file') {
      throw new Error(
        `Bundle '${name}' already exists with a keychain backend; ` +
        `--backend file cannot change it. Delete it first to recreate as file-backed.`
      );
    }
    return bundle;
  }
  return { name, backend: requestedBackend === 'file' ? 'file' : undefined, vars: {} };
}

/**
 * Apply KEY=VALUE entries into a bundle (keychain item or plaintext literal),
 * honoring `--force`, then persist. Returns the added/skipped tally. Shared by
 * the .env, --from-file, and --from-ssh import paths.
 */
function applyEnvToBundle(
  bundle: SecretsBundle,
  env: Record<string, string>,
  opts: { force?: boolean; allPlaintext?: boolean }
): { added: number; skipped: number } {
  const store = bundleItemStore(bundle.backend, { noAcl: bundlePolicy(bundle) === 'never' });
  let added = 0;
  let skipped = 0;
  for (const [key, value] of Object.entries(env)) {
    if (!opts.force && key in bundle.vars) { skipped++; continue; }
    if (opts.allPlaintext) {
      bundle.vars[key] = { value };
    } else {
      const item = secretsKeychainItem(bundle.name, key);
      store.set(item, value);
      bundle.vars[key] = keychainRef(key);
    }
    added++;
  }
  writeBundle(bundle);
  return { added, skipped };
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

      # See what's in the bundle (values masked); shows its prompt policy
      agents secrets view prod

      # Stop a noisy automation bundle from prompting every run: ask once a week
      agents secrets policy prod daily

      # Eval the bundle into your current shell
      eval "$(agents secrets export prod --plaintext)"

      # Push the bundle to remote machine(s) over SSH (lands as a native bundle there)
      agents secrets export prod --host yosemite-s0 --host yosemite-s1 --force

      # Run a one-off command with secrets injected
      agents secrets exec prod -- ./deploy.sh
    `,
    notes: `
      Bundles are containers; secrets are the variables inside them. Keychain values
      never touch disk in plaintext. Every item is device-local and gated by Touch ID
      or device passcode; cross-machine sync is handled by 'agents secrets push/pull'.

      Touch ID noise: macOS pops a prompt per bundle per process. Each bundle has
      a prompt policy, shown in the POLICY column of 'agents secrets list':
        daily (default)   ask once, then hold it silently in the local agent up
                          to ~7 days, until sleep / logout or 'lock' (a bare
                          screen-lock does NOT drop it). Name is historical.
        always            ask for Touch ID every time — never auto-held.
      The default is 'daily' (one Touch ID per ~7 days); change it globally with
      'secrets.policy' in agents.yaml, or per bundle with 'agents secrets policy
      <bundle> always'. 'agents secrets unlock <bundle>' holds any bundle after one
      prompt regardless of policy. Nothing on disk.

      See also:
        agents secrets policy <bundle> daily           ask once a week, not every run
        agents secrets unlock <bundle>                 hold a bundle after one Touch ID
        agents secrets lock                            wipe held bundles (re-prompt next read)
        agents secrets status                          show held bundles + when they lock
        agents secrets rotate <bundle> <key>           rotate value, preserve metadata
        agents secrets import <bundle> --from .env     bulk import from .env
        agents secrets import <bundle> --from 1password:<vault>
        agents secrets import --from icloud            recover legacy iCloud Keychain bundles
        agents secrets generate [length]               generate a random password / PIN / hex
        agents secrets migrate-acl                     upgrade legacy items to the biometry ACL
    `,
  });

  registerCommandGroups(cmd, [
    { title: 'Bundle commands', names: ['list', 'view', 'create', 'rename', 'describe', 'delete'] },
    { title: 'Secret commands', names: ['add', 'rotate', 'remove', 'import', 'export'] },
    { title: 'Agent commands', names: ['start', 'stop', 'unlock', 'lock', 'status', 'policy'] },
    { title: 'Raw item commands', names: ['get', 'set'] },
    { title: 'Sync commands', names: ['push', 'pull', 'remote-list'] },
    { title: 'Utilities', names: ['exec', 'mcp', 'generate', 'migrate-acl'] },
  ]);

  cmd
    .command('list')
    .alias('ls')
    .description('List configured secrets bundles (use --host/--hosts to list bundles on other machines over SSH)')
    .option('--host <target>', 'List bundles on a remote host over SSH (enrolled `agents hosts` name, ssh-config alias, or user@host)')
    .option('--hosts <list>', 'Comma-separated hosts to list in one shot, e.g. yosemite-s0,yosemite-s1')
    .action(async (opts: { host?: string; hosts?: string }) => {
      const targets = parseHostsOption(opts);
      if (targets.length > 0) {
        await browseRemote(targets, ['list'], false);
        return;
      }
      const bundles = listBundles();
      if (bundles.length === 0) {
        console.log(chalk.gray('No secrets bundles configured.'));
        console.log(chalk.gray('Try: agents secrets create <name>'));
        return;
      }
      // Cross-reference the secrets-agent so `daily` bundles that are currently
      // held can show "· held Nh". Soft-fails to no hint if the broker is down.
      const held = new Map<string, number>();
      if (process.platform === 'darwin') {
        try {
          for (const e of await agentStatus()) held.set(e.name, e.expiresAt);
        } catch {
          /* broker not running — render policy without the countdown */
        }
      }
      const cols = terminalWidth();
      if (cols >= SECRETS_WIDE) {
        console.log(chalk.bold(
          `${'NAME'.padEnd(20)} ${'KEYS'.padEnd(5)} ${'POLICY'.padEnd(18)} ${'EXPIRING'.padEnd(9)} ${'CREATED'.padEnd(9)} ${'UPDATED'.padEnd(9)} ${'USED'.padEnd(7)} DESCRIPTION`,
        ));
        for (const b of bundles) {
          console.log(renderBundleRow(b, held, cols));
        }
      } else {
        for (const b of bundles) {
          console.log(renderBundleCard(b, held, cols));
        }
      }
    });

  cmd
    .command('view [name]')
    .alias('show')
    .description('Show a bundle. Keychain values are masked by default — pass --reveal to see them.')
    .option('--reveal', 'Print keychain-backed values in the clear (TTY only unless --plaintext)')
    .option('--plaintext', 'Allow --reveal in non-interactive shells (use with care)')
    .option('--host <target>', 'Show a bundle on a remote host over SSH (enrolled `agents hosts` name, ssh-config alias, or user@host)')
    .option('--hosts <list>', 'Comma-separated hosts to show in one shot, e.g. yosemite-s0,yosemite-s1')
    .action(async (name: string | undefined, opts: { reveal?: boolean; plaintext?: boolean; host?: string; hosts?: string }) => {
      try {
        const targets = parseHostsOption(opts);
        if (targets.length > 0) {
          if (!name) {
            console.error(chalk.red('A bundle name is required when viewing a remote host (interactive pick needs a local terminal).'));
            process.exit(1);
          }
          const args = ['view', name];
          if (opts.reveal) args.push('--reveal');
          if (opts.plaintext) args.push('--plaintext');
          // With --reveal, force a TTY so the remote keychain prompt can surface
          // (and the remote's "--reveal in a non-TTY needs --plaintext" gate is
          // satisfied) — only when this side is itself interactive.
          const tty = Boolean(opts.reveal) && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
          await browseRemote(targets, args, tty);
          return;
        }
        const resolvedName = name ?? (await pickBundleName('view'));
        let bundle: SecretsBundle;
        try {
          bundle = readBundle(resolvedName);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          maybePrintSyncedHint(resolvedName);
          process.exit(1);
        }
        const entries = describeBundle(bundle);
        console.log(chalk.bold(bundle.name));
        if (bundle.description) console.log(chalk.gray(safePrint(bundle.description)));
        if (bundle.allow_exec) console.log(chalk.yellow('allow_exec: true'));
        if (bundle.backend === 'file') console.log(chalk.gray('backend: file (passphrase-encrypted; reads need AGENTS_SECRETS_PASSPHRASE, no Touch ID)'));
        if (bundlePolicy(bundle) === 'never') {
          console.log(chalk.red.bold('policy: never — NO biometry ACL; reads are silent (no Touch ID, no user-presence check). Automation-only.'));
        } else {
          console.log(
            bundlePolicy(bundle) === 'daily'
              ? chalk.gray('policy: daily (ask once, then held ~7 days until sleep / logout — screen-lock does not drop it)')
              : chalk.gray('policy: always (asks for Touch ID every time — never auto-held)'),
          );
        }
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
          // Revealing plaintext bypasses readAndResolveBundleEnv (the usual
          // audit chokepoint), so emit here — a `--reveal` exposes real values
          // and must show up in `agents events --module secrets`. Count both the
          // keychain values actually decrypted AND the inline literals (which
          // `--reveal` always prints, even for a literal-only bundle with no
          // keychain refs — see the entries loop below). Values are never
          // included, only how many keys were exposed. Emit only when something
          // was actually shown (a cancelled Touch ID + no literals reveals none).
          const literalCount = entries.filter((e) => e.kind === 'literal').length;
          const exposedCount = revealedValues.size + literalCount;
          if (exposedCount > 0) {
            emit('secrets.get', {
              module: 'secrets',
              bundle: bundle.name,
              operation: 'view --reveal',
              source: 'reveal',
              status: 'success',
              keyCount: exposedCount,
            });
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
    .command('get <item> [key]')
    .description('Print one secret value for shell hooks/automation. One arg = a raw keychain item by name; two args = one KEY out of a bundle (`get <bundle> <KEY>`). Cross-platform.')
    .action((item: string, key: string | undefined) => {
      if (key === undefined) {
        // Raw keychain item path — unchanged.
        try {
          // Routes through the platform keychain layer: macOS reads bare items
          // via /usr/bin/security (no Touch ID), Linux via secret-tool with the
          // encrypted-file fallback. The value goes to stdout (newline-terminated
          // so `$(agents secrets get NAME)` captures it cleanly); diagnostics go
          // to stderr so they never pollute the captured value.
          const value = getKeychainToken(item);
          // Raw item reads bypass readAndResolveBundleEnv, so audit here too.
          // `item` is the keychain service name, never the value.
          emit('secrets.get', { module: 'secrets', item, source: 'raw-item', status: 'success' });
          process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
        } catch {
          // Missing item is a normal, quiet outcome for a hook probe: exit 1,
          // print nothing to stdout. Callers test the exit code / empty capture.
          process.exit(1);
        }
        return;
      }
      // Bundle-key path: `get <bundle> <KEY>` prints exactly one resolved value.
      // Ungated like the raw path (it IS the automation primitive); the
      // `secrets.get` audit event is emitted inside readAndResolveBundleEnv.
      try {
        if (!bundleExists(item)) {
          console.error(chalk.red(`Secrets bundle '${item}' not found.`));
          process.exit(1);
        }
        // `secrets get` is the scriptable automation primitive ($(agents secrets
        // get bundle KEY)); when embedded in a headless routine/CI script it must
        // not pop an unwatched Touch ID prompt. Interactive use still prompts.
        const { env } = readAndResolveBundleEnv(item, { caller: 'secrets get', keys: [key], agentOnly: isHeadlessSecretsContext() });
        if (!(key in env)) {
          console.error(chalk.red(`Key '${key}' not in bundle '${item}'.`));
          process.exit(1);
        }
        const value = env[key];
        process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
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
        // Raw item writes bypass writeBundle (the usual secrets.set chokepoint).
        emit('secrets.set', { module: 'secrets', item, source: 'raw-item' });
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
    .option('--policy <policy>', 'prompt policy: daily (default, ask once a week), always (ask every time), or never (silent, NO biometry ACL — needs --i-understand)')
    .addOption(new Option('--tier <policy>', 'deprecated alias for --policy').hideHelp())
    .option('--i-understand', 'Confirm creating a "never"-policy bundle (no biometry ACL) without an interactive prompt')
    .option('--backend <backend>', 'storage backend: keychain (default) or file (passphrase-encrypted, headless-readable)', 'keychain')
    .option('--force', 'Overwrite an existing bundle')
    .action(async (name: string | undefined, opts: { description?: string; allowExec?: boolean; policy?: string; tier?: string; iUnderstand?: boolean; backend?: string; force?: boolean }) => {
      try {
        const resolvedName = name ?? (await promptBundleName());
        validateBundleName(resolvedName);
        // Leave policy unset unless the user explicitly chose one, so the bundle
        // inherits the configured default (`daily`) instead of being pinned.
        const policyOpt = opts.policy ?? opts.tier;
        const policy = policyOpt ? parsePolicyOpt(policyOpt) : undefined;
        const backend = parseBackendOpt(opts.backend);
        if (bundleExists(resolvedName) && !opts.force) {
          console.error(chalk.red(`Bundle '${resolvedName}' already exists. Use --force to overwrite.`));
          process.exit(1);
        }
        // The `never` tier is the least-safe option — gate it loudly. Throws in a
        // headless shell without --i-understand; prompts otherwise.
        const ack = assertNeverPolicyAcknowledged(policy, { iUnderstand: opts.iUnderstand, interactive: isInteractiveTerminal() });
        if (ack === 'prompt' && !(await confirmNeverPolicyInteractive(resolvedName))) {
          console.error(chalk.yellow('Aborted.'));
          return;
        }
        const bundle: SecretsBundle = {
          name: resolvedName,
          description: opts.description,
          allow_exec: opts.allowExec,
          backend: backend === 'file' ? 'file' : undefined,
          policy,
          vars: {},
        };
        writeBundle(bundle);
        const policyTag = bundlePolicy(bundle) === 'daily'
          ? 'policy: daily'
          : bundlePolicy(bundle) === 'always'
            ? 'policy: always ask'
            : 'policy: never (NO biometry ACL)';
        const tags = [policyTag, backend === 'file' ? 'backend: file' : null].filter(Boolean);
        console.log(chalk.green(`Bundle '${resolvedName}' created (${tags.join(', ')}).`));
        if (bundlePolicy(bundle) === 'never') {
          console.log(chalk.red('Stored without biometry protection — reads are silent. Automation-only; rotate anything sensitive out of it.'));
        }
        if (backend === 'file') {
          console.log(chalk.gray('File-backed: items are AES-256-GCM encrypted under AGENTS_SECRETS_PASSPHRASE (no Touch ID).'));
        }
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
        // Default path: stored in the bundle's backend (keychain or file).
        let secretValue: string;
        if (opts.valueStdin) {
          secretValue = readStdinSync();
          if (!secretValue) throw new Error('No value received on stdin.');
        } else {
          secretValue = await promptForSecret(`Enter value for ${resolvedBundleName}.${resolvedKey}`);
        }
        const item = secretsKeychainItem(resolvedBundleName, resolvedKey);
        bundleItemStore(bundle.backend, { noAcl: bundlePolicy(bundle) === 'never' }).set(item, secretValue);
        bundle.vars[resolvedKey] = keychainRef(resolvedKey);
        applyMeta();
        writeBundle(bundle);
        const where = bundle.backend === 'file' ? 'encrypted file store' : 'keychain';
        console.log(chalk.green(`${resolvedBundleName}.${resolvedKey} stored in ${where} (${item}).`));
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
          const removed = bundleItemStore(bundle.backend).delete(item);
          if (removed) {
            const where = bundle.backend === 'file' ? 'encrypted file item' : 'keychain item';
            console.log(chalk.green(`Removed ${resolvedBundleName}.${resolvedKey} and purged ${where}.`));
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
          const store = bundleItemStore(bundle.backend);
          for (const { item } of keychainItemsForBundle(bundle)) {
            store.delete(item);
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
    .description('Import keys into a bundle from a .env file, a 1Password vault, or legacy iCloud Keychain bundles. The bundle is created if it does not exist. Values are stored in the bundle\'s backend (keychain by default).')
    .option('--from <source>', "Source: a .env path (- reads stdin), '1password:<vault>', or 'icloud' (legacy iCloud Keychain bundles)")
    .addOption(new Option('--from-1password', 'deprecated alias for --from 1password:<vault>').hideHelp())
    .addOption(new Option('--vault <name>', 'deprecated: name the vault in --from 1password:<vault>').hideHelp())
    .option('--all-plaintext', 'Store every imported value as a literal in the bundle metadata (skip keychain item creation)')
    .option('--backend <backend>', 'When creating the bundle: keychain (default) or file (passphrase-encrypted, headless-readable)', 'keychain')
    .option('--force', 'Overwrite an existing key in the bundle')
    .option('--purge', 'With --from icloud: delete the iCloud copies after a successful import (iCloud propagates the deletion to your other devices)')
    .option('--from-file <path>', 'Import from an AES-256-GCM encrypted offline bundle file (needs AGENTS_SECRETS_PASSPHRASE; symmetric counterpart of export --to-file)')
    .option('--from-ssh', 'Pull the bundle from a fleet peer over SSH and import it locally (requires --host)')
    .option('--host <peer>', 'SSH peer to pull from when using --from-ssh (host alias or user@host)')
    .action(async (bundleName: string | undefined, opts: {
      from?: string;
      from1password?: boolean;
      vault?: string;
      allPlaintext?: boolean;
      backend?: string;
      force?: boolean;
      purge?: boolean;
      fromFile?: string;
      fromSsh?: boolean;
      host?: string;
    }) => {
      try {
        // A single import can name only one source. --from-file / --from-ssh are
        // early-return paths, so guard them against each other and the --from /
        // --from-1password pair (which parseImportSource guards on its own).
        const namedFileOrSsh = [
          opts.fromFile ? '--from-file' : null,
          opts.fromSsh ? '--from-ssh' : null,
        ].filter(Boolean);
        if (namedFileOrSsh.length > 1 || (namedFileOrSsh.length > 0 && (opts.from || opts.from1password))) {
          throw new Error(
            '--from-file, --from-ssh, and --from/--from-1password are mutually exclusive; pick one import source.'
          );
        }
        if (opts.fromFile) {
          const passphrase = process.env.AGENTS_SECRETS_PASSPHRASE ?? '';
          if (!passphrase) {
            throw new Error(
              '--from-file needs AGENTS_SECRETS_PASSPHRASE set to decrypt the bundle file.'
            );
          }
          const env = importBundleFromFile(opts.fromFile, passphrase);
          const resolvedBundleName = bundleName ?? (await pickBundleName('import into'));
          const bundle = resolveImportBundle(resolvedBundleName, opts.backend);
          const { added, skipped } = applyEnvToBundle(bundle, env, opts);
          console.log(chalk.green(`Imported ${added} key(s) from file${skipped ? `, skipped ${skipped} (already set, pass --force)` : ''}.`));
          return;
        }

        if (opts.fromSsh) {
          if (!opts.host) {
            throw new Error('--from-ssh requires --host <peer>.');
          }
          assertValidSshTarget(opts.host);
          const resolvedBundleName = bundleName ?? (await pickBundleName('import into'));
          const target = await resolveSshTarget(opts.host);
          const env = await remoteResolveEnv(target, resolvedBundleName, { osLookupName: opts.host });
          const bundle = resolveImportBundle(resolvedBundleName, opts.backend);
          const { added, skipped } = applyEnvToBundle(bundle, env, opts);
          console.log(chalk.green(`Imported ${added} key(s) from ${opts.host}${skipped ? `, skipped ${skipped} (already set, pass --force)` : ''}.`));
          return;
        }

        const source = parseImportSource(opts);
        if (opts.purge && source.kind !== 'icloud') {
          throw new Error('--purge only applies to --from icloud.');
        }
        if (opts.from1password) {
          console.log(chalk.yellow('--from-1password is deprecated; use --from 1password:<vault>.'));
        }
        const requestedBackend = parseBackendOpt(opts.backend);

        if (source.kind === 'icloud') {
          await importFromICloud(bundleName, {
            force: opts.force,
            allPlaintext: opts.allPlaintext,
            backend: requestedBackend === 'file' ? 'file' : undefined,
            purge: opts.purge,
          });
          return;
        }

        const resolvedBundleName = bundleName ?? (await pickBundleName('import into'));
        // resolveImportBundle inherits an existing bundle's backend (and refuses
        // to downgrade keychain -> file) or creates it with the requested backend
        // so a single `import --backend file` works (what `export --host ...
        // --remote-backend file` drives on the remote).
        const bundle = resolveImportBundle(resolvedBundleName, opts.backend);

        if (source.kind === '1password') {
          assertOpAvailable();
          const vault = await resolveVault(source.vault);
          const items = listItems(vault);
          const { secrets, skipped: opSkipped } = extractSecrets(items, vault);
          const env: Record<string, string> = {};
          for (const { envKey, value } of secrets) env[envKey] = value;
          const { added, skipped } = applyEnvToBundle(bundle, env, opts);
          if (opSkipped.length) {
            console.log(chalk.yellow(`Skipped ${opSkipped.length} item(s) with no importable fields.`));
          }
          console.log(chalk.green(`Imported ${added} key(s) from 1Password vault '${vault}'${skipped ? `, skipped ${skipped} (already set, pass --force)` : ''}.`));
        } else {
          const raw = readImportDotenv(source.path);
          const pairs = parseDotenv(raw);
          const { added, skipped } = applyEnvToBundle(bundle, pairs, opts);
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
    .description('Resolve a bundle and print KEY=VALUE lines, push it to a 1Password vault with --to-1password, or push it to remote machine(s) over SSH with --host.')
    .option('--plaintext', 'Acknowledge that the resolved values will be printed in the clear (shell export mode)')
    .option('--to-1password', 'Push every key in the bundle as a PASSWORD item in a 1Password vault')
    .option('--vault <name>', '1Password vault name (used with --to-1password)')
    .option('--host <target...>', 'Push the bundle over SSH to this target (host alias or user@host); repeatable for multiple machines')
    .option('--remote-backend <backend>', 'Backend for the bundle on the remote (with --host): keychain (default) or file (passphrase-encrypted, headless-readable). file forwards AGENTS_SECRETS_PASSPHRASE over stdin.', 'keychain')
    .option('--force', 'Overwrite existing keys/items on the target (used with --to-1password and --host)')
    .option('--format <shell|json>', 'Output for --plaintext export: shell (default) or json (lossless, machine-readable; used by remote resolve)', 'shell')
    .option('--to-file <path>', 'Write the bundle as an AES-256-GCM encrypted offline file (needs AGENTS_SECRETS_PASSPHRASE; symmetric counterpart of import --from-file)')
    .action(async (bundleName: string | undefined, opts: {
      plaintext?: boolean;
      to1password?: boolean;
      vault?: string;
      host?: string[];
      remoteBackend?: string;
      force?: boolean;
      format?: string;
      toFile?: string;
    }) => {
      try {
        const { readAndResolveBundleEnv, bundleToEnvPrefix, isReservedEnvName } = await import('../lib/secrets/bundles.js');
        const resolvedBundleName = bundleName ?? (await pickBundleName('export'));

        if (opts.toFile) {
          const passphrase = process.env.AGENTS_SECRETS_PASSPHRASE ?? '';
          if (!passphrase) {
            throw new Error(
              '--to-file needs AGENTS_SECRETS_PASSPHRASE set to encrypt the bundle. ' +
              'Set it for this command, then supply the same value when importing.'
            );
          }
          const { env } = readAndResolveBundleEnv(resolvedBundleName, { caller: 'export --to-file', agentOnly: isHeadlessSecretsContext() });
          exportBundleToFile(env, opts.toFile, passphrase);
          console.log(chalk.green(`Exported ${Object.keys(env).length} key(s) to ${opts.toFile}`));
          return;
        }

        // The presence of --host selects SSH push: --host is the destination
        // and carries the mode (no separate --to-ssh needed — it would be
        // strictly redundant since SSH always requires at least one host).
        const hosts = opts.host ?? [];
        if (hosts.length > 0) {
          for (const h of hosts) assertValidSshTarget(h);
          const remoteBackend = parseBackendOpt(opts.remoteBackend);
          // For a file-backed remote bundle the remote must encrypt at rest with
          // a passphrase. We forward the LOCAL AGENTS_SECRETS_PASSPHRASE — the
          // operator unlocks it once on this (trusted, biometry-gated) machine —
          // and ship it as the FIRST stdin line so it never lands in argv / `ps`
          // / the remote shell history. The remote `read -r` consumes that line;
          // `agents secrets import --from /dev/stdin` reads the .env remainder.
          let remotePassphrase = '';
          if (remoteBackend === 'file') {
            remotePassphrase = process.env.AGENTS_SECRETS_PASSPHRASE ?? '';
            if (!remotePassphrase) {
              throw new Error(
                '--remote-backend file needs AGENTS_SECRETS_PASSPHRASE set locally to encrypt the ' +
                'bundle at rest on the remote. Set it for this command, then unlock it the same way per run.'
              );
            }
          }
          const { env } = readAndResolveBundleEnv(resolvedBundleName, { caller: `ssh export`, agentOnly: isHeadlessSecretsContext() });
          const dotenv = bundleEnvToDotenv(env);
          const keyCount = Object.keys(env).length;
          // Drive the remote's own `agents secrets import --from -` so the values
          // land in its chosen backend, reading the .env off ssh stdin (never
          // parsed by a remote shell — `--from -` replaces the POSIX-only
          // `/dev/stdin`). The keychain path is built OS-aware via
          // `remoteSecretsRaw` (bash -lc on POSIX, PowerShell on Windows), so it
          // works on macOS, Linux AND Windows targets. `import` auto-creates the
          // bundle, so no separate `create` (the old `|| true` was a POSIXism
          // that broke on PowerShell: `'true' is not recognized`).
          let failures = 0;
          for (const host of hosts) {
            let res: SshExecResult;
            if (remoteBackend === 'file') {
              // File backend forwards AGENTS_SECRETS_PASSPHRASE as the FIRST stdin
              // line (consumed by `read`, so it never lands in argv / `ps` /
              // remote history), then the .env. That `read`/`export` prologue is
              // POSIX shell — refuse a Windows target cleanly rather than emit
              // broken PowerShell.
              if (remoteShellFor(resolveRemoteOsSync(host.split('@').pop() ?? host)) === 'powershell') {
                failures++;
                console.error(chalk.red(`${host}: file backend export to a Windows target is not yet supported.`));
                continue;
              }
              const remoteAgents =
                `IFS= read -r AGENTS_SECRETS_PASSPHRASE; export AGENTS_SECRETS_PASSPHRASE; ` +
                `agents secrets import ${shellQuote(resolvedBundleName)} --from - --backend file${opts.force ? ' --force' : ''}`;
              res = sshExec(host, `bash -lc ${shellQuote(remoteAgents)}`, { input: `${remotePassphrase}\n${dotenv}` });
            } else if (remoteShellFor(resolveRemoteOsSync(host.split('@').pop() ?? host)) === 'powershell') {
              // Keychain on a Windows target: the `agents.ps1` shim doesn't
              // forward ssh-piped stdin to node, so `--from -` would hang.
              // Bridge the piped .env through PowerShell into a temp file and
              // import `--from <file>` (deleted afterwards). Same hardened ssh
              // engine, .env still only ever crosses the wire over ssh stdin.
              res = sshExec(host, buildWindowsStdinImportCommand(resolvedBundleName, { force: opts.force }), { input: dotenv });
            } else {
              // Keychain on a POSIX target: OS-aware wrapping + hardened ssh
              // engine (BatchMode, ConnectTimeout, keepalive, control-socket
              // reuse) via the same path the READ inverse (`remoteResolveEnv`)
              // uses. `--from -` reads the .env off ssh stdin.
              res = remoteSecretsRaw(
                host,
                ['import', resolvedBundleName, '--from', '-', ...(opts.force ? ['--force'] : [])],
                { input: dotenv, osLookupName: host },
              );
            }
            if (res.code === null) {
              failures++;
              console.error(chalk.red(`${host}: ${res.stderr.trim() || (res.timedOut ? 'ssh timed out' : 'ssh failed')}`));
              continue;
            }
            if (res.code !== 0) {
              failures++;
              const msg = (res.stderr || res.stdout || '').trim();
              console.error(chalk.red(`${host}: remote import failed (exit ${res.code})${msg ? `: ${msg}` : ''}`));
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
          const { env } = readAndResolveBundleEnv(resolvedBundleName, { caller: `1Password vault ${vault}`, agentOnly: isHeadlessSecretsContext() });
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

        if (opts.format && opts.format !== 'shell' && opts.format !== 'json') {
          console.error(chalk.red(`Invalid --format ${JSON.stringify(opts.format)}. Expected 'shell' or 'json'.`));
          process.exit(1);
        }
        if (!opts.plaintext) {
          console.error(chalk.red('export prints secrets in the clear and requires --plaintext (works for TTY and pipes alike).'));
          process.exit(1);
        }
        // `agents secrets export --plaintext` is what release/CI scripts eval.
        // When it runs detached (both stdio non-TTY) or under a headless agent,
        // resolve broker-only so it can never pop a Touch ID sheet on the
        // interactive user's screen. An interactive `eval "$(...)"` keeps its
        // terminal stdin, so it is not headless and still prompts.
        const { env } = readAndResolveBundleEnv(resolvedBundleName, {
          caller: `export to shell`,
          agentOnly: isHeadlessSecretsContext(),
        });
        if (opts.format === 'json') {
          // Lossless, machine-readable form consumed by `remoteResolveEnv` over
          // SSH. Single object of KEY -> value; values verbatim (newlines, quotes).
          process.stdout.write(JSON.stringify(env));
          return;
        }
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
    .description('Run a command with the bundle\'s secrets injected into the environment (use --host to resolve the bundle from a remote machine, ephemerally)')
    .option('--host <target>', 'Resolve <bundle> on a remote host over SSH and inject it (ephemeral — never stored on this machine)')
    .option('--keys <keys>', 'Inject only this comma-separated subset of keys (e.g. KEY1,KEY2). Missing keys are an error.')
    .option('--allow-expired', 'Inject keys even if their expiry date has passed (overrides the pre-run expiry abort).')
    .allowUnknownOption()
    .action(async (bundleName: string, commandParts: string[], execOpts: { host?: string; keys?: string; allowExpired?: boolean }) => {
      try {
        if (commandParts.length === 0) {
          console.error(chalk.red('Usage: agents secrets exec <bundle> -- <command...>'));
          process.exit(1);
        }
        const [cmd, ...args] = commandParts;
        const keysSubset = execOpts.keys
          ? execOpts.keys.split(',').map((k) => k.trim()).filter(Boolean)
          : undefined;
        let secretEnv: Record<string, string>;
        if (execOpts.host) {
          // Least-privilege flags do not yet cross the SSH resolver —
          // silently applying them would inject the full remote env or an
          // expired key. Fail loud so the user can drop the flag or run
          // locally instead.
          const { assertRemoteBundleFlagsUnsupported } = await import('../lib/secrets/bundles.js');
          assertRemoteBundleFlagsUnsupported(
            bundleName,
            execOpts.host,
            { keys: keysSubset, allowExpired: execOpts.allowExpired },
            { keysFlag: '--keys', allowExpiredFlag: '--allow-expired' },
          );
          secretEnv = await remoteResolveEnv(await resolveSshTarget(execOpts.host), bundleName, { osLookupName: execOpts.host });
        } else {
          const { readAndResolveBundleEnv } = await import('../lib/secrets/bundles.js');
          secretEnv = readAndResolveBundleEnv(bundleName, {
            caller: `command ${cmd}`,
            keys: keysSubset,
            allowExpired: execOpts.allowExpired,
            agentOnly: isHeadlessSecretsContext(),
          }).env;
        }
        const { spawn } = await import('child_process');
        // On Windows, spawn without a shell ENOENTs for `.cmd`/`.bat` launchers
        // (npm, yarn, most JS CLIs) and shell built-ins, so we set shell:true.
        // With shell:true Node hands cmd.exe a single command line with NO quoting
        // of its own. Compose that line ourselves (composeWin32CommandLine quotes
        // every token) and pass an EMPTY args array so Node never concatenates the
        // user-supplied args unescaped (DEP0190 + injection). See that helper for
        // the cmd.exe %VAR%/!VAR! expansion caveat.
        const useShell = process.platform === 'win32';
        const spawnCmd = useShell ? composeWin32CommandLine(cmd, args) : cmd;
        const spawnArgs = useShell ? [] : args;
        const proc = spawn(spawnCmd, spawnArgs, {
          stdio: 'inherit',
          shell: useShell,
          env: buildSecretsExecEnv(process.env, secretEnv),
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
    .command('mcp')
    .description('Run a stdio MCP server exposing get_secret(bundle, key) — hand credentials to an MCP-speaking agent by name at call time, never through the child process environment')
    .action(async () => {
      // JIT credential delivery (#333): unlike `secrets exec`, which bakes every
      // resolved value into the child's env, this speaks MCP over stdio so a
      // framework requests one secret at a time and the raw value never enters
      // process.env. stdout is the JSON-RPC channel — nothing else may print there.
      const { runSecretsMcpServer } = await import('../lib/secrets/mcp.js');
      await runSecretsMcpServer({ version: getCliVersion() });
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

  cmd
    .command('unlock [names...]')
    .description('Hold a bundle in the secrets-agent after one Touch ID, so concurrent runs read it without re-prompting (macOS). With --host, unlock FILE-backed bundle(s) on a remote (the passphrase prompt surfaces over the SSH TTY); keychain/biometry bundles are GUI-only and can\'t be remote-unlocked.')
    .option('--ttl <duration>', 'How long to hold it (e.g. 30m, 8h, 3d). Default 7d.')
    .option('--durable', 'Keep the unlock across sleep + reboot too (default: survives upgrade/restart but re-locks on sleep). Set secrets.agent.durable in agents.yaml to make this the default.')
    .option('--all', 'Unlock every configured bundle')
    .option('--host <target>', 'Unlock the bundle(s) on this remote machine over SSH instead of locally (file-backed bundles only — the remote\'s passphrase prompt surfaces on your terminal over a -tt session). Single-valued (NOT variadic) so it never swallows the bundle name: `unlock <name> --host <machine>`.')
    .action(async (names: string[], opts: { ttl?: string; durable?: boolean; all?: boolean; host?: string }) => {
      // Single-valued (not variadic): a variadic --host greedily consumes the
      // positional bundle name (`unlock --host mac wztest` -> host=[mac,wztest],
      // names=[]). Unlock targets one remote at a time anyway.
      const hosts = opts.host ? [opts.host] : [];
      if (hosts.length > 0) {
        // Remote unlock: the REMOTE enforces its own platform rules, so the
        // local darwin-only guard below does NOT apply. Only file-backed
        // bundles are remote-unlockable — their passphrase prompt surfaces over
        // the -tt SSH TTY; a keychain/biometry bundle would trigger a local GUI
        // Touch-ID sheet that can't cross SSH.
        if (!opts.all && (!names || names.length === 0)) {
          console.error(chalk.red('Specify one or more bundle names, or --all.'));
          process.exit(1);
        }
        const unlockArgs = buildRemoteUnlockArgs(names, opts);
        let failures = 0;
        for (const h of hosts) {
          const target = await resolveSshTarget(h);
          // FOREGROUND stream (stdio inherited), NOT the piped remoteSecretsRaw:
          // the remote's passphrase prompt only surfaces if the remote process
          // sees a real TTY, which requires our local terminal to pass straight
          // through. The remote's prompt + output stream to this terminal; we get
          // back only the exit code.
          const code = remoteSecretsStream(target, unlockArgs, { osLookupName: h });
          if (code === 0) {
            console.log(chalk.green(`${h}: unlocked`));
          } else {
            failures++;
            console.error(chalk.red(`${h}: unlock failed (exit ${code})`));
          }
        }
        if (failures > 0) process.exit(1);
        return;
      }
      if (process.platform !== 'darwin') {
        // No broker + no biometry prompt off darwin: secrets already resolve
        // durably from the OS store (libsecret / Credential Manager) on every
        // read with no prompt, so an unlock is a friendly no-op — not an error.
        // Accept --durable as a documented no-op so the command is uniform.
        console.log(chalk.gray('Nothing to unlock: secrets already persist on this OS — reads never re-prompt.'));
        return;
      }
      let targets = opts.all ? listBundles().map((b) => b.name) : names;
      if (!targets || targets.length === 0) {
        console.error(chalk.red('Specify one or more bundle names, or --all.'));
        process.exit(1);
      }
      let ttlMs = secretsHoldMs(); // default hold, capped by secrets.agent.holdMs
      if (opts.ttl) {
        const secs = parseDuration(opts.ttl);
        if (!secs) {
          console.error(chalk.red(`Invalid --ttl '${opts.ttl}'. Use e.g. 30m, 2h, 8h, 3d.`));
          process.exit(1);
        }
        ttlMs = secs * 1000;
      }
      if (!(await ensureAgentRunning())) {
        console.error(chalk.red('Could not start the secrets broker.'));
        process.exit(1);
      }
      // #415: the daemon should be always-on for any background need, not only
      // after `routines add`. `ensureAgentRunning` prefers the daemon (it hosts
      // the broker, #416), but can fall back to a one-off broker spawn when the
      // daemon can't come up — so ensure the daemon is up regardless. Idempotent
      // (single-instance start lock, #414) and best-effort — never blocks unlock.
      ensureDaemonStarted();
      let loaded = 0;
      for (const name of targets) {
        try {
          // noAgent: read the real keychain (one Touch ID) rather than the
          // agent we're about to populate.
          const { bundle, env } = readAndResolveBundleEnv(name, { noAgent: true, caller: 'unlock' });
          if (await agentLoad(name, bundle, env, ttlMs)) {
            loaded++;
            // Persist a durable session snapshot so the unlock survives a daemon
            // restart / upgrade (and sleep too, with --durable). session-store.ts.
            saveSession(name, {
              bundle,
              env,
              expiresAt: Date.now() + ttlMs,
              sleepPersist: opts.durable ?? secretsAgentDurable(),
            });
            console.log(`${chalk.green('unlocked')} ${chalk.cyan(name)} ${chalk.gray(`(${Object.keys(env).length} keys, ${humanRemaining(Date.now() + ttlMs)})`)}`);
          } else {
            console.error(chalk.red(`Failed to load '${name}' into the agent.`));
          }
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.error(chalk.yellow(`Cancelled unlocking '${name}'.`));
            continue;
          }
          console.error(chalk.red(`${name}: ${(err as Error).message}`));
        }
      }
      if (loaded === 0) process.exit(1);
    });

  cmd
    .command('lock [names...]')
    .description('Wipe bundles from the secrets-agent (forces Touch ID again next read). Default: all.')
    .option('--all', 'Wipe every unlocked bundle (same as no names)')
    .action(async (names: string[], opts: { all?: boolean }) => {
      if (process.platform !== 'darwin') return; // nothing to lock off darwin
      if (names && names.length > 0 && !opts.all) {
        let total = 0;
        for (const name of names) {
          total += await agentLock(name);
          deleteSession(name); // also drop the durable snapshot, or a restart re-warms it
        }
        console.log(total > 0 ? chalk.green(`Locked ${total} bundle(s).`) : chalk.gray('Nothing to lock.'));
      } else {
        const wiped = await agentLock();
        deleteAllSessions();
        console.log(wiped > 0 ? chalk.green(`Locked ${wiped} bundle(s).`) : chalk.gray('Nothing to lock.'));
      }
    });

  cmd
    .command('status')
    .description('Show which bundles the secrets-agent currently holds and when they lock.')
    .action(async () => {
      if (process.platform !== 'darwin') {
        console.log(chalk.gray('secrets-agent is macOS-only.'));
        return;
      }
      const ping = await agentPing();
      const brokerUp = ping.reachable;
      console.log(
        chalk.gray('broker: ') +
        (brokerUp
          ? chalk.green('running') + chalk.gray(isDaemonRunning() ? ' (hosted by the daemon)' : ' (standalone)')
          : chalk.yellow('not running — starts on demand, or run `agents secrets start` to bring the daemon up now')),
      );
      // Diagnostic: version skew is the top reason a `daily` bundle keeps
      // re-prompting — a broker on an older build gets torn down when the CLI
      // version changes (e.g. `agents-cli-update`), wiping every held bundle.
      const onDisk = getCliVersionFresh();
      if (brokerUp && ping.cliVersion && ping.cliVersion !== onDisk) {
        console.log(chalk.yellow(
          `  warning: broker is running an older build (${ping.cliVersion} vs ${onDisk} on disk). ` +
          `A version change can wipe held bundles — reads re-warm on the next access.`,
        ));
      }
      // Surface the hold window so "why did it prompt again" is answerable.
      const holdStr = formatHoldWindow(secretsHoldMs());
      // Only claim "(secrets.agent.holdMs)" when the config is actually honored —
      // an invalid value (0/NaN/negative) falls back to the default via
      // clampHoldMs, so it must read "(default)", not misattribute to config.
      const configured = (() => { try { const v = readMeta().secrets?.agent?.holdMs; return typeof v === 'number' && Number.isFinite(v) && v > 0; } catch { return false; } })();
      console.log(chalk.gray(`hold: ${holdStr}${configured ? ' (secrets.agent.holdMs)' : ' (default)'} — a daily bundle prompts once, then stays silent for this long or until sleep/logout.`));
      const entries = await agentStatus();
      if (entries.length === 0) {
        console.log(chalk.gray('No bundles held. The next read of each daily bundle will prompt once, then hold.'));
        console.log(chalk.gray('Pre-warm now with: agents secrets unlock <bundle>  (or --all)'));
        return;
      }
      console.log(chalk.bold(`${'BUNDLE'.padEnd(24)} ${'KEYS'.padEnd(5)} LOCKS IN`));
      for (const e of entries) {
        console.log(`${chalk.cyan(e.name.padEnd(24))} ${String(e.keyCount).padEnd(5)} ${humanRemaining(e.expiresAt)}`);
      }
      console.log(chalk.gray('Reads of held bundles are silent; any bundle not listed prompts once on its next read.'));
    });

  cmd
    .command('policy <bundle> [policy]')
    .alias('tier')
    .description("Show or set a bundle's prompt policy: daily (default, ask once a week), always (ask every time), or never (silent, NO biometry ACL).")
    .option('--i-understand', 'Confirm switching to the "never" policy (no biometry ACL) without an interactive prompt')
    .action(async (bundleName: string, policyArg: string | undefined, opts: { iUnderstand?: boolean }) => {
      try {
        const bundle = readBundle(bundleName);
        if (policyArg === undefined) {
          console.log(`${chalk.cyan(bundle.name)} policy: ${chalk.bold(bundlePolicy(bundle))}`);
          return;
        }
        const next = parsePolicyOpt(policyArg);
        // Switching to `never` drops the biometry ACL — gate it exactly like create.
        const ack = assertNeverPolicyAcknowledged(next, { iUnderstand: opts.iUnderstand, interactive: isInteractiveTerminal() });
        if (ack === 'prompt' && !(await confirmNeverPolicyInteractive(bundle.name))) {
          console.error(chalk.yellow('Aborted.'));
          return;
        }
        bundle.policy = next;
        // writeBundle evicts any broker-held copy, so tightening daily ->
        // always/never takes effect NOW: the next read re-prompts (`always`)
        // or reads its no-ACL item directly (`never`).
        writeBundle(bundle);
        console.log(chalk.green(`${bundle.name} policy set to ${next}.`));
        if (next === 'daily') {
          console.log(chalk.gray('Held by the secrets-agent for ~7 days after one unlock (auto-cache is on by default; disable with `secrets.agent.auto: false` in agents.yaml).'));
        } else if (next === 'always') {
          console.log(chalk.gray('Asks for Touch ID every time — never auto-held.'));
        } else {
          console.log(chalk.red('Stored without biometry protection — reads are silent. Automation-only.'));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('start')
    .description('Bring up the always-on daemon that hosts the secrets broker (macOS). Survives heavy load; reads connect instantly.')
    .action(async () => {
      if (process.platform !== 'darwin') {
        console.error(chalk.red('The secrets broker is macOS-only.'));
        process.exit(1);
      }
      process.stdout.write(chalk.gray('Starting the daemon…\n'));
      ensureDaemonStarted();
      // The daemon hosts the broker socket-first; wait briefly for it to answer.
      const deadline = Date.now() + 10000;
      let reachable = (await agentPing()).reachable;
      while (!reachable && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        reachable = (await agentPing()).reachable;
      }
      if (reachable) {
        console.log(chalk.green('secrets broker running.') + chalk.gray(' Hosted by the always-on daemon; unlock/auto-cache now connect instantly.'));
      } else {
        console.error(chalk.red('Daemon started but the broker did not become reachable in time (machine may be heavily loaded — it will keep retrying).'));
        process.exit(1);
      }
    });

  cmd
    .command('stop')
    .description('Lock all bundles and retire any legacy standalone service. The always-on daemon (which hosts the broker) is left running.')
    .action(async () => {
      if (process.platform !== 'darwin') return;
      await uninstallSecretsAgentService();
      console.log(chalk.green('Locked all bundles.') + chalk.gray(' The broker stays hosted by the always-on daemon; a legacy standalone service, if any, was retired.'));
    });

  cmd
    .command('_agent-run', { hidden: true })
    .description('Run the secrets-agent broker in the foreground (internal)')
    .option('--service', 'run as a persistent launchd service (never idle-exit)')
    .action(async (opts: { service?: boolean }) => {
      await runSecretsAgent({ service: Boolean(opts.service) });
    });

  cmd
    .command('_agent-load', { hidden: true })
    .description('Detached auto-cache worker: load a bundle from stdin into the broker (internal)')
    .action(async () => {
      await runAgentLoadFromStdin();
    });

  registerSecretsSyncCommands(cmd);
  registerSecretsMigrateAclCommand(cmd);
  registerSecretsImportKeyringCommand(cmd);
}

/** Validate a prompt-policy value, throwing a clear message on a bad one (the
 * caller's try/catch renders it and exits). Accepts the legacy `biometry` /
 * `session` / `none` tokens as aliases for `always` / `daily` / `never` so older
 * flags and scripts keep working. `never`/`none` is the no-biometry-ACL tier —
 * accepted here, then gated behind a loud confirmation in the command layer. */
export function parsePolicyOpt(raw: string | undefined): SecretsPolicy {
  const v = (raw ?? 'always').toLowerCase();
  if (v === 'always' || v === 'biometry') return 'always';
  if (v === 'daily' || v === 'session') return 'daily';
  if (v === 'never' || v === 'none') return 'never';
  throw new Error(`Invalid policy '${raw}'. Use 'always', 'daily', or 'never'.`);
}

/**
 * Gate a create/switch to the `never` prompt-policy behind an explicit,
 * deliberate acknowledgement — it is the least-safe tier (no user-presence
 * check on any read). Returns:
 *   - `'ok'`    — not `never`, or already acknowledged via `--i-understand`.
 *   - `'prompt'` — interactive shell: caller must run a loud confirm prompt.
 * Throws in a non-interactive shell when the flag is absent, so a headless
 * `create --policy never` can't silently downgrade a bundle's protection.
 */
export function assertNeverPolicyAcknowledged(
  policy: SecretsPolicy | undefined,
  opts: { iUnderstand?: boolean; interactive: boolean },
): 'ok' | 'prompt' {
  if (policy !== 'never') return 'ok';
  if (opts.iUnderstand) return 'ok';
  if (!opts.interactive) {
    throw new Error(
      "Refusing to set the 'never' prompt-policy without confirmation. This tier stores " +
      'the bundle WITHOUT the biometry access control: every read is silent, with no Touch ID ' +
      'and no user-presence check — any code running as you can read it. Re-run with ' +
      '--i-understand to confirm you want an unprotected, automation-only bundle.',
    );
  }
  return 'prompt';
}

/** Loud confirm prompt shown before creating/switching to `never` in a TTY.
 * Returns true to proceed. Kept separate from assertNeverPolicyAcknowledged so
 * the decision logic stays pure and unit-testable. */
async function confirmNeverPolicyInteractive(bundleName: string): Promise<boolean> {
  console.error(chalk.red.bold('WARNING: policy "never" stores this bundle with NO biometry ACL.'));
  console.error(chalk.red(`Reads of '${bundleName}' will be fully silent — no Touch ID, no user-presence check.`));
  console.error(chalk.yellow('Use it only for low-sensitivity, automation-only credentials.'));
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message: `Store '${bundleName}' WITHOUT biometry protection?`, default: false });
}

/** Validate a --backend value, exiting with a clear message on a bad one. */
function parseBackendOpt(raw: string | undefined): SecretsBackend {
  const v = (raw ?? 'keychain').toLowerCase();
  if (v === 'keychain' || v === 'file') return v;
  console.error(chalk.red(`Invalid --backend '${raw}'. Use 'keychain' or 'file'.`));
  process.exit(1);
}

/** Human-readable "locks in 3 hours" / "locks in 5 minutes" from an epoch-ms expiry. */
function humanRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `locks in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `locks in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `locks in ${days} day${days === 1 ? '' : 's'}`;
}

// `quoteWin32ExecArg` now lives in lib/platform/exec.ts (shared with the agent
// run/shim spawn paths); re-exported here for the colocated secrets tests.
export { quoteWin32ExecArg };

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
