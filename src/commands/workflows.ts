/**
 * Workflow management commands.
 *
 * Implements `agents workflows` — list, view, add, remove pipeline workflows
 * (WORKFLOW.md bundles with optional subagents/, skills/, plugins/ subdirs).
 * Run a workflow with: agents run <workflow-name>
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { select, checkbox } from '@inquirer/prompts';

import { resolveAgentName, agentLabel } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  WORKFLOW_CAPABLE_AGENTS,
  discoverWorkflowsFromRepo,
  installWorkflowCentrally,
  removeWorkflow,
  listInstalledWorkflows,
  listWorkflowsForAgent,
  removeWorkflowFromVersion,
  iterWorkflowsCapableVersions,
  type WorkflowFrontmatter,
  type InstalledWorkflow,
} from '../lib/workflows.js';
import {
  getVersionHomePath,
  getGlobalDefault,
  resolveVersionAlias,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  resolveAgentVersionTargets,
} from '../lib/versions.js';
import { recordVersionResources, getUserWorkflowsDir } from '../lib/state.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  requireInteractiveSelection,
  printWithPager,
  promptRemovalTargets,
  type RemovalTarget,
} from './utils.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';

/** Register the `agents workflows` command tree (list, view, add, remove). */
export function registerWorkflowsCommands(program: Command): void {
  const workflowsCmd = program
    .command('workflows')
    .description('Manage multi-agent pipeline workflows (WORKFLOW.md bundles)')
    .addHelpText('after', `
Workflows are directory bundles (WORKFLOW.md + subagents/) that define multi-agent pipelines run via:
  agents run <workflow-name>

Examples:
  # See what workflows are available
  agents workflows list

  # Install from GitHub
  agents workflows add gh:user/workflows

  # Install a local workflow directory
  agents workflows add ./rdev

  # Remove a workflow
  agents workflows remove rdev
`);

  workflowsCmd
    .command('list [agent]')
    .description('Show installed workflows and which agent versions they are synced to')
    .option('-a, --agent <agent>', 'Filter to a specific agent')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

      const agentInput = agentArg || options.agent;
      let filterAgent: AgentId | undefined;
      let filterVersion: string | undefined;

      if (agentInput) {
        const parts = agentInput.split('@');
        const resolved = resolveAgentName(parts[0]);
        if (!resolved) {
          spinner.stop();
          console.log(chalk.red(`Unknown agent: ${parts[0]}`));
          process.exit(1);
        }
        filterAgent = resolved;
        filterVersion = parts[1] ? resolveVersionAlias(resolved, parts[1]) : undefined;
      }

      const rows = buildWorkflowRows({ filterAgent, filterVersion });
      spinner.stop();

      await showResourceList({
        resourcePlural: 'workflows',
        resourceSingular: 'workflow',
        extraLabel: 'Agents',
        rows,
        emptyMessage: filterAgent
          ? `No workflows in central storage for ${agentLabel(filterAgent)}.`
          : 'No workflows in ~/.agents/workflows/. Add one with: agents workflows add gh:user/repo',
        centralPath: getUserWorkflowsDir(),
        filterAgent,
        filterVersion,
      });
    });

  workflowsCmd
    .command('add [source]')
    .description('Install workflows from a source (GitHub, local) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, claude@2.1.138')
    .option('-y, --yes', 'Skip confirmation prompts')
    .addHelpText('after', `
Examples:
  # Install from GitHub
  agents workflows add gh:user/workflows

  # Install a local workflow directory (must contain WORKFLOW.md)
  agents workflows add ./rdev

  # Install and sync to a specific version
  agents workflows add gh:user/workflows --agents claude@2.1.138
`)
    .action(async (source: string | undefined, options) => {
      try {
        type WorkflowRef = { name: string; path: string };
        let workflows: WorkflowRef[];

        if (!source) {
          // Interactive: pick from central storage
          const installed = listInstalledWorkflows();
          if (installed.size === 0) {
            console.log(chalk.yellow('No workflows in ~/.agents/workflows/'));
            console.log(chalk.gray('\nTo add workflows from a repo:'));
            console.log(chalk.cyan('  agents workflows add gh:user/repo'));
            return;
          }

          if (!isInteractiveTerminal()) {
            requireInteractiveSelection('Selecting workflows', [
              'agents workflows add gh:user/repo',
            ]);
          }

          const choices = Array.from(installed.values()).map(w => ({
            value: w.name,
            name: w.frontmatter.description
              ? `${w.name}  ${chalk.gray(w.frontmatter.description.slice(0, 50))}`
              : w.name,
          }));

          const selected = await checkbox({ message: 'Select workflows to sync', choices });
          if (selected.length === 0) {
            console.log(chalk.gray('No workflows selected.'));
            return;
          }
          workflows = selected.map(name => ({ name, path: installed.get(name)!.path }));
        } else {
          // Fetch from repo or local path
          const spinner = ora('Fetching workflows...').start();
          const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                            source.startsWith('https://') || source.startsWith('http://');
          let localPath: string;

          if (isGitRepo) {
            const result = await cloneRepo(source);
            localPath = result.localPath;
            spinner.succeed('Repository cloned');
          } else {
            localPath = source.startsWith('~')
              ? path.join(os.homedir(), source.slice(1))
              : path.resolve(source);
            if (!fs.existsSync(localPath)) {
              spinner.fail(`Path not found: ${localPath}`);
              return;
            }
            spinner.succeed('Using local path');
          }

          const discovered = discoverWorkflowsFromRepo(localPath);
          if (discovered.length === 0) {
            console.log(chalk.yellow('No workflows found (looking for WORKFLOW.md files)'));
            return;
          }

          console.log(chalk.bold(`\nFound ${discovered.length} workflow(s):`));
          for (const w of discovered) {
            console.log(`\n  ${chalk.cyan(w.name)}: ${w.frontmatter.description || 'no description'}`);
            if (w.subagentCount > 0) {
              console.log(`    ${chalk.gray(`${w.subagentCount} subagent${w.subagentCount === 1 ? '' : 's'}`)}`);
            }
          }

          const installSpinner = ora('Installing to central storage...').start();
          let installed = 0;
          for (const w of discovered) {
            const result = installWorkflowCentrally(w.path, w.name);
            if (result.success) {
              installed++;
            } else {
              installSpinner.stop();
              console.log(chalk.red(`\n  Failed to install ${w.name}: ${result.error}`));
              installSpinner.start();
            }
          }
          installSpinner.succeed(`Installed ${installed} workflow(s) to ~/.agents/workflows/`);
          workflows = discovered.map(w => ({
            name: w.name,
            path: path.join(getUserWorkflowsDir(), w.name),
          }));
        }

        // Agent/version selection
        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        if (options.agents) {
          const result = resolveAgentVersionTargets(options.agents, WORKFLOW_CAPABLE_AGENTS);
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(WORKFLOW_CAPABLE_AGENTS, {
            skipPrompts: options.yes || !isInteractiveTerminal(),
          });
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        }

        if (selectedAgents.length === 0) {
          console.log(chalk.yellow('\nNo agents selected.'));
          return;
        }

        const syncSpinner = ora('Syncing to agent versions...').start();
        let synced = 0;
        const workflowNames = workflows.map(w => w.name);

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'workflows', workflowNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nWorkflows installed.'));
        console.log(chalk.gray('Run with: agents run <workflow-name>'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add workflows'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  workflowsCmd
    .command('remove [name]')
    .description('Remove a workflow from version homes (interactive picker if no name given)')
    .addHelpText('after', `
Examples:
  # Remove a workflow by name
  agents workflows remove rdev

  # Interactive picker
  agents workflows remove
`)
    .action(async (name?: string) => {
      type WorkflowTargetInfo = { name: string; targets: Array<{ agent: AgentId; version: string }> };
      const workflowTargetMap = new Map<string, WorkflowTargetInfo>();

      for (const { agent, version } of iterWorkflowsCapableVersions()) {
        const home = getVersionHomePath(agent, version);
        for (const n of listWorkflowsForAgent(agent, home)) {
          const existing = workflowTargetMap.get(n);
          if (existing) {
            existing.targets.push({ agent, version });
          } else {
            workflowTargetMap.set(n, { name: n, targets: [{ agent, version }] });
          }
        }
      }

      let toRemove: string[];

      if (name) {
        toRemove = [name];
      } else {
        if (workflowTargetMap.size === 0) {
          console.log(chalk.yellow('No workflows synced to any version.'));
          return;
        }
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting workflows to remove', [
            'agents workflows remove rdev',
          ]);
        }
        try {
          const selected = await checkbox({
            message: 'Select workflows to remove',
            choices: Array.from(workflowTargetMap.values()).map(w => ({
              value: w.name,
              name: w.name,
            })),
          });
          if (selected.length === 0) {
            console.log(chalk.gray('No workflows selected.'));
            return;
          }
          toRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      let removed = 0;
      for (const workflowName of toRemove) {
        const info = workflowTargetMap.get(workflowName);

        if (!info || info.targets.length === 0) {
          // Not synced to any version — try removing from central storage directly
          const result = removeWorkflow(workflowName);
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${workflowName}: removed from central storage`);
            removed++;
          } else {
            console.log(chalk.yellow(`  Workflow '${workflowName}' not found.`));
          }
          continue;
        }

        const removalTargets: RemovalTarget[] = info.targets.map(t => ({
          agent: t.agent,
          version: t.version,
          label: `${agentLabel(t.agent)}@${t.version}`,
        }));

        const selectedTargets = await promptRemovalTargets(workflowName, removalTargets);
        if (selectedTargets.length === 0) {
          console.log(chalk.gray(`  Skipped '${workflowName}'.`));
          continue;
        }

        for (const target of selectedTargets) {
          const result = removeWorkflowFromVersion(target.agent as AgentId, target.version, workflowName);
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${target.label}: ${workflowName}`);
            removed++;
          } else if (result.error) {
            console.log(`  ${chalk.yellow('!')} ${target.label}: ${result.error}`);
          }
        }
      }

      if (removed === 0) {
        console.log(chalk.yellow('No workflows removed.'));
      } else {
        console.log(chalk.green(`\nRemoved ${removed} workflow(s) from version homes.`));
        console.log(chalk.gray('Central source unchanged. Use "agents workflows remove <name>" again to remove from ~/.agents/workflows/.'));
      }
    });

  workflowsCmd
    .command('view [name]')
    .description('Read workflow details (description, subagents, model, MCP)')
    .addHelpText('after', `
Examples:
  # View a specific workflow
  agents workflows view rdev

  # Interactive picker
  agents workflows view
`)
    .action(async (name?: string) => {
      const installed = listInstalledWorkflows();

      if (!name) {
        if (installed.size === 0) {
          console.log(chalk.yellow('No workflows installed'));
          return;
        }
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a workflow to view', [
            'agents workflows view rdev',
          ]);
        }
        try {
          name = await select({
            message: 'Select a workflow to view',
            choices: Array.from(installed.values()).map(w => ({
              value: w.name,
              name: w.frontmatter.description
                ? `${w.name} - ${w.frontmatter.description}`
                : w.name,
            })),
          });
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      const workflow = installed.get(name!);
      if (!workflow) {
        console.log(chalk.yellow(`Workflow '${name}' not found`));
        return;
      }

      const lines: string[] = [];
      const fm = workflow.frontmatter;
      lines.push(chalk.bold(`\n${fm.name || workflow.name}\n`));
      if (fm.description) lines.push(`  ${fm.description}`);
      lines.push('');
      if (fm.model) lines.push(`  Model:  ${fm.model}`);
      if (fm.tools?.length) lines.push(`  Tools:  ${fm.tools.join(', ')}`);
      if (fm.mcpServers?.length) lines.push(`  MCP:    ${fm.mcpServers.join(', ')}`);
      if (fm.skills?.length) lines.push(`  Skills: ${fm.skills.join(', ')}`);
      lines.push(`  Path:   ${workflow.path}`);

      if (fm.allowedAgents?.length) {
        lines.push(chalk.bold(`\n  Subagents (${workflow.subagentCount}):`));
        for (const a of fm.allowedAgents) {
          lines.push(`    ${chalk.cyan(a)}`);
        }
      }
      lines.push('');

      printWithPager(lines.join('\n'), lines.length);
    });
}

function buildWorkflowRows(opts: {
  filterAgent?: AgentId;
  filterVersion?: string;
}): ResourceRow[] {
  const central = listInstalledWorkflows();
  if (central.size === 0) return [];

  const targetPairs = iterWorkflowsCapableVersions({
    agent: opts.filterAgent,
    version: opts.filterVersion,
  });

  const syncedByTarget = new Map<string, Set<string>>();
  const defaultByAgent = new Map<AgentId, string | null>();

  for (const { agent, version } of targetPairs) {
    if (!defaultByAgent.has(agent)) defaultByAgent.set(agent, getGlobalDefault(agent));
    const home = getVersionHomePath(agent, version);
    syncedByTarget.set(`${agent}@${version}`, new Set(listWorkflowsForAgent(agent, home)));
  }

  const rows: ResourceRow[] = [];
  for (const [name, workflow] of central) {
    const targets: SyncTarget[] = targetPairs.map(({ agent, version }) => ({
      agent,
      version,
      isDefault: defaultByAgent.get(agent) === version,
      status: syncedByTarget.get(`${agent}@${version}`)?.has(name) ? 'synced' : 'missing',
    }));

    rows.push({
      name,
      description: workflow.frontmatter.description,
      extra: workflow.subagentCount > 0 ? `${workflow.subagentCount}` : '-',
      targets,
      buildDetail: () => formatWorkflowDetail(workflow, targets),
    });
  }

  rows.sort((a, b) => {
    const aSynced = a.targets.filter(t => t.status === 'synced').length;
    const bSynced = b.targets.filter(t => t.status === 'synced').length;
    if (aSynced !== bSynced) return bSynced - aSynced;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function formatWorkflowDetail(
  workflow: InstalledWorkflow,
  targets: SyncTarget[],
): string {
  const lines: string[] = [];
  const fm: WorkflowFrontmatter = workflow.frontmatter;
  lines.push(chalk.bold.cyan(workflow.name));
  if (fm.description) lines.push(chalk.gray(fm.description));
  lines.push('');

  const meta: string[] = [];
  if (fm.model) meta.push(`model ${chalk.white(fm.model)}`);
  if (fm.mcpServers?.length) meta.push(`${chalk.white(fm.mcpServers.length)} MCP`);
  if (fm.skills?.length) meta.push(`${chalk.white(fm.skills.length)} skill${fm.skills.length === 1 ? '' : 's'}`);
  meta.push(`${chalk.white(workflow.subagentCount)} subagent${workflow.subagentCount === 1 ? '' : 's'}`);
  if (meta.length) lines.push('  ' + meta.join(chalk.gray(' · ')));
  lines.push('  ' + chalk.gray(workflow.path));

  lines.push('');
  lines.push(chalk.bold('  Synced to'));
  lines.push(buildTargetsSection(targets));

  return lines.join('\n');
}
