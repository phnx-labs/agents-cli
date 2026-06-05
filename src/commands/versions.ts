/**
 * Version management commands for installing, switching, and removing agent CLIs.
 *
 * Implements `agents add`, `agents prune`, `agents remove` (alias),
 * `agents use`, and the deprecated `agents list`. Handles npm-based installation,
 * shim creation, config symlink
 * switching, resource sync prompts, and project-level version pinning.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { select, confirm, checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  ALL_AGENT_IDS,
  getAccountEmail,
  getAccountInfo,
  agentLabel,
} from '../lib/agents.js';
import type { AccountInfo } from '../lib/agents.js';
import type { UsageSnapshot } from '../lib/usage.js';
import {
  formatUsageSummary,
  getUsageInfoForIdentity,
  getUsageInfoByIdentity,
  getUsageLookupKey,
} from '../lib/usage.js';
import { viewAction } from './view.js';
import type { AgentId } from '../lib/types.js';
import { readManifest, writeManifest, createDefaultManifest } from '../lib/manifest.js';
import {
  installVersion,
  removeVersion,
  removeAllVersions,
  listInstalledVersions,
  isVersionInstalled,
  isLatestInstalled,
  getGlobalDefault,
  setGlobalDefault,
  getVersionHomePath,
  getVersionDir,
  syncResourcesToVersion,
  parseAgentSpec,
  promptResourceSelection,
  promptNewResourceSelection,
  type AvailableResources,
  getAvailableResources,
  getActuallySyncedResources,
  getNewResources,
  getProjectOnlyResources,
  hasNewResources,
  printTrashFooter,
  type ResourceSelection,
} from '../lib/versions.js';
import {
  createShim,
  createVersionedAlias,
  removeShim,
  shimExists,
  getShimsDir,
  getShimPath,
  getPathShadowingExecutable,
  isShimsInPath,
  getPathSetupInstructions,
  addShimsToPath,
  switchConfigSymlink,
  switchHomeFileSymlinks,
} from '../lib/shims.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';
import { tryAutoPull } from '../lib/git.js';
import { getAgentsDir, getTrashVersionsDir } from '../lib/state.js';
import { setHelpSections } from '../lib/help.js';
import { updateSessionFilePaths } from '../lib/session/db.js';

/**
 * After removeVersion soft-deletes a version dir to trash, rewrite session
 * file_path entries in the DB so reads still work from the new trash location.
 */
function fixSessionFilePaths(agent: AgentId, version: string, oldVersionDir: string): void {
  const trashAgentDir = path.join(getTrashVersionsDir(), agent, version);
  if (!fs.existsSync(trashAgentDir)) return;
  const stamps = fs.readdirSync(trashAgentDir).sort().reverse();
  if (stamps.length === 0) return;
  const trashPath = path.join(trashAgentDir, stamps[0]);
  updateSessionFilePaths(oldVersionDir, trashPath);
}

/**
 * Helper to get actual installed version for an agent.
 * Returns the latest installed version, or throws if none installed.
 */
async function getInstalledVersionForAgent(agent: AgentId): Promise<string> {
  const versions = listInstalledVersions(agent);
  if (versions.length > 0) {
    return versions[versions.length - 1];
  }
  throw new Error(`No versions of ${agent} installed`);
}

function formatAccountHint(info: AccountInfo, usage: UsageSnapshot | null): string {
  const parts: string[] = [];
  if (info.email) parts.push(info.email);
  const usageSummary = formatUsageSummary(info.plan, usage);
  if (usageSummary) parts.push(usageSummary);
  if (parts.length === 0) return '';
  return chalk.gray(` [${parts.join(', ')}]`);
}

function buildAutomaticSelection(resources: AvailableResources): ResourceSelection {
  const selection: ResourceSelection = {};
  if (resources.commands.length > 0) selection.commands = resources.commands;
  if (resources.skills.length > 0) selection.skills = resources.skills;
  if (resources.hooks.length > 0) selection.hooks = resources.hooks;
  if (resources.memory.length > 0) selection.memory = resources.memory;
  if (resources.mcp.length > 0) selection.mcp = resources.mcp;
  if (resources.permissions.length > 0) selection.permissions = resources.permissions;
  if (resources.subagents.length > 0) selection.subagents = resources.subagents;
  if (resources.plugins.length > 0) selection.plugins = resources.plugins;
  return selection;
}

async function setDefaultVersion(
  agent: AgentId,
  installedVersion: string,
): Promise<void> {
  setGlobalDefault(agent, installedVersion);
  createShim(agent);
  createVersionedAlias(agent, installedVersion);
  const symlinkResult = await switchConfigSymlink(agent, installedVersion);
  if (symlinkResult.success) {
    console.log(chalk.green('  Set as default'));
    if (symlinkResult.backupPath) {
      console.log(chalk.gray(`  Backed up existing config to: ${symlinkResult.backupPath}`));
    }
  }
  switchHomeFileSymlinks(agent, installedVersion);
  warnIfShimShadowed(agent);
}

function warnIfShimShadowed(agent: AgentId): void {
  const shadowedBy = getPathShadowingExecutable(agent);
  if (!shadowedBy) {
    return;
  }

  console.log(chalk.yellow(`  Warning: ${AGENTS[agent].cliCommand} currently resolves to ${shadowedBy}`));
  console.log(chalk.gray(`  Managed shim: ${getShimPath(agent)}`));
  console.log(chalk.gray(`  ${getPathSetupInstructions().split('\n').join('\n  ')}`));
}

type VersionPruneVerb = 'prune' | 'remove';

async function versionPruneAction(
  specs: string[],
  options: { project?: boolean },
  commandName: VersionPruneVerb,
): Promise<void> {
  const isProject = options.project;
  const moved: Array<{ agent: AgentId; version: string }> = [];

  for (const spec of specs) {
    const parsed = parseAgentSpec(spec);
    if (!parsed) {
      console.log(chalk.red(`Invalid agent: ${spec}`));
      console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));
      continue;
    }

    const { agent, version } = parsed;
    const agentConfig = AGENTS[agent];

    if (version === 'latest' || !spec.includes('@')) {
      const versions = listInstalledVersions(agent);
      if (versions.length === 0) {
        console.log(chalk.gray(`No versions of ${agentLabel(agentConfig.id)} installed`));
        continue;
      }

      if (!isInteractiveTerminal()) {
        requireInteractiveSelection(`Selecting ${agentLabel(agentConfig.id)} versions to ${commandName}`, [
          `agents ${commandName} ${agent}@${versions[0]}`,
        ]);
      }

      const globalDefault = getGlobalDefault(agent);

      const sortedVersions = [...versions].sort((a, b) => {
        if (a === globalDefault) return -1;
        if (b === globalDefault) return 1;
        return 0;
      });

      try {
        const toRemove = await checkbox({
          message: `Select ${agentLabel(agentConfig.id)} versions to ${commandName}:`,
          choices: sortedVersions.map((v) => ({
            name: v === globalDefault ? `${v} ${chalk.green('(default)')}` : v,
            value: v,
            checked: false,
          })),
        });

        if (toRemove.length === 0) {
          console.log(chalk.gray('No versions selected'));
          continue;
        }

        for (const v of toRemove) {
          const versionDir = getVersionDir(agent, v);
          removeVersion(agent, v);
          fixSessionFilePaths(agent, v, versionDir);
          console.log(chalk.green(`Moved ${agentLabel(agentConfig.id)}@${v} to trash`));
          moved.push({ agent, version: v });
        }

        if (globalDefault && toRemove.includes(globalDefault)) {
          setGlobalDefault(agent, undefined);
          console.log(chalk.yellow(`Default version removed. Run: agents use ${agent}@<version> to set a new default`));
        }

        const remaining = listInstalledVersions(agent);
        if (remaining.length === 0) {
          removeShim(agent);
        }
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('Cancelled'));
          continue;
        }
        throw err;
      }
    } else if (!isVersionInstalled(agent, version)) {
      console.log(chalk.gray(`${agentLabel(agentConfig.id)}@${version} not installed`));
    } else {
      const versionDir = getVersionDir(agent, version);
      removeVersion(agent, version);
      fixSessionFilePaths(agent, version, versionDir);
      console.log(chalk.green(`Moved ${agentLabel(agentConfig.id)}@${version} to trash`));
      moved.push({ agent, version });

      const remaining = listInstalledVersions(agent);
      if (remaining.length === 0) {
        removeShim(agent);
      }
    }

    if (isProject) {
      const projectManifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
      if (fs.existsSync(projectManifestPath)) {
        const manifest = readManifest(process.cwd());
        if (manifest?.agents?.[agent]) {
          delete manifest.agents[agent];
          writeManifest(process.cwd(), manifest);
          console.log(chalk.gray(`  Removed from .agents/agents.yaml`));
        }
      }
    }
  }

  printTrashFooter(moved);
}

function configureVersionPruneCommand(cmd: Command, commandName: VersionPruneVerb): void {
  const isAlias = commandName === 'remove';
  cmd
    .description(isAlias
      ? 'Alias for agents prune. Uninstalls agent CLI versions.'
      : 'Uninstall agent CLI versions. Moves version data to trash for recovery.')
    .option('-p, --project', 'Also clear the pinned version from .agents/agents.yaml in the current project');

  setHelpSections(cmd, {
    examples: `
      # Prune a specific version
      agents ${commandName} claude@2.0.50

      # Pick interactively if you omit the version
      agents ${commandName} claude

      # Prune and also clear the project pin
      agents ${commandName} claude@2.0.50 --project
    `,
    notes: `
      - Pruned version directories move to trash with their home/ data intact.
      - Session file paths are rewritten so session history remains readable.
      - Removing the default version unsets the default; run 'agents use' to pick a new one.
      - Reinstall any time with 'agents add'.
    `,
  });

  cmd.action((specs: string[], options) => versionPruneAction(specs, options, commandName));
}

/** Register `agents add`, `agents prune`, `agents remove`, `agents use`, and `agents list` (deprecated). */
export function registerVersionsCommands(program: Command): void {
  const addCmd = program
    .command('add <specs...>')
    .description('Download and install agent CLI versions. Enables subsidized API usage through managed binaries.')
    .option('-p, --project', 'Lock this version to the current project directory only, stored in project-root agents.yaml')
    .option('-y, --yes', 'Auto-accept defaults without prompting (useful for scripts and CI)');

  setHelpSections(addCmd, {
    examples: `
      # Install the latest version of an agent
      agents add claude@latest

      # Install a specific version (reproducibility)
      agents add claude@2.1.112

      # Install multiple agents at once
      agents add claude@latest codex@0.116.0

      # Lock a version to this project only (won't affect global default)
      agents add claude@2.1.100 --project
    `,
    notes: `
      - The first version you install becomes the default automatically.
      - 'add' does NOT change the default if a default already exists. Use 'agents use' to switch.
      - Multi-account: each installed version has separate auth, so you can install the same agent twice for two accounts.
    `,
  });

  addCmd.action(async (specs: string[], options) => {
      const isProject = options.project;
      const skipPrompts = options.yes || !isInteractiveTerminal();

      for (const spec of specs) {
        const parsed = parseAgentSpec(spec);
        if (!parsed) {
          console.log(chalk.red(`Invalid agent: ${spec}`));
          console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));
          continue;
        }

        const { agent, version } = parsed;
        const agentConfig = AGENTS[agent];

        if (!agentConfig.npmPackage) {
          console.log(chalk.yellow(`${agentLabel(agentConfig.id)} has no npm package. Install manually.`));
          continue;
        }

        // Check if already installed (handle 'latest' specially)
        let alreadyInstalled = false;
        let installedAsVersion = version;
        if (version === 'latest') {
          const latestCheck = await isLatestInstalled(agent);
          if (latestCheck.installed && latestCheck.version) {
            alreadyInstalled = true;
            installedAsVersion = latestCheck.version;
          }
        } else {
          alreadyInstalled = isVersionInstalled(agent, version);
        }

        if (alreadyInstalled) {
          console.log(chalk.gray(`${agentLabel(agentConfig.id)}@${installedAsVersion} already installed`));

          // Ensure shim exists (in case it was deleted or needs updating)
          createShim(agent);
        } else {
          const spinner = ora(`Installing ${agentLabel(agentConfig.id)}@${version}...`).start();

          const result = await installVersion(agent, version, (msg) => {
            spinner.text = msg;
          });

          if (result.success) {
            spinner.succeed(`Installed ${agentLabel(agentConfig.id)}@${result.installedVersion}`);

            // Create shim if first install
            if (!shimExists(agent)) {
              createShim(agent);
              console.log(chalk.gray(`  Created shim: ${getShimsDir()}/${agentConfig.cliCommand}`));
            }

            const installedVersion = result.installedVersion || version;

            // Smart resource detection: compare available vs ACTUALLY synced (source of truth: files)
            const available = getAvailableResources();
            const actuallySynced = getActuallySyncedResources(agent, installedVersion);
            const newResources = getNewResources(available, actuallySynced, getProjectOnlyResources());

            const hasAnySynced = actuallySynced.commands.length > 0 ||
              actuallySynced.skills.length > 0 ||
              actuallySynced.hooks.length > 0 ||
              actuallySynced.memory.length > 0 ||
              actuallySynced.mcp.length > 0 ||
              actuallySynced.permissions.length > 0 ||
              actuallySynced.plugins.length > 0;

            let selection: ResourceSelection | undefined;

            try {
              if (skipPrompts) {
                if (!hasAnySynced) {
                  selection = buildAutomaticSelection(available);
                } else if (hasNewResources(newResources, agent)) {
                  selection = buildAutomaticSelection(newResources);
                }
              } else if (!hasAnySynced) {
                // Nothing synced yet - prompt for ALL resources
                const userSelection = await promptResourceSelection(agent);
                if (userSelection) {
                  selection = userSelection;
                }
              } else if (hasNewResources(newResources, agent, installedVersion)) {
                // Some synced, but NEW resources available - prompt for new only
                const userSelection = await promptNewResourceSelection(agent, newResources, installedVersion);
                if (userSelection) {
                  selection = userSelection;
                }
              }
              // else: everything already synced, no prompt needed
            } catch (err) {
              if (isPromptCancelled(err)) {
                console.log(chalk.gray('Skipped resource selection'));
              } else {
                throw err;
              }
            }

            // Sync resources if user made a selection
            if (selection && Object.keys(selection).length > 0) {
              const syncResult = syncResourcesToVersion(agent, installedVersion, selection);
              const synced: string[] = [];
              if (syncResult.commands) synced.push('commands');
              if (syncResult.skills) synced.push('skills');
              if (syncResult.hooks) synced.push('hooks');
              if (syncResult.memory.length > 0) synced.push('memory');
              if (syncResult.permissions) synced.push('permissions');
              if (syncResult.mcp.length > 0) synced.push('mcp');
              if (syncResult.plugins.length > 0) synced.push('plugins');

              if (synced.length > 0) {
                console.log(chalk.green(`  Synced: ${synced.join(', ')}`));
              }
            }

            // Set as default: auto-set if no default exists, otherwise prompt
            const currentDefault = getGlobalDefault(agent);
            if (currentDefault !== installedVersion) {
              if (!currentDefault) {
                // First install for this agent - auto-set without prompting
                await setDefaultVersion(agent, installedVersion);
              } else if (skipPrompts) {
                console.log(chalk.gray(`  Default remains ${agentLabel(agentConfig.id)}@${currentDefault}. Run 'agents use ${agent}@${installedVersion}' to switch.`));
              } else {
                try {
                  // Fetch account info for context in the prompt
                  const home = getVersionHomePath(agent, installedVersion);
                  const info = await getAccountInfo(agent, home);
                  const usage = await getUsageInfoForIdentity({
                    agentId: agent,
                    home,
                    cliVersion: installedVersion,
                    info,
                  });
                  const accountHint = formatAccountHint(info, usage.snapshot);

                  const message = `Switch default from ${agentLabel(agentConfig.id)}@${currentDefault} to ${agentLabel(agentConfig.id)}@${installedVersion}${accountHint}?`;

                  const setAsDefault = await confirm({
                    message,
                    default: true,
                  });

                  if (setAsDefault) {
                    await setDefaultVersion(agent, installedVersion);
                  }
                } catch (err) {
                  if (isPromptCancelled(err)) {
                    console.log(chalk.gray('Skipped setting default'));
                  } else {
                    throw err;
                  }
                }
              }
            }

            // Auto-add shims to PATH if not already there
            if (!isShimsInPath()) {
              const pathResult = addShimsToPath();
              if (pathResult.success && !pathResult.alreadyPresent) {
                console.log(chalk.green(`  Added shims to ~/${pathResult.rcFile}`));
                console.log(chalk.gray('  Restart your shell or run: source ~/' + pathResult.rcFile));
              } else if (!pathResult.success) {
                console.log(chalk.yellow('\nCould not auto-add shims to PATH:'));
                console.log(chalk.gray(getPathSetupInstructions()));
              }
            }
          } else {
            spinner.fail(`Failed to install ${agentLabel(agentConfig.id)}@${version}`);
            console.error(chalk.gray(result.error || 'Unknown error'));
            continue;
          }
        }

        // Update project manifest if -p flag
        if (isProject) {
          const projectManifestDir = path.join(process.cwd(), '.agents');
          const projectManifestPath = path.join(projectManifestDir, 'agents.yaml');

          if (!fs.existsSync(projectManifestDir)) {
            fs.mkdirSync(projectManifestDir, { recursive: true });
          }

          const manifest = fs.existsSync(projectManifestPath)
            ? readManifest(process.cwd()) || createDefaultManifest()
            : createDefaultManifest();

          manifest.agents = manifest.agents || {};
          manifest.agents[agent] = version === 'latest' ? (await getInstalledVersionForAgent(agent)) : version;

          writeManifest(process.cwd(), manifest);
          console.log(chalk.green(`  Pinned ${agentLabel(agentConfig.id)}@${version} in .agents/agents.yaml`));
        }
      }
    });

  configureVersionPruneCommand(program.command('prune <specs...>'), 'prune');
  configureVersionPruneCommand(program.command('remove <specs...>', { hidden: true }), 'remove');

  const useCmd = program
    .command('use <agent> [version]')
    .description('Switch the active version for an agent. This is the only command that sets the default.')
    .option('-p, --project', 'Pin to this project directory only (stored in .agents/agents.yaml)')
    .option('-y, --yes', 'Auto-sync resources without prompting');

  setHelpSections(useCmd, {
    examples: `
      # Set global default (interactive picker if version omitted)
      agents use claude
      agents use claude@2.1.112

      # Pin this project to a version (overrides the global default in this directory)
      agents use claude@2.1.100 --project

      # Switch accounts — each installed version has its own auth
      agents use claude@2.1.50
    `,
    notes: `
      - 'agents add' installs but does NOT set the default. Always follow with 'agents use'.
      - --project pins to the current directory only via .agents/agents.yaml.
    `,
  });

  useCmd.action(async (agentArg: string, versionArg: string | undefined, options) => {
      try {
        const skipPrompts = options.yes || !isInteractiveTerminal();
        // Auto-pull ~/.agents-system if it's a git repo with remote (silent on success)
        const agentsDir = getAgentsDir();
        const pullResult = await tryAutoPull(agentsDir);
        if (pullResult.pulled) {
          console.log(chalk.gray('Synced ~/.agents-system from remote'));
        }

        // Support both "claude 2.0.65" and "claude@2.0.65" formats
        let agent: string;
        let version: string | undefined;

        if (agentArg.includes('@')) {
          const parsed = parseAgentSpec(agentArg);
          if (!parsed) {
            console.log(chalk.red(`Invalid agent: ${agentArg}`));
            console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));
            return;
          }
          agent = parsed.agent;
          version = parsed.version === 'latest' ? undefined : parsed.version;
        } else {
          const agentLower = agentArg.toLowerCase();
          if (!AGENTS[agentLower as AgentId]) {
            console.log(chalk.red(`Invalid agent: ${agentArg}`));
            console.log(chalk.gray(`Available: ${ALL_AGENT_IDS.join(', ')}`));
            return;
          }
          agent = agentLower;
          version = versionArg;
        }

        const agentId = agent as AgentId;
        const agentConfig = AGENTS[agentId];

        let selectedVersion = version;

        if (!version) {
          // Interactive version picker
          const versions = listInstalledVersions(agentId);
          if (versions.length === 0) {
            console.log(chalk.red(`No versions of ${agentLabel(agentConfig.id)} installed`));
            console.log(chalk.gray(`Run: agents add ${agentId}@latest`));
            return;
          }

          if (!isInteractiveTerminal()) {
            requireInteractiveSelection(`Selecting a ${agentLabel(agentConfig.id)} version`, [
              `agents use ${agentId}@${versions[versions.length - 1]}`,
              `agents view ${agentId}`,
            ]);
          }

          const globalDefault = getGlobalDefault(agentId);

          // Sort versions with default first
          const sortedVersions = [...versions].sort((a, b) => {
            if (a === globalDefault) return -1;
            if (b === globalDefault) return 1;
            return 0;
          });

          // Pre-fetch account info for picker labels and usage identity lookup
          const pickerAccounts = await Promise.all(
            sortedVersions.map((v) =>
              getAccountInfo(agentId, getVersionHomePath(agentId, v)).then((info) => ({ v, info }))
            )
          );
          const pickerAccountMap = new Map(pickerAccounts.map(({ v, info }) => [v, info]));
          const { usageByKey } = await getUsageInfoByIdentity(
            pickerAccounts.map(({ v, info }) => ({
              agentId,
              home: getVersionHomePath(agentId, v),
              cliVersion: v,
              info,
            }))
          );

          const maxLabelLen = Math.max(...sortedVersions.map((v) => (v === globalDefault ? `${v} (default)` : v).length));
          const maxEmailLen = Math.max(0, ...pickerAccounts.map(({ info }) => info.email?.length || 0));
          selectedVersion = await select({
            message: `Select ${agentLabel(agentConfig.id)} version:`,
            choices: sortedVersions.map((v) => {
              let label = v === globalDefault ? `${v}${chalk.green(' (default)')}` : v;
              const padLen = maxLabelLen - (v === globalDefault ? `${v} (default)` : v).length;
              if (padLen > 0) label += ' '.repeat(padLen);
              const accountInfo = pickerAccountMap.get(v);
              const email = accountInfo?.email || '';
              const usageKey = getUsageLookupKey(accountInfo);
              const usageSummary = usageKey ? formatUsageSummary(null, usageByKey.get(usageKey)?.snapshot || null) : '';

              if (maxEmailLen > 0) {
                label += '  ';
                label += email ? chalk.cyan(email.padEnd(maxEmailLen)) : ' '.repeat(maxEmailLen);
              }
              if (usageSummary) {
                label += `  ${usageSummary}`;
              }
              return { name: label, value: v };
            }),
          });
        }

        if (!selectedVersion || !isVersionInstalled(agentId, selectedVersion)) {
          console.log(chalk.red(`${agentLabel(agentConfig.id)}@${selectedVersion ?? 'unknown'} not installed`));
          console.log(chalk.gray(`Run: agents add ${agentId}@${selectedVersion ?? 'latest'}`));
          return;
        }

        // selectedVersion is guaranteed to be defined after the check above
        const finalVersion = selectedVersion;

        if (options.project) {
          // Set in project manifest
          const projectManifestDir = path.join(process.cwd(), '.agents');
          const projectManifestPath = path.join(projectManifestDir, 'agents.yaml');

          if (!fs.existsSync(projectManifestDir)) {
            fs.mkdirSync(projectManifestDir, { recursive: true });
          }

          const manifest = fs.existsSync(projectManifestPath)
            ? readManifest(process.cwd()) || createDefaultManifest()
            : createDefaultManifest();

          manifest.agents = manifest.agents || {};
          manifest.agents[agentId] = finalVersion;

          writeManifest(process.cwd(), manifest);
          const projEmail = await getAccountEmail(agentId, getVersionHomePath(agentId, finalVersion));
          const projEmailStr = projEmail ? chalk.cyan(` (${projEmail})`) : '';
          console.log(chalk.green(`Set ${agentLabel(agentConfig.id)}@${finalVersion} for this project`) + projEmailStr);
        } else {
          // Smart resource detection: compare available vs ACTUALLY synced (source of truth: files, not tracking)
          const available = getAvailableResources();
          const actuallySynced = getActuallySyncedResources(agentId, finalVersion);
          const newResources = getNewResources(available, actuallySynced, getProjectOnlyResources());

          // Check if anything is actually synced (source of truth: actual files)
          const hasAnySynced = actuallySynced.commands.length > 0 ||
            actuallySynced.skills.length > 0 ||
            actuallySynced.hooks.length > 0 ||
            actuallySynced.memory.length > 0 ||
            actuallySynced.mcp.length > 0 ||
            actuallySynced.permissions.length > 0;

          try {
            if (skipPrompts) {
              let selection: ResourceSelection | undefined;
              if (!hasAnySynced) {
                selection = buildAutomaticSelection(available);
              } else if (hasNewResources(newResources, agentId)) {
                selection = buildAutomaticSelection(newResources);
              }

              if (selection && Object.keys(selection).length > 0) {
                const syncResult = syncResourcesToVersion(agentId, finalVersion, selection);
                const syncedTypes: string[] = [];
                if (syncResult.commands) syncedTypes.push('commands');
                if (syncResult.skills) syncedTypes.push('skills');
                if (syncResult.hooks) syncedTypes.push('hooks');
                if (syncResult.memory.length > 0) syncedTypes.push('memory');
                if (syncResult.permissions) syncedTypes.push('permissions');
                if (syncResult.mcp.length > 0) syncedTypes.push('mcp');
                if (syncResult.plugins.length > 0) syncedTypes.push('plugins');

                if (syncedTypes.length > 0) {
                  console.log(chalk.green(`Synced: ${syncedTypes.join(', ')}`));
                }
              }
            } else if (!hasAnySynced) {
              // First time: prompt for ALL resources
              console.log(chalk.yellow(`\n${agentLabel(agentConfig.id)}@${finalVersion} has no synced resources.`));
              const userSelection = await promptResourceSelection(agentId);
              if (userSelection && Object.keys(userSelection).length > 0) {
                const syncResult = syncResourcesToVersion(agentId, finalVersion, userSelection);
                const syncedTypes: string[] = [];
                if (syncResult.commands) syncedTypes.push('commands');
                if (syncResult.skills) syncedTypes.push('skills');
                if (syncResult.hooks) syncedTypes.push('hooks');
                if (syncResult.memory.length > 0) syncedTypes.push('memory');
                if (syncResult.permissions) syncedTypes.push('permissions');
                if (syncResult.mcp.length > 0) syncedTypes.push('mcp');
                if (syncResult.plugins.length > 0) syncedTypes.push('plugins');

                if (syncedTypes.length > 0) {
                  console.log(chalk.green(`Synced: ${syncedTypes.join(', ')}`));
                }
              }
            } else if (hasNewResources(newResources, agentId, finalVersion)) {
              // Has synced before, but NEW items available
              const userSelection = await promptNewResourceSelection(agentId, newResources, finalVersion);
              if (userSelection && Object.keys(userSelection).length > 0) {
                const syncResult = syncResourcesToVersion(agentId, finalVersion, userSelection);
                const syncedTypes: string[] = [];
                if (syncResult.commands) syncedTypes.push('commands');
                if (syncResult.skills) syncedTypes.push('skills');
                if (syncResult.hooks) syncedTypes.push('hooks');
                if (syncResult.memory.length > 0) syncedTypes.push('memory');
                if (syncResult.permissions) syncedTypes.push('permissions');
                if (syncResult.mcp.length > 0) syncedTypes.push('mcp');
                if (syncResult.plugins.length > 0) syncedTypes.push('plugins');

                if (syncedTypes.length > 0) {
                  console.log(chalk.green(`Synced: ${syncedTypes.join(', ')}`));
                }
              }
            }
            // else: everything already synced, no prompt needed
          } catch (err) {
            if (isPromptCancelled(err)) {
              console.log(chalk.gray('No changes made'));
              return;
            } else {
              throw err;
            }
          }

          const previousDefault = getGlobalDefault(agentId);

          // Set global default
          setGlobalDefault(agentId, finalVersion);

          // Regenerate shim so it uses the latest script format
          createShim(agentId);
          createVersionedAlias(agentId, finalVersion);

          // Switch config symlink (e.g., ~/.claude -> version's config)
          // No conflict prompts - just backup existing config if needed
          const symlinkResult = await switchConfigSymlink(agentId, finalVersion);
          if (!symlinkResult.success) {
            console.log(chalk.yellow(`Warning: Could not update config symlink: ${symlinkResult.error}`));
          } else if (symlinkResult.backupPath) {
            console.log(chalk.gray(`Backed up existing config to: ${symlinkResult.backupPath}`));
          }

          // Switch home-level files (e.g., ~/.claude.json -> version's auth file)
          switchHomeFileSymlinks(agentId, finalVersion);
          warnIfShimShadowed(agentId);

          const useEmail = await getAccountEmail(agentId, getVersionHomePath(agentId, finalVersion));
          const useEmailStr = useEmail ? chalk.cyan(` (${useEmail})`) : '';
          console.log(chalk.green(`Set ${agentLabel(agentConfig.id)}@${finalVersion} as global default`) + useEmailStr);
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        throw err;
      }
    });

  // Deprecated: use `agents view` instead
  program
    .command('list [agent]')
    .description('List installed agent CLI versions')
    .action(async (agentArg?: string) => {
      console.log(chalk.red('Deprecated: "agents list" is now "agents view"\n'));
      await viewAction(agentArg);
    });
}
