#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

/**
 * CLI entry point for agents-cli.
 *
 * Registers all commands, handles update checks, auto-corrects typos,
 * and launches the first-run interactive setup when appropriate.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { confirm, select } from '@inquirer/prompts';

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
const NPM_PACKAGE_NAME = '@phnx-labs/agents-cli';

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
const IS_DEV_BUILD: boolean = (() => {
  if (VERSION.startsWith('0.0.0-dev')) return true;
  try {
    const cliPath = process.argv[1] || '';
    const repoRoot = path.dirname(path.dirname(cliPath));
    return fs.existsSync(path.join(repoRoot, '.git'));
  } catch { return false; }
})();
if (IS_DEV_BUILD) {
  if (process.env.AGENTS_NO_AUTOPULL === undefined) process.env.AGENTS_NO_AUTOPULL = '1';
  if (process.env.AGENTS_SKIP_MIGRATION === undefined) process.env.AGENTS_SKIP_MIGRATION = '1';
  if (process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE === undefined) process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE = '1';
}

// Import command registrations
import { registerPullCommand } from './commands/pull.js';
import { registerRepoCommands } from './commands/repo.js';
import { registerSetupCommand, runSetup } from './commands/setup.js';
import { registerStatusCommand } from './commands/status.js';
import { registerViewCommand } from './commands/view.js';
import { registerCommandsCommands } from './commands/commands.js';
import { registerHooksCommands } from './commands/hooks.js';
import { registerSkillsCommands } from './commands/skills.js';
import { registerRulesCommands } from './commands/rules.js';
import { registerPermissionsCommands } from './commands/permissions.js';
import { registerMcpCommands } from './commands/mcp.js';
import { registerVersionsCommands } from './commands/versions.js';
import { registerImportCommand } from './commands/import.js';
import { registerPackagesCommands } from './commands/packages.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerRoutinesCommands } from './commands/routines.js';
import { registerRunCommand } from './commands/exec.js';
import { registerModelsCommand } from './commands/models.js';
import { registerPruneCommand } from './commands/prune.js';
import { registerTrashCommands } from './commands/trash.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerSubagentsCommands } from './commands/subagents.js';
import { registerPluginsCommands } from './commands/plugins.js';
import { registerWorkflowsCommands } from './commands/workflows.js';
import { registerWorktreeCommands } from './commands/worktree.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerRefreshRulesCommand } from './commands/refresh-rules.js';
import { registerDriveCommands } from './commands/drive.js';
import { registerPtyCommands } from './commands/pty.js';
import { registerBrowserCommand } from './commands/browser.js';
import { registerProfilesCommands } from './commands/profiles.js';
import { registerSecretsCommands } from './commands/secrets.js';
import { registerFactoryCommands } from './commands/factory.js';
import { registerUsageCommand } from './commands/usage.js';
import { registerAliasCommand } from './commands/alias.js';
import { registerBetaCommands } from './commands/beta.js';
import { applyGlobalHelpConventions } from './lib/help.js';
import { isInteractiveTerminal, isPromptCancelled } from './commands/utils.js';
import { getAgentsDir } from './lib/state.js';
import { AGENTS } from './lib/agents.js';
import { getGlobalDefault, listInstalledVersions } from './lib/versions.js';
import {
  addShimsToPath,
  ensureShimCurrent,
  ensureVersionedAliasCurrent,
  getPathShadowingExecutable,
  getPathSetupInstructions,
  hasAliasShadowingShim,
  isShimsInPath,
  listAgentsWithInstalledVersions,
  removeLegacyUserShim,
} from './lib/shims.js';

const program = new Command();

program
  .name('agents')
  .description('Environment manager for AI agents')
  .version(VERSION)
  .helpOption('-h, --help', 'Show help')
  .addHelpCommand(false);

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
  add <agent>[@version]           Install an agent CLI (e.g. agents add codex)
  import <agent>                  Adopt an existing global install (npm/homebrew) into agents-cli
  remove <agent>[@version]        Uninstall a version
  use <agent>@<version>           Set the default version
  prune [target]                  Remove orphan resources and older duplicate version installs (targets: commands, sessions, runs, trash)
  trash                           Inspect and restore soft-deleted version directories
  view [agent[@version]]          List versions, or inspect one in detail

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
  teams                           Coordinate multiple agents on shared work
  routines                        Run agents on a cron schedule (scheduler auto-starts)
  sessions                        Browse, search, and replay past runs (live-search in TTY; grouped by workspace)
  browser                         Automate a browser — navigate, click, screenshot, console, network
  pty                             Drive interactive terminal programs (REPLs, TUIs) via a persistent PTY session

Credentials and profiles:
  profiles                        Bundles of (host CLI, endpoint, model, auth)
  secrets                         Keychain-backed env bundles; use 'secrets exec <bundle> -- <cmd>' to inject into a subprocess

Diagnostics:
  doctor [agent[@version]]        Diagnose CLI availability, sync status, and resource divergence
  usage [agent]                   Show rate-limit and quota usage per agent

Config sync:
  drive                           Sync session history across machines via rsync
  pull                            Clone or pull the system repo at ~/.agents-system/
  repo init --path <dir>          Scaffold your own editable repo from a template
  repo add <path|gh:user/repo>    Merge an extra repo after the system repo

Beta features:
  beta                            Enable preview features (factory, drive, and more)

Automation tips:
  Pass explicit names/IDs         Avoid pickers: agents sessions <id> --markdown
  Use --yes for defaults          Auto-accept sync/default prompts on add/use/pull
  Use --names for central items   e.g. agents commands add --names review-pr,debug
  Use agent@version targets       e.g. --agents claude@2.1.79,codex@default
  Non-TTY shells apply defaults   Omitted required selections fail with a plain hint

Options:
  -V, --version                   Show version number
  -h, --help                      Show help

System config lives in ~/.agents-system/. Run 'agents <command> --help' for details.
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

    const changelog = await response.text();
    const lines = changelog.split('\n');

    const relevantChanges: string[] = [];
    let inRelevantSection = false;
    let currentVersion = '';

    for (const line of lines) {
      const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
      if (versionMatch) {
        currentVersion = versionMatch[1];
        const isNewer = currentVersion !== fromVersion &&
          compareVersions(currentVersion, fromVersion) > 0;
        inRelevantSection = isNewer;
        if (inRelevantSection) {
          relevantChanges.push('');
          relevantChanges.push(chalk.bold(`v${currentVersion}`));
        }
        continue;
      }

      if (inRelevantSection && line.trim()) {
        if (line.startsWith('**') && line.endsWith('**')) {
          relevantChanges.push(chalk.cyan(line.replace(/\*\*/g, '')));
        } else if (line.startsWith('- ')) {
          relevantChanges.push(chalk.gray(`  ${line}`));
        }
      }
    }

    if (relevantChanges.length > 0) {
      console.log(chalk.bold("\nWhat's new:\n"));
      for (const line of relevantChanges) {
        console.log(line);
      }
      console.log();
    }
  } catch {
    // Silently ignore changelog fetch errors
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
import { getUpdateCheckPath, getMigratedSentinelPath, getUserAgentsDir } from './lib/state.js';
const UPDATE_CHECK_FILE = getUpdateCheckPath();

/** Read the cached update-check state from disk. Returns null if the file is missing or corrupt. */
function readUpdateCache(): { lastCheck: number; latestVersion: string; dismissed?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8'));
  } catch {
    /* cache file missing or corrupt */
    return null;
  }
}

/** Determine whether enough time has elapsed since the last registry fetch. */
function shouldFetchLatest(cache: { lastCheck: number } | null): boolean {
  if (!cache) return true;
  return Date.now() - cache.lastCheck > UPDATE_CHECK_INTERVAL_MS;
}

/** Persist the latest known version and current timestamp to the update-check cache. */
function saveUpdateCheck(latestVersion: string): void {
  try {
    const dir = path.dirname(UPDATE_CHECK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ lastCheck: Date.now(), latestVersion }));
  } catch {
    /* best-effort cache update */
  }
}

/** Fetch the exact latest npm version plus its registry integrity hash. */
async function fetchLatestNpmPackageMetadata(timeoutMs = 5000): Promise<NpmPackageMetadata> {
  const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
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
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const installArgs = ['install', '-g', '@phnx-labs/agents-cli', '--ignore-scripts'];
  installArgs[2] = `${NPM_PACKAGE_NAME}@${metadata.version}`;
  await execFileAsync('npm', installArgs);
}

/** Present an interactive upgrade prompt (TTY) or a one-line hint (non-TTY). */
async function promptUpgrade(latestVersion: string): Promise<void> {
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
    try {
      const dir = path.dirname(UPDATE_CHECK_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const existing = readUpdateCache();
      fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({
        ...existing,
        lastCheck: existing?.lastCheck ?? Date.now(),
        latestVersion,
        dismissed: latestVersion,
      }));
    } catch { /* best-effort */ }
    return;
  }

  if (answer === 'now') {
    const { spawnSync } = await import('child_process');
    let spinner = ora('Resolving package metadata...').start();
    try {
      const metadata = await fetchLatestNpmPackageMetadata();
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
      // Re-exec with new version and exit
      const result = spawnSync('agents', process.argv.slice(2), {
        stdio: 'inherit',
        shell: false,
      });
      process.exit(result.status ?? 0);
    } catch {
      spinner.fail('Upgrade failed');
      console.log(chalk.gray('Run manually: agents upgrade --yes'));
    }
    console.log();
  }
}

/** Fire-and-forget: refresh the registry cache in background. Never blocks the command. */
function refreshUpdateCacheInBackground(): void {
  fetch('https://registry.npmjs.org/@phnx-labs/agents-cli/latest', {
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data && typeof (data as any).version === 'string') {
        saveUpdateCheck((data as any).version);
      }
    })
    .catch(() => {
      /* network error, try again next invocation */
    });
}

/** Check for available updates using the local cache. Triggers a background refresh if stale. */
async function checkForUpdates(): Promise<void> {
  if (process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE) return;

  const cache = readUpdateCache();

  // Kick off network refresh in background if stale. Does not block.
  if (shouldFetchLatest(cache)) {
    refreshUpdateCacheInBackground();
  }

  // Prompt based on current cache (may be from a previous run's background refresh).
  // Skip if the user dismissed this exact version — they'll be prompted again when
  // a newer version appears.
  if (cache?.latestVersion && cache.latestVersion !== VERSION && compareVersions(cache.latestVersion, VERSION) > 0 && cache.latestVersion !== cache.dismissed) {
    try {
      await promptUpgrade(cache.latestVersion);
    } catch (err) {
      if (isPromptCancelled(err)) return;
      /* prompt error, ignore */
    }
  }
}

async function maybeBootstrapShimIntegration(requestedCommand: string | undefined): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }
  if (requestedCommand === 'sync' || requestedCommand === 'refresh-rules') {
    return;
  }

  const installedAgents = listAgentsWithInstalledVersions();
  if (installedAgents.length === 0) {
    return;
  }

  const createdOrUpdated: string[] = [];
  for (const agent of installedAgents) {
    const status = ensureShimCurrent(agent);
    if (status !== 'current') {
      createdOrUpdated.push(`${status === 'created' ? 'Created' : 'Updated'} ${AGENTS[agent].cliCommand} shim`);
    }
    for (const version of listInstalledVersions(agent)) {
      const aliasStatus = ensureVersionedAliasCurrent(agent, version);
      if (aliasStatus !== 'current') {
        createdOrUpdated.push(`${aliasStatus === 'created' ? 'Created' : 'Updated'} ${AGENTS[agent].cliCommand}@${version} alias`);
      }
    }
  }
  for (const notice of createdOrUpdated) {
    console.log(chalk.green(notice));
  }

  // Best-effort: remove leftover ~/.agents/shims/<cli> files from the pre-split
  // layout BEFORE running detection. These cause false-positive "shadowing"
  // results that make the repair prompt loop forever (the prompt user said
  // "yes" to never deletes the file; next invocation finds it again).
  for (const agent of installedAgents) {
    removeLegacyUserShim(agent);
  }

  const defaultAgents = installedAgents.filter((agent) => getGlobalDefault(agent));
  const shadowed = defaultAgents
    .map((agent) => ({ agent, shadowedBy: getPathShadowingExecutable(agent) }))
    .filter((item): item is { agent: keyof typeof AGENTS; shadowedBy: string } => Boolean(item.shadowedBy));

  // Also check for shell aliases that shadow the shim
  const aliased = defaultAgents.filter((agent) => hasAliasShadowingShim(agent));

  // If shims are in PATH and nothing is binary-shadowing, we're done.
  // Shell aliases that call the same command with extra flags are intentional
  // customization and don't break shim integration.
  if (shadowed.length === 0 && isShimsInPath()) {
    return;
  }

  // Suppress repeated prompts within the same shell. A successful rc-file
  // edit doesn't reload the parent shell, so the next invocation sees the
  // same PATH and re-fires detection. The sentinel survives only as long as
  // the parent shell process — once the user opens a new terminal, the
  // PPID changes and the prompt is allowed again.
  const sentinelPath = path.join(os.tmpdir(), `agents-shim-prompted-${process.ppid}`);
  if (fs.existsSync(sentinelPath)) {
    return;
  }

  const affected: string[] = [];
  for (const { agent, shadowedBy } of shadowed) {
    affected.push(`${AGENTS[agent].cliCommand} -> ${shadowedBy}`);
  }
  for (const agent of aliased) {
    if (!shadowed.some((s) => s.agent === agent)) {
      affected.push(`${AGENTS[agent].cliCommand} (alias)`);
    }
  }
  if (affected.length === 0) {
    // PATH issue - show all installed agents
    affected.push(...installedAgents.map((agent) => AGENTS[agent].cliCommand));
  }

  const shouldRepair = await confirm({
    message: `Repair shim integration now? ${affected.join(', ')}`,
    default: true,
  });

  if (!shouldRepair) {
    console.log(chalk.yellow('Shim integration still needs attention.'));
    console.log(chalk.gray(getPathSetupInstructions()));
    try { fs.writeFileSync(sentinelPath, '1'); } catch { /* best-effort */ }
    return;
  }

  const pathResult = addShimsToPath();
  if (!pathResult.success) {
    console.log(chalk.yellow('Could not repair shim PATH setup automatically.'));
    console.log(chalk.gray(pathResult.error || getPathSetupInstructions()));
    return;
  }

  if (pathResult.alreadyPresent) {
    console.log(chalk.yellow('Shim PATH entry is already in your shell config, but this shell has not reloaded it yet.'));
  } else {
    console.log(chalk.green(`Repaired shim PATH setup in ~/${pathResult.rcFile}`));
  }
  console.log(chalk.gray(getPathSetupInstructions()));
  try { fs.writeFileSync(sentinelPath, '1'); } catch { /* best-effort */ }
}


// Register all commands
registerViewCommand(program);
registerStatusCommand(program);
registerCommandsCommands(program);
registerHooksCommands(program);
registerSkillsCommands(program);
registerRulesCommands(program);

// Deprecated 'memory' command - hard error, force users to use 'rules'
program
  .command('memory', { hidden: true })
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    console.error(chalk.red('"agents memory" has been renamed to "agents rules".'));
    console.error(chalk.gray('Run "agents rules --help" for usage.\n'));
    process.exit(1);
  });
registerPermissionsCommands(program);

// Deprecated 'perms' alias for 'permissions'
program
  .command('perms', { hidden: true })
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (opts, cmd) => {
    console.log(chalk.yellow('Deprecated: Use "agents permissions" instead of "agents perms"\n'));
    // Re-parse with 'permissions' command
    const args = process.argv.slice(2);
    args[0] = 'permissions';
    await program.parseAsync(['node', 'agents', ...args]);
  });

registerMcpCommands(program);
registerSubagentsCommands(program);
registerPluginsCommands(program);
registerWorkflowsCommands(program);
registerWorktreeCommands(program);
registerVersionsCommands(program);
registerImportCommand(program);
registerPackagesCommands(program);
registerDaemonCommands(program);
registerRoutinesCommands(program);
registerRunCommand(program);
registerModelsCommand(program);
registerPruneCommand(program);
registerTrashCommands(program);
registerDoctorCommand(program);

// Deprecated 'exec' alias for 'run'
program
  .command('exec', { hidden: true })
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    console.log(chalk.yellow('Deprecated: Use "agents run" instead of "agents exec"\n'));
    const args = process.argv.slice(2);
    args[0] = 'run';
    await program.parseAsync(['node', 'agents', ...args]);
  });

registerProfilesCommands(program);
registerSecretsCommands(program);
registerBetaCommands(program);
registerSyncCommand(program);
registerRefreshRulesCommand(program);
registerDriveCommands(program);
registerFactoryCommands(program);
registerUsageCommand(program);
registerAliasCommand(program);
registerPtyCommands(program);
registerBrowserCommand(program);

// Deprecated 'jobs' and 'cron' aliases for 'routines'
for (const alias of ['jobs', 'cron']) {
  program
    .command(alias, { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow(`Deprecated: Use "agents routines" instead of "agents ${alias}"\n`));
      const args = process.argv.slice(2);
      args[0] = 'routines';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

program
    .command('upgrade')
    .description('Upgrade agents-cli to the latest version')
    .option('-y, --yes', 'Install without an interactive confirmation prompt')
    .action(async (options: { yes?: boolean }) => {
      let spinner = ora('Checking for updates...').start();
      try {
        const metadata = await fetchLatestNpmPackageMetadata();
        const latestVersion = metadata.version;

        if (latestVersion === VERSION) {
          spinner.succeed(`Already on latest version (${VERSION})`);
          return;
        }

        if (compareVersions(latestVersion, VERSION) <= 0) {
          spinner.succeed(`Already ahead of latest (${VERSION} >= ${latestVersion})`);
          return;
        }

        spinner.succeed(`Resolved ${NPM_PACKAGE_NAME}@${latestVersion}`);
        printResolvedPackage(metadata);
        if (isInteractiveTerminal() && !options.yes) {
          const approved = await confirm({
            message: `Install ${NPM_PACKAGE_NAME}@${latestVersion}?`,
            default: false,
          });
          if (!approved) {
            console.log(chalk.gray('Upgrade cancelled'));
            return;
          }
        }

        spinner = ora(`Upgrading ${VERSION} -> ${latestVersion}...`).start();
        await installResolvedPackage(metadata);
        spinner.succeed(`Upgraded to ${latestVersion}`);
        await showWhatsNew(VERSION, latestVersion);
      } catch (err) {
        spinner.fail('Upgrade failed');
        console.log(chalk.gray('Run manually: agents upgrade --yes'));
      }
    });

registerPullCommand(program);
registerRepoCommands(program);
registerSetupCommand(program);

applyGlobalHelpConventions(program);

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

// Run update check on EVERY invocation before parsing
await checkForUpdates();

// Surface any "behind upstream" notices from the previous detached sync, then
// fire-and-forget the next background sync. System repo gets a real fast-forward
// pull (read-only locally, safe). User repo and extras get fetch-only + a
// status marker that we'll print on the *next* invocation.
const { spawnDetachedSync } = await import('./lib/auto-pull.js');
spawnDetachedSync();

// First-run experience: no args + no config yet + TTY -> launch interactive setup.
// Skipped when stdin/stdout isn't a terminal (CI, pipes) or when user passes any args.
const passedArgs = process.argv.slice(2);
const requestedCommand = passedArgs.find((arg) => !arg.startsWith('-'));

/**
 * Lazily register command trees that pull in the SQLite-backed session/cloud
 * stack. This keeps lightweight commands like `agents view` from loading the
 * DB layer during CLI startup.
 */
async function registerLazyCommands(): Promise<void> {
  switch (requestedCommand) {
    case 'sessions': {
      const { registerSessionsCommands } = await import('./commands/sessions.js');
      registerSessionsCommands(program);
      break;
    }
    case 'teams': {
      const { registerTeamsCommands } = await import('./commands/teams.js');
      registerTeamsCommands(program);
      break;
    }
    case 'cloud': {
      const { registerCloudCommands } = await import('./commands/cloud.js');
      registerCloudCommands(program);
      break;
    }
    default:
      break;
  }
}

await registerLazyCommands();
const metaFilePath = path.join(getUserAgentsDir(), 'agents.yaml');
const firstRun =
  passedArgs.length === 0 &&
  !fs.existsSync(metaFilePath) &&
  process.stdin.isTTY &&
  process.stdout.isTTY;

if (firstRun) {
  try {
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

if (!firstRun && requestedCommand && !SETUP_EXEMPT_COMMANDS.has(requestedCommand)) {
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
    const sentinelValue = 'v9';
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

try {
  await maybeBootstrapShimIntegration(requestedCommand);
  await program.parseAsync();
} catch (err) {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    process.exit(130);
  }
  throw err;
}
