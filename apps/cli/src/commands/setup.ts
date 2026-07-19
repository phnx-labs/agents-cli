/**
 * First-run setup command.
 *
 * Registers the `agents setup` command which clones the system repo into
 * ~/.agents/.system/ and installs agent CLIs with resource syncing.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { confirm } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from '../lib/types.js';
import { getAgentsDir, getVersionsDir, ensureAgentsDir } from '../lib/state.js';
import { isGitRepo, cloneIntoExisting, pullRepo } from '../lib/git.js';
import { isPromptCancelled, isInteractiveTerminal } from './utils.js';
import { AGENTS, agentConfigDirName, getUnmanagedAgentInstalls, countSessionFiles, agentLabel } from '../lib/agents.js';
import { setGlobalDefault } from '../lib/versions.js';
import { ensureShimCurrent, switchHomeFileSymlinks, isShimsInPath, addShimsToPath, getPathSetupInstructions } from '../lib/shims.js';
import { setHelpSections } from '../lib/help.js';
import { registerSetupBrowserCommand, runBrowserWizard } from './setup-browser.js';
import { registerSetupComputerCommand, runComputerWizard } from './setup-computer.js';
import { registerSetupShareCommand, runShareWizard } from './setup-share.js';

const HOME = os.homedir();

/**
 * Import an existing unmanaged agent installation into agents-cli.
 * Moves the config dir into the versions structure and creates a symlink.
 */
async function importAgent(agentId: AgentId, version: string): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  const configDir = agent.configDir;
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, agentId, version, 'home');
  const versionConfigDir = path.join(versionHome, agentConfigDirName(agentId));

  // Skip if version dir already exists (collision)
  if (fs.existsSync(versionConfigDir)) {
    return { success: false, skipped: true, error: `${version} already installed` };
  }

  try {
    // Create version home directory
    fs.mkdirSync(versionHome, { recursive: true });

    // Move existing config dir into version home
    fs.renameSync(configDir, versionConfigDir);

    // Create symlink from original location to version config
    fs.symlinkSync(versionConfigDir, configDir);

    // Set as global default
    setGlobalDefault(agentId, version);

    // Handle home-level files (e.g. ~/.claude.json)
    switchHomeFileSymlinks(agentId, version);

    // Ensure shim exists
    ensureShimCurrent(agentId);

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** First-run setup. Clones ~/.agents/.system/ from the system repo if needed. */
export async function runSetup(program: Command, options: { force?: boolean; suppressFooter?: boolean; systemRepo?: boolean } = {}): Promise<void> {
  const agentsDir = getAgentsDir();
  const alreadyConfigured = isGitRepo(agentsDir);

  if (alreadyConfigured && !options.force) {
    console.log(chalk.gray('~/.agents/.system/ is already set up.'));
    console.log(chalk.gray('\nTo sync updates:      agents repo pull system'));
    console.log(chalk.gray('To re-run setup:      agents setup --force'));
    return;
  }

  // Detect existing installations BEFORE cloning (they won't exist after if we import)
  const unmanaged = await getUnmanagedAgentInstalls();
  const sessionCounts: Partial<Record<AgentId, number>> = {};
  for (const install of unmanaged) {
    sessionCounts[install.agentId] = countSessionFiles(install.agentId);
  }

  const systemRepo = process.env.AGENTS_SYSTEM_REPO || DEFAULT_SYSTEM_REPO;

  console.log(chalk.bold('\nWelcome to agents-cli.'));

  if (options.systemRepo === false) {
    ensureAgentsDir();
    console.log(chalk.gray('Skipping system repo clone (--no-system-repo).'));
    console.log(chalk.gray(`Populate ~/.agents/.system/ yourself before running other commands that depend on it.\n`));
  } else {
    console.log(
      chalk.gray(
        alreadyConfigured
          ? `Updating the system repo from ${systemRepoSlug(systemRepo)} in ~/.agents/.system/.\n`
          : `Cloning the system repo from ${systemRepoSlug(systemRepo)} into ~/.agents/.system/.\n`,
      ),
    );

    ensureAgentsDir();

    const spinner = ora(alreadyConfigured ? 'Updating system repo...' : 'Cloning system repo...').start();

    if (isGitRepo(agentsDir)) {
      // --force on an existing repo: pull instead of re-clone
      const result = await pullRepo(agentsDir);
      if (!result.success) {
        spinner.fail(`Pull failed: ${result.error}`);
        console.log(chalk.gray('Fix the issue and re-run: agents setup --force'));
        process.exit(1);
      }
      spinner.succeed(`Updated to ${result.commit}`);
    } else {
      // Check git is available
      try {
        const { execSync } = await import('child_process');
        execSync('git --version', { stdio: 'ignore' });
      } catch {
        spinner.fail('git is not installed');
        console.log(chalk.gray('Install git first: https://git-scm.com/downloads'));
        process.exit(1);
      }

      const result = await cloneIntoExisting(systemRepo, agentsDir);
      if (!result.success) {
        spinner.fail(`Clone failed: ${result.error}`);
        console.log(chalk.gray('Fix the issue and re-run: agents setup --force'));
        process.exit(1);
      }
      spinner.succeed(`Cloned ${systemRepoSlug(systemRepo)} (${result.commit})`);
    }
  }

  // Populate the device registry from the tailnet on first setup. Soft mode is
  // guaranteed non-throwing (no tailscale / corrupt file / lock contention all
  // resolve to ok:false), so this can never block setup.
  const { runDeviceSync } = await import('../lib/devices/sync.js');
  const dev = await runDeviceSync({ soft: true });
  if (dev.ok && dev.synced > 0) {
    console.log(chalk.gray(`Discovered ${dev.synced} device${dev.synced === 1 ? '' : 's'} on your tailnet (agents devices list).`));
  }

  // Offer guided cross-machine session-sync provisioning (interactive, opt-in,
  // and never blocking — any failure/decline falls through to the rest of setup).
  try {
    const { promptAndProvisionSessionSync } = await import('./sync-provision.js');
    await promptAndProvisionSessionSync({ explicit: false });
  } catch (err) {
    console.log(chalk.yellow(`Session-sync setup skipped: ${(err as Error).message}`));
  }

  // Offer to import existing unmanaged installations
  if (unmanaged.length > 0 && isInteractiveTerminal()) {
    console.log(chalk.bold('\nFound existing installations:\n'));

    const maxAgentLen = Math.max(...unmanaged.map(i => agentLabel(i.agentId).length));
    for (const install of unmanaged) {
      const label = agentLabel(install.agentId).padEnd(maxAgentLen);
      const sessions = sessionCounts[install.agentId] || 0;
      const sessionStr = sessions > 0 ? `${sessions} sessions` : 'no sessions';
      const versionStr = install.version ? `v${install.version}` : '';
      console.log(`  ${chalk.cyan(label)}  ${install.configDir}  ${chalk.gray(sessionStr)}  ${chalk.gray(versionStr)}`);
    }

    console.log();
    const shouldImport = await confirm({
      message: 'Import these under agents-cli management?',
      default: true,
    });

    if (shouldImport) {
      console.log();
      for (const install of unmanaged) {
        const version = install.version || 'unknown';
        const spinner = ora(`Importing ${agentLabel(install.agentId)} v${version}...`).start();

        const result = await importAgent(install.agentId, version);
        if (result.success) {
          spinner.succeed(`${agentLabel(install.agentId)} imported`);
        } else if (result.skipped) {
          spinner.warn(`${agentLabel(install.agentId)}: ${result.error} (skipped)`);
        } else {
          spinner.fail(`${agentLabel(install.agentId)}: ${result.error}`);
        }
      }

      // Ensure shims are in PATH
      if (!isShimsInPath()) {
        const pathResult = addShimsToPath();
        if (pathResult.success && !pathResult.alreadyPresent) {
          console.log(chalk.green(`\nAdded shims to ${pathResult.location}`));
          console.log(chalk.gray(pathResult.reloadHint));
        } else if (!pathResult.success) {
          console.log(chalk.yellow('\nTo enable version switching, add shims to PATH:'));
          console.log(chalk.gray(getPathSetupInstructions()));
        }
      }

      // Show total session count
      const totalSessions = Object.values(sessionCounts).reduce((a, b) => a + (b || 0), 0);
      if (totalSessions > 0) {
        const breakdown = unmanaged
          .filter(i => (sessionCounts[i.agentId] || 0) > 0)
          .map(i => `${agentLabel(i.agentId)} (${sessionCounts[i.agentId] || 0})`)
          .join(', ');
        console.log(chalk.gray(`\n${totalSessions} sessions available across ${breakdown}`));
        console.log(chalk.cyan('  agents sessions') + chalk.gray('  # browse them'));
      }
    }
  }

  if (options.suppressFooter) return;

  // Fresh-machine hub: offer to set up the optional capabilities that need their
  // own guided flow. TTY-only and fully opt-in — a non-interactive `agents setup`
  // stops at the system-repo bootstrap above, unchanged.
  await runSetupHub();

  console.log(chalk.bold('\nSetup complete. Try:'));
  console.log(chalk.cyan('  agents view                 ') + chalk.gray(' # see what\'s installed'));
  console.log(chalk.cyan('  agents run <agent> "hello"  ') + chalk.gray(' # run an agent'));
  console.log(chalk.gray('\nWhen you want your own editable repo, scaffold one with:'));
  console.log(chalk.cyan('  agents repo init'));
}

/**
 * Ensure the system repo exists before running a command that needs it.
 * If ~/.agents/.system/ is not a git repo AND we're in an interactive TTY,
 * prompt the user to run setup now. In non-interactive mode, print a clear
 * error and exit.
 */
export async function ensureInitialized(program: Command): Promise<void> {
  const agentsDir = getAgentsDir();
  if (isGitRepo(agentsDir)) return;

  if (!isInteractiveTerminal()) {
    console.error(chalk.red('agents-cli is not set up. Run: agents setup'));
    process.exit(1);
  }

  console.log(chalk.yellow('\nagents-cli has not been set up yet.'));
  const proceed = await confirm({
    message: 'Run `agents setup` now?',
    default: true,
  }).catch(() => false);

  if (!proceed) {
    console.log(chalk.gray('Skipped. Run `agents setup` when ready.'));
    process.exit(0);
  }

  await runSetup(program, { suppressFooter: true });
}

/**
 * Interactive "what else do you want to set up?" menu shown after the bare
 * `agents setup` finishes on a TTY. Each pick runs that capability's guided
 * wizard. Never throws — a cancel or an optional wizard's error just skips the
 * rest and lets core setup complete.
 */
async function runSetupHub(): Promise<void> {
  if (!isInteractiveTerminal()) return;
  try {
    const { checkbox } = await import('@inquirer/prompts');
    const picks = await checkbox<'browser' | 'computer' | 'share'>({
      message: 'Set up optional capabilities now? (space to select, enter to confirm)',
      choices: [
        { name: 'browser  — drive a real Chrome/Brave/Edge for web automation', value: 'browser' },
        { name: 'computer — control native macOS apps (screenshot, click, type)', value: 'computer' },
        { name: 'share    — publish shareable links (Cloudflare R2 + Worker)', value: 'share' },
      ],
    });
    for (const pick of picks) {
      console.log();
      if (pick === 'browser') await runBrowserWizard();
      else if (pick === 'computer') await runComputerWizard();
      else if (pick === 'share') await runShareWizard();
    }
  } catch (err) {
    if (isPromptCancelled(err)) return;
    console.log(chalk.yellow(`Optional setup skipped: ${(err as Error).message}`));
  }
}

/** Register the `agents setup` command and its capability subcommands. */
export function registerSetupCommand(program: Command): void {
  const setupCmd = program
    .command('setup')
    .description('First-time setup. Clones a config repo and installs agent CLIs.')
    .option('-f, --force', 'Re-run setup even if ~/.agents/.system/ already exists (use with caution)')
    .option('--no-system-repo', 'Skip cloning the system repo (you must populate ~/.agents/.system/ yourself)');

  // Capability subcommands: `agents setup browser|computer|share`.
  registerSetupBrowserCommand(setupCmd);
  registerSetupComputerCommand(setupCmd);
  registerSetupShareCommand(setupCmd);

  setHelpSections(setupCmd, {
    examples: `
      # First-time setup (clones the system repo into ~/.agents/.system/)
      agents setup

      # Re-run after corruption or to repair ~/.agents/.system/
      agents setup --force

      # Set up a specific capability on its own
      agents setup browser
      agents setup computer
      agents setup share
    `,
    notes: `
      What it does:
        1. Clones the system repo into ~/.agents/.system/
        2. Imports any unmanaged agent installations it finds
        3. On a TTY, offers to set up optional capabilities (browser/computer/share)

      Capability setup can also be run any time on its own:
        agents setup browser    # detect a browser + create the default profile
        agents setup computer    # install the signed macOS helper + grant permissions
        agents setup share       # provision or join a Cloudflare share endpoint

      To install CLIs from agents.yaml and sync resources into version homes:
        agents repo refresh -y
    `,
  });

  setupCmd.action(async (options) => {
      try {
        await runSetup(program, options);
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        throw err;
      }
    });
}
