#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

/**
 * CLI entry point for agents-cli.
 *
 * Registers all commands, handles update checks, auto-corrects typos,
 * and launches the first-run interactive setup when appropriate.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectDevBuild } from './lib/startup/dev-build.js';
// `ora`, `@inquirer/prompts`, `./commands/utils.js`, and the agents/versions/shims
// modules are imported dynamically at their use sites: they are needed only on
// interactive / update / shim-repair paths, never for fast commands like
// `--version`, `--help`, or `view`. Keeping them off the module-eval path is
// what gets cold starts under the target.

// Force exit on Ctrl+C when no interactive prompt is handling it.
process.on('SIGINT', () => process.exit(130));

// Ignore SIGPIPE — prevents exit code 13 crashes in piped environments
// (e.g. `agents sessions | head`, or when stdout is captured by another process).
process.on('SIGPIPE', () => {});

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;
import {
  NPM_PACKAGE_NAME,
  deriveGlobalPrefix,
  detectPackageManager,
  installPackageIntoPrefix,
  installPackageWithBun,
  verifyInstalledVersion,
  refreshAliasShims,
} from './lib/self-update.js';

interface NpmPackageMetadata {
  version: string;
  integrity: string;
}

// Detect dev/working-tree builds and default the noisy startup steps off.
// Three cases trip this:
//   1. Dev install (scripts/install.sh) — package.json version stamped 0.0.0-dev.<sha>
//   2. Running `node dist/index.js` from a working tree — repo root has .git/
//   3. Running tsx/ts-node from src/ — also has .git/ at the repo root
// For all three: skip auto-pull (no network noise + no surprise FF on the
// system repo while iterating), skip migration (a buggy in-progress migration
// must not scribble on the user's real ~/.agents/), and skip the update prompt
// (the "0.0.0-dev -> 1.x.y" message is misleading). Each individual env var
// can still be set explicitly to override (set to '0' to re-enable).
const IS_DEV_BUILD: boolean = detectDevBuild(process.argv[1] || '', VERSION);
if (IS_DEV_BUILD) {
  if (process.env.AGENTS_NO_AUTOPULL === undefined) process.env.AGENTS_NO_AUTOPULL = '1';
  if (process.env.AGENTS_SKIP_MIGRATION === undefined) process.env.AGENTS_SKIP_MIGRATION = '1';
  if (process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE === undefined) process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE = '1';
}

// Command registration is lazy: instead of statically importing every command
// module on each invocation (which loaded the whole ~50-module tree before the
// first byte of output), the registry maps a command name to a thunk that
// imports only what that command needs. See src/lib/startup/command-registry.ts.
import {
  COMMAND_LOADERS,
  LAZY_COMMAND_NAMES,
  loadView,
  loadInspect,
  loadFeedback,
  loadCommands,
  loadHooks,
  loadSkills,
  loadRules,
  loadMemory,
  loadPermissions,
  loadMcp,
  loadCli,
  loadSubagents,
  loadPlugins,
  loadWorkflows,
  loadWorktree,
  loadVersions,
  loadImport,
  loadPackages,
  loadDaemon,
  loadRoutines,
  loadRun,
  loadDefaults,
  loadModels,
  loadPrune,
  loadTrash,
  loadRestore,
  loadDoctor,
  loadCheck,
  loadStatus,
  loadProfiles,
  loadSecrets,
  loadWallet,
  loadHelper,
  loadMenubar,
  loadBeta,
  loadSync,
  loadLock,
  loadRefreshRules,
  loadDrive,
  loadFactory,
  loadUsage,
  loadCost,
  loadBudget,
  loadAlias,
  loadPty,
  loadTmux,
  loadWatchdog,
  loadBrowser,
  loadComputer,
  loadHosts,
  loadLogs,
  loadEvents,
  loadAudit,
  loadSsh,
  loadPull,
  loadPush,
  loadRepo,
  loadSetup,
  loadFeed,
  type ModuleLoader,
} from './lib/startup/command-registry.js';
import { applyGlobalHelpConventions } from './lib/help.js';
import { renderWhatsNew } from './lib/whats-new.js';
import type { AgentId } from './lib/types.js';
import { IS_WINDOWS } from './lib/platform/index.js';
import { emit, redactArgs } from './lib/events.js';

// Transparent shim delegate: the generated Windows `.cmd` shims invoke
// `agents __shim <agent>[@version] <raw args>`. Intercept here, before commander
// parses anything, so the agent's own flags (`--help`, `--version`, etc.) pass
// through completely untouched and we skip registering the full command tree.
if (process.argv[2] === '__shim') {
  const spec = process.argv[3] || '';
  const rawArgs = process.argv.slice(4);
  const atIndex = spec.indexOf('@');
  const agent = atIndex === -1 ? spec : spec.slice(0, atIndex);
  const pinned = atIndex === -1 ? undefined : spec.slice(atIndex + 1);
  const { execShimPassthrough } = await import('./lib/exec.js');
  const code = await execShimPassthrough(agent as AgentId, rawArgs, process.cwd(), pinned || undefined);
  process.exit(code);
}

const program = new Command();

program
  .name('agents')
  .description('Environment manager for AI agents')
  .version(VERSION)
  .option('--verbose', 'Show startup self-heal details on stderr')
  .helpOption('-h, --help', 'Show help')
  .addHelpCommand(false);

// ─── Audit backbone ────────────────────────────────────────────────────────────
// One choke point logs every `agents <module> <cmd>` invocation to the structured
// event log — so team create/disband, agent run, secrets access, and everything
// else is captured generically (with SSH/remote-user attribution added in emit()),
// no per-command wiring. `agents events` reads it back. Attached to the root
// program, so it's inherited by every subcommand regardless of lazy registration.

/** Command path from the acting command up to (but excluding) the `agents` root. */
function auditCommandPath(cmd: Command): string[] {
  const parts: string[] = [];
  let c: Command | null | undefined = cmd;
  while (c && c.name() && c.name() !== 'agents') {
    parts.unshift(c.name());
    c = c.parent;
  }
  return parts;
}

const auditStarts = new WeakMap<Command, number>();

program.hook('preAction', (_thisCommand, actionCommand) => {
  try {
    const parts = auditCommandPath(actionCommand);
    if (parts.length === 0) return;
    auditStarts.set(actionCommand, Date.now());
    emit('command.start', {
      module: parts[0],
      command: parts.join(' '),
      // Commander exposes positional operands in actionCommand.args but omits
      // parsed option values. Audit the real argv so sensitive flags are seen
      // and redacted instead of silently bypassing the policy.
      args: redactArgs(process.argv.slice(2, 22)),
      cwd: process.cwd(),
    });
  } catch {
    // Audit logging must never break command dispatch.
  }
});

program.hook('postAction', (_thisCommand, actionCommand) => {
  try {
    const parts = auditCommandPath(actionCommand);
    if (parts.length === 0) return;
    const started = auditStarts.get(actionCommand);
    emit('command.end', {
      module: parts[0],
      command: parts.join(' '),
      ...(started !== undefined ? { durationMs: Date.now() - started } : {}),
    });
  } catch {
    // Best-effort completion record; the start line is the durable audit fact.
  }
});

// Custom help for the main program only
const originalHelpInformation = program.helpInformation.bind(program);
program.helpInformation = function () {
  if (this.name() === 'agents' && !this.parent) {
    return `Usage: agents [command] [options]

Install, configure, run, and dispatch AI coding agents from one place.
Works with Claude, Codex, Gemini, Cursor, OpenCode, OpenClaw, and Droid.

Quick start:
  agents setup                    First-time setup (interactive)
  agents view                     See what's installed
  agents run <agent> ["prompt"]   Run an agent (interactive without prompt, headless with)
  agents sessions                 Browse past sessions across all agents

Agent versions:
  add <agent>[@version]           Install an agent CLI (e.g. agents add grok or agents add codex)
  import <agent>                  Adopt an existing global install (npm/homebrew) into agents-cli
  prune <agent>[@version]         Uninstall a version
  remove <agent>[@version]        Alias for prune
  use <agent>@<version>           Set the default version
  prune cleanup [target]          Remove orphan resources and older duplicate version installs
  trash                           Inspect and restore soft-deleted version directories
  view [agent[@version]]          List versions, or inspect one in detail
  inspect <target>                Deep details for one agent+version, or a DotAgents repo (user|system|project|alias|path)

Agent configuration (synced across versions):
  rules                           Instructions given to agents (CLAUDE.md, etc.)
  commands                        Slash commands (/commit, /test, etc.)
  skills                          Knowledge packs (SKILL.md + supporting files)
  mcp                             MCP servers (stdio or HTTP)
  permissions                     Allow/deny rules for tool calls
  hooks                           Shell scripts that run on agent events (hooks.yaml in agents.yaml)
  subagents                       Named sub-agent definitions
  plugins                         Bundles of skills, hooks, and scripts

Packages:
  search <query>                  Find MCP servers and skills in registries
  install <pkg>                   Install from registry (mcp:name, skill:user/repo)

Run and dispatch:
  run <agent|profile> [prompt]    Run an agent. Omit prompt for interactive mode.
  defaults                        Configure run defaults by agent/version selector
  teams                           Coordinate multiple agents on shared work
  routines                        Run agents on a cron schedule (scheduler auto-starts)
  sessions                        Browse, search, and replay past runs (live-search in TTY; grouped by workspace)
  logs [id]                       Show a run's log — host-dispatch task or session; -f to follow
  browser                         Automate a browser — navigate, click, screenshot, console, network
  pty                             Drive interactive terminal programs (REPLs, TUIs) via a persistent PTY session

Credentials and profiles:
  profiles                        Bundles of (host CLI, endpoint, model, auth)
  secrets                         Keychain-backed env bundles; use 'secrets exec <bundle> -- <cmd>' to inject into a subprocess

Diagnostics:
  doctor [agent[@version]]        Diagnose CLI availability, sync status, and resource divergence
  check                           CI drift gate: exit non-zero when resources are out of sync
  usage [agent]                   Show rate-limit and quota usage per agent

Config sync:
  drive                           Sync session history across machines via rsync
  pull                            Clone or pull the system repo at ~/.agents/.system/
  repo init --path <dir>          Scaffold your own editable repo from a template
  repo add <path|gh:user/repo>    Merge an extra repo after the system repo
  lock [--frozen]                 Write/verify agents.lock (SHA-256 of resolved resources); --frozen fails on drift

Beta features:
  beta                            Enable preview features (factory, drive, and more)

Automation tips:
  Pass explicit names/IDs         Avoid pickers: agents sessions <id> --markdown
  Use --yes for defaults          Auto-accept sync/default prompts on add/use/pull
  Use --names for central items   e.g. agents commands add --names review-pr,debug
  Use agent@version targets       e.g. --agents grok@0.1.218,claude@2.1.79,codex@default
  Non-TTY shells apply defaults   Omitted required selections fail with a plain hint

Options:
  -V, --version                   Show version number
  -h, --help                      Show help
  --verbose                       Show startup self-heal details on stderr

System config lives in ~/.agents/.system/. Run 'agents <command> --help' for details.
`;
  }
  return originalHelpInformation();
};

/** Compare two semver version strings. Returns 1 if a > b, -1 if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

/** Fetch and display changelog entries between two versions from unpkg. */
async function showWhatsNew(fromVersion: string, toVersion: string): Promise<void> {
  try {
    const response = await fetch(`https://unpkg.com/@phnx-labs/agents-cli@${toVersion}/CHANGELOG.md`);
    if (!response.ok) return;

    const relevantChanges = renderWhatsNew(await response.text(), fromVersion, toVersion);

    if (relevantChanges.length > 0) {
      console.log(chalk.bold("\nWhat's new:\n"));
      for (const line of relevantChanges) {
        console.log(line);
      }
      console.log(chalk.gray('\nFull notes: https://github.com/phnx-labs/agents-cli/blob/main/CHANGELOG.md'));
      console.log();
    }
  } catch {
    // Silently ignore changelog fetch errors
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
import { getUpdateCheckPath, getMigratedSentinelPath, getUserAgentsDir, getRuntimeStateDir } from './lib/state.js';
import {
  readUpdateCache,
  saveUpdateCheck,
  dismissUpdateVersion,
  shouldPromptUpgrade,
  findAgentsCliInstalls,
  type UpdateCheckCache,
} from './lib/self-update.js';
const UPDATE_CHECK_FILE = getUpdateCheckPath();

/**
 * Warn once when PATH resolves `agents` to a different agents-cli install
 * than the copy that is currently running (or to several). Divergent installs
 * are how self-updates "succeed" without changing the command the user types.
 * The warning re-fires only when the set of install roots changes; dev builds
 * (0.0.0-dev) are ignored because side-by-side dev installs are a supported
 * workflow.
 */
function maybeWarnMultiInstall(): void {
  const sentinel = path.join(getRuntimeStateDir(), 'multi-install-warned');
  const runningRoot = path.resolve(__dirname, '..');
  const byRoot = new Map<string, { version: string; note: string }>();
  byRoot.set(runningRoot, { version: VERSION, note: 'running' });
  for (const install of findAgentsCliInstalls(process.env.PATH || '')) {
    if (install.version.startsWith('0.0.0-dev')) continue;
    if (!byRoot.has(install.packageRoot)) {
      byRoot.set(install.packageRoot, { version: install.version, note: `agents on PATH: ${install.binPath}` });
    }
  }

  if (byRoot.size < 2) {
    try { fs.unlinkSync(sentinel); } catch { /* nothing recorded */ }
    return;
  }

  const key = [...byRoot.keys()].sort().join('\n');
  try {
    if (fs.readFileSync(sentinel, 'utf-8') === key) return;
  } catch { /* not warned for this set yet */ }

  console.error(chalk.yellow('Multiple agents-cli installs detected:'));
  for (const [root, info] of byRoot) {
    console.error(chalk.gray(`  ${root}  ${info.version}  (${info.note})`));
  }
  console.error(chalk.gray('Upgrades apply to the running copy. Remove a stale copy with: npm uninstall -g --prefix <prefix> @phnx-labs/agents-cli'));

  try {
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, key);
  } catch { /* best-effort; worst case the warning repeats */ }
}

/** Determine whether enough time has elapsed since the last registry fetch. */
function shouldFetchLatest(cache: UpdateCheckCache | null): boolean {
  if (!cache) return true;
  return Date.now() - cache.lastCheck > UPDATE_CHECK_INTERVAL_MS;
}

/** Fetch the exact latest npm version plus its registry integrity hash. */
async function fetchNpmPackageMetadata(versionOrTag = 'latest', timeoutMs = 5000): Promise<NpmPackageMetadata> {
  const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}/${versionOrTag}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${NPM_PACKAGE_NAME}@${versionOrTag} not found on npm`);
    }
    throw new Error('Could not reach npm registry');
  }

  const data = await response.json() as {
    version?: unknown;
    dist?: { integrity?: unknown };
  };
  if (typeof data.version !== 'string' || typeof data.dist?.integrity !== 'string') {
    throw new Error('npm registry response did not include version and integrity');
  }

  return { version: data.version, integrity: data.dist.integrity };
}

function printResolvedPackage(metadata: NpmPackageMetadata): void {
  console.log(chalk.gray(`Resolved: ${NPM_PACKAGE_NAME}@${metadata.version}`));
  console.log(chalk.gray(`Integrity: ${metadata.integrity}`));
}

async function installResolvedPackage(metadata: NpmPackageMetadata): Promise<void> {
  const packageRoot = path.resolve(__dirname, '..');
  const spec = `${NPM_PACKAGE_NAME}@${metadata.version}`;
  // Upgrade with the package manager that owns this install. A bun global
  // install lives at <bunGlobalDir>/node_modules/... (no `lib` segment), so an
  // `npm install --prefix` would write to <bunGlobalDir>/lib/node_modules and
  // never touch the running copy — npm exits 0, the verify below fails.
  if (detectPackageManager(packageRoot) === 'bun') {
    await installPackageWithBun(spec);
  } else {
    await installPackageIntoPrefix(spec, deriveGlobalPrefix(packageRoot));
  }
  verifyInstalledVersion(packageRoot, metadata.version);
  refreshAliasShims(packageRoot);
  // The npm install above runs with --ignore-scripts, so the postinstall that
  // installs the macOS Keychain helper never fires on upgrade. Force-refresh the
  // helper here so a user upgrading FROM a broken build (e.g. the entitlement-less
  // 1.20.4 helper that fails SecItemAdd with -34018) gets the fixed, signed bundle
  // immediately — instead of waiting for the lazy staleness check in
  // getKeychainHelperPath() to repair it on their next secret operation. The new
  // package is already on disk, so the dynamic import resolves the freshly-installed
  // helper module + bundle. Best-effort: an upgrade must never fail because the
  // helper could not be reinstalled (`agents helper install --force` stays available).
  if (process.platform === 'darwin') {
    try {
      const { ensureKeychainHelperInstalled } = await import('./lib/secrets/install-helper.js');
      ensureKeychainHelperInstalled({ forceReinstall: true });
    } catch {
      // Non-fatal.
    }
  }
}

/** Present an interactive upgrade prompt (TTY) or a one-line hint (non-TTY). */
async function promptUpgrade(latestVersion: string): Promise<void> {
  const { default: ora } = await import('ora');
  const { confirm, select } = await import('@inquirer/prompts');
  const { isInteractiveTerminal, isPromptCancelled } = await import('./commands/utils.js');
  if (!isInteractiveTerminal()) {
    console.error(chalk.yellow(`Update available: ${VERSION} -> ${latestVersion}. Run: agents upgrade --yes`));
    return;
  }

  const answer = await select({
    message: `Update available: ${VERSION} -> ${latestVersion}`,
    choices: [
      { value: 'now', name: 'Upgrade now' },
      { value: 'later', name: 'Later' },
      { value: 'dismiss', name: `Skip ${latestVersion}` },
    ],
  });

  if (answer === 'dismiss') {
    dismissUpdateVersion(UPDATE_CHECK_FILE, latestVersion);
    return;
  }

  if (answer === 'now') {
    const { spawnSync } = await import('child_process');
    let spinner = ora('Resolving package metadata...').start();
    try {
      const metadata = await fetchNpmPackageMetadata();
      // The prompt showed the cached latest, which can lag the registry (the
      // 24h window) — sync the cache to what was actually resolved so later
      // prompts and the install agree on the same version.
      saveUpdateCheck(UPDATE_CHECK_FILE, metadata.version);
      spinner.succeed(`Resolved ${NPM_PACKAGE_NAME}@${metadata.version}`);
      printResolvedPackage(metadata);

      const approved = await confirm({
        message: `Install ${NPM_PACKAGE_NAME}@${metadata.version}?`,
        default: false,
      });
      if (!approved) {
        console.log(chalk.gray('Upgrade cancelled'));
        return;
      }

      spinner = ora('Upgrading...').start();
      await installResolvedPackage(metadata);
      spinner.succeed(`Upgraded to ${metadata.version}`);
      await showWhatsNew(VERSION, metadata.version);
      console.log();
      // Re-exec the verified install's entrypoint and exit. PATH lookup of
      // `agents` could resolve a different copy (dev build, another prefix)
      // than the one that was just upgraded.
      const entrypoint = path.resolve(__dirname, '..', 'dist', 'index.js');
      const result = spawnSync(process.execPath, [entrypoint, ...process.argv.slice(2)], {
        stdio: 'inherit',
        shell: false,
      });
      process.exit(result.status ?? 0);
    } catch (err) {
      if (isPromptCancelled(err)) return;
      spinner.fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(chalk.gray('Run manually: agents upgrade --yes'));
    }
    console.log();
  }
}

/**
 * Background update check — fires once per 24h cache window.
 * Network: GET registry.npmjs.org/@phnx-labs/agents-cli/latest.
 * Disable: set AGENTS_CLI_DISABLE_AUTO_UPDATE=1 in shell rc.
 *
 * Fire-and-forget; never blocks the CLI's foreground operation.
 */
function refreshUpdateCacheInBackground(): void {
  fetch('https://registry.npmjs.org/@phnx-labs/agents-cli/latest', {
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data && typeof (data as any).version === 'string') {
        saveUpdateCheck(UPDATE_CHECK_FILE, (data as any).version);
      }
    })
    .catch(() => {
      /* network error, try again next invocation */
    });
}

/** Check for available updates using the local cache. Triggers a background refresh if stale. */
async function checkForUpdates(): Promise<void> {
  if (process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE) return;

  maybeWarnMultiInstall();

  const cache = readUpdateCache(UPDATE_CHECK_FILE);

  // Kick off network refresh in background if stale. Does not block.
  if (shouldFetchLatest(cache)) {
    refreshUpdateCacheInBackground();
  }

  // Prompt based on current cache (may be from a previous run's background refresh).
  // Skip if the user dismissed this exact version — they'll be prompted again when
  // a newer version appears.
  if (shouldPromptUpgrade(cache, VERSION)) {
    try {
      await promptUpgrade(cache!.latestVersion);
    } catch (err) {
      const { isPromptCancelled } = await import('./commands/utils.js');
      if (isPromptCancelled(err)) return;
      /* prompt error, ignore */
    }
  }
}

async function maybeBootstrapShimIntegration(
  requestedCommand: string | undefined,
  helpOrVersionRequested: boolean,
  verboseStartup: boolean,
): Promise<void> {
  if (!verboseStartup && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return;
  }
  // Pure documentation paths must never trigger interactive repair — mirrors
  // the helpOrVersionRequested gate around ensureInitialized below. Covers
  // both bare `agents --version` (requestedCommand === undefined) and
  // `agents <subcommand> --help` (requestedCommand === subcommand name).
  if (helpOrVersionRequested) {
    return;
  }
  if (requestedCommand === 'sync' || requestedCommand === 'refresh-rules') {
    return;
  }

  // Past the documentation/non-TTY guards: heal the shim/shadow/PATH conditions
  // through the unified self-heal registry — the SAME checks the daemon runs, but
  // driven silently on this interactive invocation so a user who never starts the
  // daemon still gets healed. Regenerating stale shims, adopting symlink launchers,
  // and adding the shims dir to PATH now happen without any output. The only thing
  // that ever prints is a ONE-TIME notice for what a machine can't silently fix
  // (a real native binary shadowing the shim) or is worth saying once (a PATH entry
  // just added). Suppression is persistent and keyed to the condition — a new
  // terminal no longer re-nags (the old per-PPID sentinel did, every shell).
  const { runInteractiveShimHeal } = await import('./lib/shim-heal.js');
  const { summarizeSelfHeal } = await import('./lib/self-heal/registry.js');
  const { noticeLines, report } = await runInteractiveShimHeal();
  if (verboseStartup) {
    process.stderr.write(`[agents] startup self-heal: ${summarizeSelfHeal(report)}\n`);
  }
  if (noticeLines) {
    for (const line of noticeLines) console.log(chalk.gray(line));
  }
}


// --- Inline command registrars ----------------------------------------------
// These commands are defined here rather than in a command module because they
// close over entry-point-local state (program re-parsing, VERSION, the npm
// upgrade helpers). The lazy registrar and the all-commands fallback below both
// call them, so the behavior is identical to the old eager registration.

// memory is a first-class resource command (see commands/memory.ts via
// COMMAND_LOADERS). The old memory→rules tombstone was removed in RUSH-1330.

/** Deprecated `perms` alias — re-parses as `permissions`. */
function registerPermsAliasCommand(p: Command): void {
  p.command('perms', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow('Deprecated: Use "agents permissions" instead of "agents perms"\n'));
      // Re-parse with 'permissions' command
      const args = process.argv.slice(2);
      args[0] = 'permissions';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

/** Deprecated `exec` alias — re-parses as `run`. */
function registerExecAliasCommand(p: Command): void {
  p.command('exec', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow('Deprecated: Use "agents run" instead of "agents exec"\n'));
      const args = process.argv.slice(2);
      args[0] = 'run';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

/** Deprecated `jobs` / `cron` aliases — re-parse as `routines`. */
function registerJobsCronAliasCommand(p: Command, alias: string): void {
  p.command(alias, { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow(`Deprecated: Use "agents routines" instead of "agents ${alias}"\n`));
      const args = process.argv.slice(2);
      args[0] = 'routines';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

/** Self-upgrade command (`agents upgrade [version]`). */
function registerUpgradeCommand(p: Command): void {
  p.command('upgrade')
    .description('Upgrade agents-cli to the latest version (or a specific [version])')
    .argument('[version]', 'Target version or dist-tag to install (default: latest)')
    .option('-y, --yes', 'Install without an interactive confirmation prompt')
    .action(async (version: string | undefined, options: { yes?: boolean }) => {
      const { default: ora } = await import('ora');
      const { confirm } = await import('@inquirer/prompts');
      const { isInteractiveTerminal, isPromptCancelled } = await import('./commands/utils.js');
      const target = version ?? 'latest';
      let spinner = ora(version ? `Resolving ${NPM_PACKAGE_NAME}@${target}...` : 'Checking for updates...').start();
      try {
        const metadata = await fetchNpmPackageMetadata(target);
        const resolvedVersion = metadata.version;

        if (resolvedVersion === VERSION) {
          spinner.succeed(`Already on ${VERSION}`);
          return;
        }

        // For `latest` (no explicit version) skip when already ahead. When a
        // version is named explicitly, honor it even if it's a downgrade.
        if (!version && compareVersions(resolvedVersion, VERSION) <= 0) {
          spinner.succeed(`Already ahead of latest (${VERSION} >= ${resolvedVersion})`);
          return;
        }

        const direction = compareVersions(resolvedVersion, VERSION) < 0 ? 'Downgrade' : 'Upgrade';
        spinner.succeed(`Resolved ${NPM_PACKAGE_NAME}@${resolvedVersion}`);
        printResolvedPackage(metadata);
        if (isInteractiveTerminal() && !options.yes) {
          const approved = await confirm({
            message: `Install ${NPM_PACKAGE_NAME}@${resolvedVersion}?`,
            default: false,
          });
          if (!approved) {
            console.log(chalk.gray('Upgrade cancelled'));
            return;
          }
        }

        spinner = ora(`${direction === 'Downgrade' ? 'Downgrading' : 'Upgrading'} ${VERSION} -> ${resolvedVersion}...`).start();
        await installResolvedPackage(metadata);
        spinner.succeed(`${direction}d to ${resolvedVersion}`);
        // Only show the changelog for a genuine upgrade range.
        if (compareVersions(resolvedVersion, VERSION) > 0) {
          await showWhatsNew(VERSION, resolvedVersion);
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        spinner.fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log(chalk.gray(`Run manually: agents upgrade ${version ? version + ' ' : ''}--yes`));
      }
    });
}

// --- Lazy registration orchestration -----------------------------------------

/** Import a command module via its loader and register it on the program. */
async function reg(loader: ModuleLoader): Promise<void> {
  (await loader())(program);
}

/**
 * Register exactly the command(s) the requested top-level name needs.
 * Returns false when the name maps to no known command (typo / unknown) so the
 * caller can fall back to registering everything for spellcheck.
 *
 * Lazy commands (sessions/teams/cloud) are intentionally NOT handled here — they
 * must register after applyGlobalHelpConventions to match main's ordering.
 */
async function registerEagerForRequest(name: string): Promise<boolean> {
  switch (name) {
    case 'perms':
      // The action re-parses as `permissions`, so that target must exist too.
      registerPermsAliasCommand(program);
      await reg(loadPermissions);
      return true;
    case 'exec':
      registerExecAliasCommand(program);
      await reg(loadRun);
      return true;
    case 'jobs':
    case 'cron':
      registerJobsCronAliasCommand(program, name);
      await reg(loadRoutines);
      return true;
    case 'upgrade':
      registerUpgradeCommand(program);
      return true;
  }

  const loaders = COMMAND_LOADERS[name];
  if (!loaders) return false;
  for (const loader of loaders) await reg(loader);
  return true;
}

/**
 * Register every command in the EXACT order main does (old src/index.ts lines
 * 691-844), including the inline deprecated aliases. Used only on the slow paths
 * (unknown command spellcheck, "did you mean" auto-correct) where the full set
 * of names — and their registration order, which breaks ties in the suggestion
 * picker — must match main byte-for-byte.
 */
async function registerAllEagerCommands(): Promise<void> {
  await reg(loadView);
  await reg(loadInspect);
  await reg(loadFeedback);
  await reg(loadCommands);
  await reg(loadHooks);
  await reg(loadSkills);
  await reg(loadRules);
  await reg(loadMemory);
  await reg(loadPermissions);
  registerPermsAliasCommand(program);
  await reg(loadMcp);
  await reg(loadCli);
  await reg(loadSubagents);
  await reg(loadPlugins);
  await reg(loadWorkflows);
  await reg(loadWorktree);
  await reg(loadVersions);
  await reg(loadImport);
  await reg(loadPackages);
  await reg(loadDaemon);
  await reg(loadRoutines);
  await reg(loadRun);
  await reg(loadDefaults);
  await reg(loadModels);
  await reg(loadPrune);
  await reg(loadTrash);
  await reg(loadRestore);
  await reg(loadDoctor);
  await reg(loadCheck);
  await reg(loadStatus);
  registerExecAliasCommand(program);
  await reg(loadProfiles);
  await reg(loadSecrets);
  await reg(loadWallet);
  await reg(loadHelper);
  await reg(loadMenubar);
  await reg(loadBeta);
  await reg(loadSync);
  await reg(loadLock);
  await reg(loadRefreshRules);
  await reg(loadDrive);
  await reg(loadFactory);
  await reg(loadUsage);
  await reg(loadCost);
  await reg(loadBudget);
  await reg(loadAlias);
  await reg(loadPty);
  await reg(loadTmux);
  await reg(loadWatchdog);
  await reg(loadBrowser);
  await reg(loadComputer);
  await reg(loadHosts);
  await reg(loadLogs);
  await reg(loadEvents);
  await reg(loadAudit);
  await reg(loadFeed);
  await reg(loadSsh);
  registerJobsCronAliasCommand(program, 'jobs');
  registerJobsCronAliasCommand(program, 'cron');
  registerUpgradeCommand(program);
  await reg(loadPull);
  await reg(loadPush);
  await reg(loadRepo);
  await reg(loadSetup);
}

/** Calculate the Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Auto-correct typos with edit distance 1
program.on('command:*', (operands) => {
  const unknown = operands[0];
  const allCommands = program.commands.map((c) => c.name());

  let closest: string | null = null;
  let minDist = Infinity;
  for (const cmd of allCommands) {
    const dist = levenshtein(unknown, cmd);
    if (dist < minDist) {
      minDist = dist;
      closest = cmd;
    }
  }

  if (minDist === 1 && closest) {
    const args = process.argv.slice(2);
    args[0] = closest;
    program.parse(['node', 'agents', ...args]);
    return;
  }

  console.error(`error: unknown command '${unknown}'`);
  if (closest && minDist <= 3) {
    console.error(`(Did you mean ${closest}?)`);
  }
  process.exit(1);
});

// Parse the invocation shape up front: the first non-flag token is the command,
// and the doc flags (--version/--help/-h) drive both the registration strategy
// and whether the update check + background sync run at all.
const passedArgs = process.argv.slice(2);
const requestedCommand = passedArgs.find((arg) => !arg.startsWith('-'));
const verboseStartup = passedArgs.includes('--verbose');
// Help and version output are pure documentation — they must never gate on
// setup, otherwise `agents <cmd> --help` becomes useless on a fresh box.
const helpOrVersionRequested = passedArgs.some(
  (arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V',
);

// `--host` passthrough: run this invocation on a remote machine over SSH instead
// of locally. Handled before any local command registration / update check /
// background sync — a remote run needs none of that. Only the allowlisted
// read-only + config + teams commands route here; `run`/`sessions` are absent
// from the table and fall through to their own richer `--host` handling below.
// `--help`/`--version` stay local (docs must work without a reachable host).
if (requestedCommand !== undefined && !helpOrVersionRequested) {
  const { maybeRunOnHost } = await import('./lib/hosts/passthrough.js');
  if (await maybeRunOnHost(requestedCommand, passedArgs)) {
    process.exit(process.exitCode ?? 0);
  }
}

// Register only the command(s) this invocation actually uses. Lazy commands
// (sessions/teams/cloud) are handled after applyGlobalHelpConventions below.
const isLazyRequest = requestedCommand !== undefined && LAZY_COMMAND_NAMES.has(requestedCommand);
if (requestedCommand !== undefined && !isLazyRequest) {
  const known = await registerEagerForRequest(requestedCommand);
  if (!known) {
    // Unknown top-level command: register the full tree so the "did you mean"
    // spellcheck and edit-distance-1 auto-correct (the command:* handler above)
    // see the same candidate set — and ordering — as main.
    await registerAllEagerCommands();
  }
}
// When requestedCommand is undefined (bare invocation, --version, --help, -h) no
// command modules are needed: --version is built in and the root help text is a
// static string.

// Mirror main: help conventions are applied after the eager command tree and
// before the lazy commands, so the latter inherit the root's custom help
// formatter instead of getting the per-command recursive pass.
applyGlobalHelpConventions(program);

// Lazy commands pull in the SQLite-backed session/cloud stack; register them
// only when explicitly requested, keeping lightweight commands off that path.
if (isLazyRequest) {
  for (const loader of COMMAND_LOADERS[requestedCommand!]) await reg(loader);
}

// Pure documentation paths (--version / --help / -h) return immediately: skip
// the update check (PATH scan + cache read) and the detached background sync
// (spawns a child process) that every other invocation runs.
if (!helpOrVersionRequested) {
  // Run update check before parsing so the upgrade notice/prompt precedes output.
  await checkForUpdates();

  // Surface any "behind upstream" notices from the previous detached sync, then
  // fire-and-forget the next background sync. System repo gets a real fast-forward
  // pull (read-only locally, safe). User repo and extras get fetch-only + a
  // status marker that we'll print on the *next* invocation.
  const { spawnDetachedSync, printPendingUpdateNotices } = await import('./lib/auto-pull.js');
  printPendingUpdateNotices();
  spawnDetachedSync();
}

// First-run experience: no args + no config yet + TTY -> launch interactive setup.
// Skipped when stdin/stdout isn't a terminal (CI, pipes) or when user passes any args.
const metaFilePath = path.join(getUserAgentsDir(), 'agents.yaml');
const firstRun =
  passedArgs.length === 0 &&
  !fs.existsSync(metaFilePath) &&
  process.stdin.isTTY &&
  process.stdout.isTTY;

if (firstRun) {
  try {
    const { runSetup } = await import('./commands/setup.js');
    await runSetup(program);
  } catch (err) {
    if (!(err instanceof Error && err.name === 'ExitPromptError')) {
      throw err;
    }
  }
  process.exit(0);
}

// Every command requires the system repo to be cloned first. `setup` is the
// only exemption — it's the command that does the cloning.
const SETUP_EXEMPT_COMMANDS = new Set(['setup', 'help']);

// Fold legacy ~/.agents-system/ into ~/.agents/.system/ BEFORE ensureInitialized
// runs. ensureInitialized checks for .git inside the new path; if the user is
// upgrading from a layout where .git lives under the legacy path, the check
// would fail and exit before the migrator ever runs. Also runs outside the
// sentinel guard below because the sentinel was set by pre-fold releases and
// would otherwise skip this step on every existing install. Idempotent —
// no-ops when legacy is missing or already a symlink.
if (process.env.AGENTS_SKIP_MIGRATION !== '1') {
  try {
    const { foldLegacySystemRepo } = await import('./lib/migrate.js');
    foldLegacySystemRepo();
  } catch { /* must never block CLI startup */ }
}

if (
  !firstRun &&
  requestedCommand &&
  !SETUP_EXEMPT_COMMANDS.has(requestedCommand) &&
  !helpOrVersionRequested
) {
  const { ensureInitialized } = await import('./commands/setup.js');
  await ensureInitialized(program);
}

// One-shot idempotent migrations (split-layout, legacy file moves).
// Each step is internally guarded by existence checks so it's safe to run
// every invocation. A sentinel file in the system dir short-circuits the
// scan once a migration version has run, so the hot path stays cheap.
// AGENTS_SKIP_MIGRATION=1 disables the bootstrap-time run for tests and
// scripted invocations that prepare their own legacy fixtures.
if (process.env.AGENTS_SKIP_MIGRATION !== '1') {
  try {
    const { runMigration } = await import('./lib/migrate.js');
    const sentinel = getMigratedSentinelPath();
    // Sentinel is keyed to the migration SCHEMA version, not the binary version.
    // Bumping the suffix re-runs migrations for every user; binary releases that
    // don't change the schema must NOT re-run (they would destroy user content
    // when migration steps overlap with user-authored paths). See issue #20.
    const sentinelValue = 'v11';
    let needRun = true;
    try {
      if (fs.existsSync(sentinel) && fs.readFileSync(sentinel, 'utf-8').trim() === sentinelValue) {
        needRun = false;
      }
    } catch { /* best-effort — fall through to run */ }
    if (needRun) {
      await runMigration();
      try {
        fs.mkdirSync(path.dirname(sentinel), { recursive: true });
        fs.writeFileSync(sentinel, sentinelValue);
      } catch { /* best-effort */ }
    }
  } catch { /* migration must never block CLI startup */ }
}

// Auto-enable the macOS menu-bar helper once, for every user. Best-effort and
// idempotent: installMenubarLaunchAgentOnUpgrade() no-ops when not on darwin,
// when the user ran `agents menubar disable` (sticky opt-out), when the service
// is already installed, or when no helper bundle ships with this build. This is
// a lightweight startup self-heal (two existsSync checks then return) rather
// than a migration-sentinel bump, so it covers fresh installs AND upgrades
// without re-running the full migration for the whole user base (issue #20).
if (process.platform === 'darwin' && process.env.AGENTS_SKIP_MIGRATION !== '1') {
  try {
    const { installMenubarLaunchAgentOnUpgrade } = await import('./lib/menubar/install-menubar.js');
    installMenubarLaunchAgentOnUpgrade();
  } catch { /* never block CLI startup on the menu bar */ }
}

// Bare invocation prints the root help. Commander only auto-displays help on
// an empty parse when subcommands are registered, and the lazy-startup path
// registers none for a bare call — without this branch, `agents` exits
// silently. Runs after first-run setup and migrations so those still fire;
// exits 0 to match `agents --help` (and the pre-fix exit code).
if (passedArgs.length === 0) {
  program.outputHelp();
  process.exit(0);
}

try {
  await maybeBootstrapShimIntegration(requestedCommand, helpOrVersionRequested, verboseStartup);
  await program.parseAsync();
} catch (err) {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    process.exit(130);
  }
  // Browser-daemon-not-running and CDP-not-reachable surface as typed errors
  // from src/lib/browser/. Don't dump a Node stacktrace for these — they are
  // user-actionable, not engineering bugs. See issues #41 and #43.
  if (err instanceof Error) {
    const isBrowserDaemonNotRunning = err.name === 'BrowserDaemonNotRunningError';
    const isBrowserCdpUnreachable = err.name === 'BrowserCdpConnectionError';
    const isBrowserIpcDown =
      err.message.startsWith('IPC error:') &&
      (err.message.includes('ECONNREFUSED') || err.message.includes('ENOENT'));
    if (isBrowserDaemonNotRunning || isBrowserCdpUnreachable || isBrowserIpcDown) {
      console.error(err.message);
      process.exit(1);
    }
    // A --host targeting a password-auth device throws this from resolveHost.
    // It carries an actionable message (switch to key auth / enroll as a host);
    // handling it here covers every resolveHost caller (run, hosts check/rm,
    // secrets --host) at the source instead of a catch at each call site.
    if (err.name === 'DeviceOffloadUnsupportedError') {
      console.error(err.message);
      process.exit(1);
    }
  }
  throw err;
}
