/**
 * Config pull command.
 *
 * Registers the `agents pull` command which clones or updates the
 * system ~/.agents-system/ git repo and syncs CLI versions, MCP servers,
 * resources, and hooks to installed agent versions.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  AGENTS,
  ALL_AGENT_IDS,
  HOOKS_CAPABLE_AGENTS,
  MCP_CAPABLE_AGENTS,
  getAllCliStates,
  registerMcpToTargets,
  isAgentName,
  resolveAgentName,
  agentLabel,
} from '../lib/agents.js';
import {
  readManifest,
  MANIFEST_FILENAME,
} from '../lib/manifest.js';
import {
  getAgentsDir,
  getUserAgentsDir,
  ensureAgentsDir,
  getEnabledExtraRepos,
  updateMeta,
} from '../lib/state.js';
import type { AgentId } from '../lib/types.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from '../lib/types.js';
import {
  isGitRepo,
  cloneIntoExisting,
  pullRepo,
  isSystemRepoOrigin,
} from '../lib/git.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  installVersion,
  listInstalledVersions,
  getGlobalDefault,
  setGlobalDefault,
  getVersionHomePath,
  syncResourcesToVersion,
  getAvailableResources,
  getActuallySyncedResources,
  getNewResources,
  hasNewResources,
  promptNewResourceSelection,
  promptResourceSelection,
  resolveConfiguredAgentTargets,
  type ResourceSelection,
} from '../lib/versions.js';
import {
  listCliStatus,
  installCli,
  describeMethod,
  selectInstallMethod,
} from '../lib/cli-resources.js';
import {
  ensureShimCurrent,
  isShimsInPath,
  addShimsToPath,
  getPathSetupInstructions,
  switchConfigSymlink,
  switchHomeFileSymlinks,
} from '../lib/shims.js';
import { parseHookManifest, registerHooksToSettings } from '../lib/hooks.js';
import { setHelpSections } from '../lib/help.js';
import { select, confirm } from '@inquirer/prompts';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

/**
 * Old repo layout stored promptcuts under claude/promptcuts.yaml (agent-scoped).
 * The new layout is ~/.agents-system/promptcuts.yaml at the repo root — the hook
 * reads from a fixed path so it survives version upgrades. If the root file
 * doesn't exist yet but an agent-scoped one does, hoist the first one found.
 */
function migratePromptcutsToRoot(agentsDir: string): void {
  const rootPath = path.join(agentsDir, 'promptcuts.yaml');
  if (fs.existsSync(rootPath)) return;

  const agentDirs = ['claude', 'codex', 'cursor', 'gemini', 'opencode'];
  for (const dir of agentDirs) {
    const legacyPath = path.join(agentsDir, dir, 'promptcuts.yaml');
    if (fs.existsSync(legacyPath)) {
      try {
        fs.renameSync(legacyPath, rootPath);
        console.log(chalk.gray(`Moved ${dir}/promptcuts.yaml → promptcuts.yaml (repo root)`));
        return;
      } catch {
        // Best-effort migration; hook still works if the user moves it manually.
      }
    }
  }
}

/** Register the `agents pull` command. */
export function registerPullCommand(program: Command): void {
  const pullCmd = program
    .command('pull [agent]')
    .description('Sync your user repo at ~/.agents/ and refresh installed agent CLIs. (Deprecated — prefer \'agents repo pull\' and \'agents setup\'.)')
    .option('-y, --yes', 'Auto-sync all resources without prompting')
    .option('--skip-clis', 'Pull config changes but do not install or upgrade agent CLIs');

  setHelpSections(pullCmd, {
    examples: `
      # First time: clone the system repo into ~/.agents-system/
      agents pull

      # Sync only one agent's config
      agents pull claude

      # Non-interactive (scripts / CI)
      agents pull -y

      # Sync config without touching installed CLI versions
      agents pull --skip-clis
    `,
    notes: `
      Deprecated. Use:
        agents setup       first-time setup
        agents repo pull   force-sync now
        agents repo push   push your user repo

      What it syncs:
        - CLI versions listed in agents.yaml
        - Commands, skills, hooks
        - MCP server configs
        - Memory/rules files
        - Permissions groups
    `,
  });

  pullCmd.action(async (arg1: string | undefined, options) => {
      // Deprecation banner — `agents pull` is on its way out. agents-cli now
      // auto-syncs the system repo in the background and surfaces upstream
      // changes for user/extra repos as one-line notices. Repo lifecycle is
      // managed under `agents repo`. We keep this command functional today
      // because `agents setup` still invokes it for first-time setup; once
      // setup is refactored to call the bootstrap helpers directly, this
      // command will hard-error like `agents memory` does.
      if (!options.yes && process.argv[2] === 'pull') {
        process.stderr.write(
          'agents-cli: "agents pull" is deprecated.\n' +
            '            First-time setup:  agents setup\n' +
            '            Force a sync now:  agents repo pull\n' +
            '            Push your repo:    agents repo push\n\n',
        );
      }
      const skipPrompts = options.yes || !isInteractiveTerminal();
      let agentFilter: AgentId | undefined;

      if (arg1) {
        if (isAgentName(arg1)) {
          agentFilter = resolveAgentName(arg1)!;
        } else {
          console.log(chalk.red(`Invalid agent: ${arg1}`));
          console.log(chalk.gray(`Available: ${ALL_AGENT_IDS.join(', ')}`));
          return;
        }
      }

      const agentsDir = getUserAgentsDir();
      ensureAgentsDir();

      const spinner = ora('Syncing...').start();

      try {
        let commit: string = '';

        if (isGitRepo(agentsDir)) {
          // Don't pull if the remote is the system repo — that's a misconfiguration
          if (await isSystemRepoOrigin(agentsDir)) {
            spinner.fail('~/.agents/ is pointing at the system repo. Use a personal repo instead.');
            console.log(chalk.gray('\nCreate your own repo: agents repo init'));
            return;
          }
          spinner.text = 'Pulling updates...';
          const result = await pullRepo(agentsDir);
          if (!result.success) {
            spinner.fail(`Pull failed: ${result.error}`);
            return;
          }
          commit = result.commit;
          spinner.succeed(`Updated to ${commit}`);
        } else {
          // ~/.agents/ is not a git repo yet — skip git pull, proceed with local resource sync
          spinner.succeed('Using local ~/.agents/ (no remote configured)');
        }

        // Pull extra DotAgent repos before resource sync so any new skills /
        // commands they ship land in the version homes on this same run.
        const extraRepos = getEnabledExtraRepos();
        if (extraRepos.length > 0) {
          console.log(chalk.bold(`\nExtra repos (${extraRepos.length}):\n`));
          for (const { alias, dir } of extraRepos) {
            const extraSpinner = ora(`Pulling ${alias}...`).start();
            const result = await pullRepo(dir);
            if (result.success) {
              extraSpinner.succeed(`${alias} -> ${result.commit}`);
            } else {
              extraSpinner.warn(`${alias}: ${result.error}`);
            }
          }
        }

        // One-time migration: promptcuts.yaml moved from agent-scoped
        // (e.g. claude/promptcuts.yaml) to repo root. We move it so the
        // hook at ~/.agents-system/hooks/ can always find it at a fixed path.
        migratePromptcutsToRoot(agentsDir);

        // Read manifest for CLI versions and MCP config
        const manifest = readManifest(agentsDir);
        if (!manifest) {
          console.log(chalk.gray(`\nNo ${MANIFEST_FILENAME} found`));
        }

        // Install/upgrade CLI versions
        if (!options.skipClis && manifest?.agents) {
          console.log(chalk.bold('\nCLI Versions:\n'));

          const cliAgents = Object.keys(manifest.agents) as AgentId[];
          for (const agentId of cliAgents) {
            if (agentFilter && agentId !== agentFilter) continue;
            const agent = AGENTS[agentId];
            if (!agent) continue;

            const cliSpinner = ora(`Checking ${agentLabel(agent.id)}...`).start();
            const versions = listInstalledVersions(agentId);
            const targetVersion = manifest.agents[agentId] || 'latest';

            const result = await installVersion(agentId, targetVersion, (msg) => { cliSpinner.text = msg; });
            if (result.success) {
              const isNew = versions.length === 0;
              if (isNew) {
                cliSpinner.succeed(`Installed ${agentLabel(agent.id)}@${result.installedVersion}`);
              } else {
                cliSpinner.succeed(`${agentLabel(agent.id)}@${result.installedVersion}`);
              }
              // Repair if deleted and regenerate if its schema is out of date.
              ensureShimCurrent(agentId);
            } else {
              cliSpinner.warn(`${agentLabel(agent.id)}: ${result.error}`);
            }
          }
        }

        // Register MCP servers
        if (manifest?.mcp && Object.keys(manifest.mcp).length > 0) {
          console.log(chalk.bold('\nMCP Servers:\n'));

          for (const [name, config] of Object.entries(manifest.mcp)) {
            if (!config.command || config.transport === 'http') continue;

            const scopedAgents = (config.agents ? [...config.agents] : [...MCP_CAPABLE_AGENTS]).filter(
              (id) => !agentFilter || id === agentFilter
            );
            const scopedVersions = config.agentVersions
              ? Object.fromEntries(
                  Object.entries(config.agentVersions).filter(([agentId]) => !agentFilter || agentId === agentFilter)
                ) as Partial<Record<AgentId, string[]>>
              : undefined;
            const targets = resolveConfiguredAgentTargets(
              scopedAgents,
              scopedVersions,
              MCP_CAPABLE_AGENTS
            );
            const results = await registerMcpToTargets(
              targets,
              name,
              config.command,
              config.scope || 'user',
              config.transport || 'stdio'
            );

            for (const result of results) {
              if (result.success) {
                const label = result.version
                  ? `${agentLabel(result.agentId)}@${result.version}`
                  : agentLabel(result.agentId);
                console.log(`  ${chalk.green('+')} ${name} -> ${label}`);
              }
            }
          }
        }

        // Sync resources to default version homes only
        const cliStates = await getAllCliStates();
        const agentsToSync = agentFilter ? [agentFilter] : ALL_AGENT_IDS;
        const available = getAvailableResources();

        for (const agentId of agentsToSync) {
          if (!cliStates[agentId]?.installed && listInstalledVersions(agentId).length === 0) continue;
          const defaultVer = getGlobalDefault(agentId);
          if (!defaultVer) continue;

          const actuallySynced = getActuallySyncedResources(agentId, defaultVer);
          const newResources = getNewResources(available, actuallySynced);

          const hasAnySynced = actuallySynced.commands.length > 0 ||
            actuallySynced.skills.length > 0 ||
            actuallySynced.hooks.length > 0 ||
            actuallySynced.memory.length > 0 ||
            actuallySynced.mcp.length > 0 ||
            actuallySynced.permissions.length > 0 ||
            actuallySynced.plugins.length > 0;

          try {
            let selection: ResourceSelection | undefined;

            if (skipPrompts) {
              // -y flag: sync all without prompting
              if (!hasAnySynced || hasNewResources(newResources, agentId)) {
                selection = {
                  commands: 'all', skills: 'all', hooks: 'all', memory: 'all',
                  mcp: 'all', permissions: 'all', subagents: 'all', plugins: 'all',
                };
              }
            } else if (!hasAnySynced) {
              // Nothing synced yet - prompt for ALL resources
              console.log(chalk.yellow(`\n${agentLabel(agentId)}@${defaultVer} has no synced resources.`));
              const userSelection = await promptResourceSelection(agentId);
              if (userSelection) selection = userSelection;
            } else if (hasNewResources(newResources, agentId, defaultVer)) {
              // Has synced before, but NEW items available
              console.log(chalk.cyan(`\n${agentLabel(agentId)}@${defaultVer}:`));
              const userSelection = await promptNewResourceSelection(agentId, newResources, defaultVer);
              if (userSelection) selection = userSelection;
            }

            if (selection && Object.keys(selection).length > 0) {
              const syncResult = syncResourcesToVersion(agentId, defaultVer, selection);
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
          } catch (err) {
            if (isPromptCancelled(err)) {
              console.log(chalk.gray('Skipped resource selection'));
            } else {
              throw err;
            }
          }
        }

        // Register hooks as lifecycle events in each agent's config file.
        // Claude/codex/gemini all support prompt-time hooks, though only
        // claude can replace the prompt — codex/gemini append via
        // additionalContext. The hook script detects the caller and emits
        // the correct protocol.
        const hookManifest = parseHookManifest();
        if (Object.keys(hookManifest).length > 0) {
          let hookRegistered = 0;
          const hookAgents = new Set(HOOKS_CAPABLE_AGENTS as readonly AgentId[]);
          for (const agentId of agentsToSync) {
            if (!hookAgents.has(agentId)) continue;
            const versions = listInstalledVersions(agentId);
            const defaultVer = getGlobalDefault(agentId);
            const targetVersions = defaultVer ? [defaultVer] : versions.slice(-1);

            for (const ver of targetVersions) {
              const home = getVersionHomePath(agentId, ver);
              const result = registerHooksToSettings(agentId, home, hookManifest);
              hookRegistered += result.registered.length;
              for (const error of result.errors) {
                console.log(chalk.yellow(`  Hook warning: ${error}`));
              }
            }
          }
          if (hookRegistered > 0) {
            console.log(chalk.green(`\nRegistered ${hookRegistered} hook lifecycle event(s)`));
          }
        }

        // Auto-add shims to PATH if not already there
        if (!isShimsInPath()) {
          const pathResult = addShimsToPath();
          if (pathResult.success && !pathResult.alreadyPresent) {
            console.log(chalk.green(`\nAdded shims to ~/${pathResult.rcFile}`));
            console.log(chalk.gray('Restart your shell or run: source ~/' + pathResult.rcFile));
          } else if (!pathResult.success) {
            console.log(chalk.yellow('\nCould not auto-add shims to PATH:'));
            console.log(chalk.gray(getPathSetupInstructions()));
          }
        }

        // Check for agents without a default version - offer to switch
        if (!skipPrompts) {
          const agentsNeedingDefault: AgentId[] = [];
          for (const agentId of agentsToSync) {
            const versions = listInstalledVersions(agentId);
            if (versions.length > 0 && !getGlobalDefault(agentId)) {
              agentsNeedingDefault.push(agentId);
            }
          }

          // Phase 1: Collect all version selections first
          const selectedVersions: Array<{ agentId: AgentId; version: string }> = [];

          for (const agentId of agentsNeedingDefault) {
            const versions = listInstalledVersions(agentId);
            const agent = AGENTS[agentId];

            const shouldSwitch = await select({
              message: `${agentLabel(agent.id)} has no default version. Set one now?`,
              choices: [
                { name: 'Yes, pick a version', value: 'pick' },
                { name: 'Skip for now', value: 'skip' },
              ],
            });

            if (shouldSwitch === 'pick') {
              const selectedVersion = await select({
                message: `Select ${agentLabel(agent.id)} version:`,
                choices: versions.map((v) => ({ name: v, value: v })),
              });

              selectedVersions.push({ agentId, version: selectedVersion });
            }
          }

          // Apply migrations for all selected versions
          for (const { agentId, version } of selectedVersions) {
            const agent = AGENTS[agentId];
            setGlobalDefault(agentId, version);
            const symlinkResult = await switchConfigSymlink(agentId, version);
            if (!symlinkResult.success) {
              console.log(chalk.yellow(`Warning: ${symlinkResult.error}`));
            } else if (symlinkResult.backupPath) {
              console.log(chalk.gray(`Backed up existing config to: ${symlinkResult.backupPath}`));
            }
            switchHomeFileSymlinks(agentId, version);
            console.log(chalk.green(`Set ${agentLabel(agent.id)}@${version} as default`));
          }
        }

        // Report (and optionally install) any declared CLIs that are missing
        // from the host. Skipped under -y so non-interactive pulls don't trigger
        // package-manager prompts.
        try {
          const { statuses, errors } = listCliStatus(process.cwd());
          for (const err of errors) {
            console.log(chalk.yellow(`  CLI manifest parse error: ${err.file}: ${err.reason}`));
          }
          const missing = statuses.filter((s) => !s.installed);
          if (missing.length > 0) {
            console.log(chalk.bold('\nDeclared CLIs missing from this host:'));
            for (const s of missing) {
              const method = selectInstallMethod(s.manifest);
              const action = method ? describeMethod(method) : chalk.red('no compatible install method');
              console.log(`  ${chalk.cyan(s.manifest.name.padEnd(20))} ${chalk.gray(action)}`);
            }
            console.log('');

            if (!skipPrompts) {
              const proceed = await confirm({ message: `Install ${missing.length} missing CLI(s) now?`, default: true });
              if (proceed) {
                for (const s of missing) {
                  console.log(chalk.bold(`\n→ ${s.manifest.name}`));
                  const result = installCli(s.manifest);
                  if (result.error) {
                    console.log(chalk.red(`  ${result.error}`));
                    continue;
                  }
                  if (result.installed) {
                    console.log(chalk.green(`  installed`));
                    if (s.manifest.postInstall) {
                      console.log(chalk.gray(s.manifest.postInstall.trim().split('\n').map((l) => '  ' + l).join('\n')));
                    }
                  } else {
                    console.log(chalk.yellow(`  install ran but \`${s.manifest.check}\` still fails`));
                  }
                }
              } else {
                console.log(chalk.gray(`Skipped. Run 'agents cli install' later.`));
              }
            } else {
              console.log(chalk.gray(`Run 'agents cli install' to install them.`));
            }
          }
        } catch (err) {
          if (!isPromptCancelled(err)) {
            console.log(chalk.yellow(`CLI install skipped: ${(err as Error).message}`));
          }
        }

        console.log(chalk.green('\nPull complete'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          spinner.stop();
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        spinner.fail('Failed to sync');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
