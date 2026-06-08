/**
 * Materialization helpers — install manifest CLIs, register MCP servers,
 * sync resources into installed version homes, register hooks, add shims to
 * PATH, prompt for missing default versions, install declared host-CLIs.
 *
 * Used by `agents repo refresh` (user-facing) and any other caller that needs
 * to re-derive local state from declared configuration. Does NOT do any git
 * operations — that lives in `agents repo pull`.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { select, confirm } from '@inquirer/prompts';
import { capableAgents } from './capabilities.js';
import {
  AGENTS,
  ALL_AGENT_IDS,
  getAllCliStates,
  registerMcpToTargets,
  agentLabel,
} from './agents.js';
import { readManifest, MANIFEST_FILENAME } from './manifest.js';
import { getUserAgentsDir } from './state.js';
import type { AgentId } from './types.js';
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
  getProjectOnlyResources,
  hasNewResources,
  promptNewResourceSelection,
  promptResourceSelection,
  resolveConfiguredAgentTargets,
  type ResourceSelection,
} from './versions.js';
import {
  listCliStatus,
  installCli,
  describeMethod,
  describeCheck,
  selectInstallMethod,
} from './cli-resources.js';
import {
  ensureShimCurrent,
  isShimsInPath,
  addShimsToPath,
  getPathSetupInstructions,
  switchConfigSymlink,
  switchHomeFileSymlinks,
} from './shims.js';
import { parseHookManifest, registerHooksToSettings } from './hooks.js';
import { isPromptCancelled } from '../commands/utils.js';

export interface RefreshOptions {
  /** Limit operations to a single agent (claude/codex/etc). Default: all installed. */
  agentFilter?: AgentId;
  /** Auto-sync everything and skip interactive prompts. */
  skipPrompts?: boolean;
  /** Skip CLI version install/upgrade from agents.yaml. */
  skipClis?: boolean;
}

/**
 * Old repo layout stored promptcuts under claude/promptcuts.yaml (agent-scoped).
 * The new layout is `~/.agents/.system/promptcuts.yaml` at the repo root — the
 * hook reads from a fixed path so it survives version upgrades. If the root
 * file doesn't exist yet but an agent-scoped one does, hoist the first one found.
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

/**
 * Re-materialize local state from declared configuration: install CLI versions,
 * register MCP servers, sync resources to version homes, register hooks, add
 * shims to PATH, prompt for missing defaults, install declared host-CLIs.
 *
 * Idempotent — safe to run repeatedly. No network operations.
 */
export async function refresh(options: RefreshOptions = {}): Promise<void> {
  const { agentFilter, skipPrompts = false, skipClis = false } = options;
  const agentsDir = getUserAgentsDir();

  migratePromptcutsToRoot(agentsDir);

  const manifest = readManifest(agentsDir);
  if (!manifest) {
    console.log(chalk.gray(`No ${MANIFEST_FILENAME} found`));
  }

  // 1. Install/upgrade CLI versions from agents.yaml
  if (!skipClis && manifest?.agents) {
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
        ensureShimCurrent(agentId);
      } else {
        cliSpinner.warn(`${agentLabel(agent.id)}: ${result.error}`);
      }
    }
  }

  // 2. Register MCP servers
  if (manifest?.mcp && Object.keys(manifest.mcp).length > 0) {
    console.log(chalk.bold('\nMCP Servers:\n'));

    for (const [name, config] of Object.entries(manifest.mcp)) {
      if (!config.command || config.transport === 'http') continue;

      const scopedAgents = (config.agents ? [...config.agents] : [...capableAgents('mcp')]).filter(
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
        capableAgents('mcp')
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

  // 3. Sync resources to default version homes
  const cliStates = await getAllCliStates();
  const agentsToSync = agentFilter ? [agentFilter] : ALL_AGENT_IDS;
  const available = getAvailableResources();

  for (const agentId of agentsToSync) {
    if (!cliStates[agentId]?.installed && listInstalledVersions(agentId).length === 0) continue;
    const defaultVer = getGlobalDefault(agentId);
    if (!defaultVer) continue;

    const actuallySynced = getActuallySyncedResources(agentId, defaultVer);
    const newResources = getNewResources(available, actuallySynced, getProjectOnlyResources());

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
        if (!hasAnySynced || hasNewResources(newResources, agentId)) {
          selection = {
            commands: 'all', skills: 'all', hooks: 'all', memory: 'all',
            mcp: 'all', permissions: 'all', subagents: 'all', plugins: 'all',
          };
        }
      } else if (!hasAnySynced) {
        console.log(chalk.yellow(`\n${agentLabel(agentId)}@${defaultVer} has no synced resources.`));
        const userSelection = await promptResourceSelection(agentId);
        if (userSelection) selection = userSelection;
      } else if (hasNewResources(newResources, agentId, defaultVer)) {
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

  // 4. Register hooks as lifecycle events
  const hookManifest = parseHookManifest();
  if (Object.keys(hookManifest).length > 0) {
    let hookRegistered = 0;
    const hookAgents = new Set(capableAgents('hooks') as readonly AgentId[]);
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

  // 5. Auto-add shims to PATH
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

  // 6. Prompt for missing default versions
  if (!skipPrompts) {
    const agentsNeedingDefault: AgentId[] = [];
    for (const agentId of agentsToSync) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0 && !getGlobalDefault(agentId)) {
        agentsNeedingDefault.push(agentId);
      }
    }

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

  // 7. Install declared host-CLIs
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
              console.log(chalk.yellow(`  install ran but \`${describeCheck(s.manifest.check)}\` still fails`));
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
}
