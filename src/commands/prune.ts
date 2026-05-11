/**
 * Top-level `agents prune` — destructive cleanup across the install.
 *
 * Cleanup targets:
 *   - Resource orphans: command/skill/hook files inside a version home that no
 *     longer come from any source (deleted from ~/.agents/ but never reconciled
 *     into the version install).
 *   - Version duplicates: older installed versions of an agent that share an
 *     account with a newer installed version of the same agent.
 *   - Trash: soft-deleted resources in ~/.agents/.trash/ older than N days.
 *   - Sessions: session records in sessions.db older than N days.
 *   - Runs: routine execution logs, keeping only the last N per job.
 *
 * Sync (additive: copy missing/changed files into version homes) is no longer
 * a user-facing verb — `syncResourcesToVersion` runs at agent launch and
 * applies adds/updates automatically. Pruning, however, is destructive, so it
 * stays explicit.
 *
 * Default scope: each agent's currently-pinned default version for orphan
 * cleanup, plus the standard cross-agent version-dedup pass. Pass `--all`
 * to widen orphan cleanup to every installed version.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import {
  diffVersionCommands,
  iterCommandsCapableVersions,
  removeCommandFromVersion,
} from '../lib/commands.js';
import {
  diffVersionSkills,
  iterSkillsCapableVersions,
  removeSkillFromVersion,
} from '../lib/skills.js';
import {
  diffVersionHooks,
  iterHooksCapableVersions,
  removeHookFromVersion,
} from '../lib/hooks.js';
import {
  diffVersionPlugins,
  iterPluginsCapableVersions,
  removePluginSkillFromVersion,
} from '../lib/plugins.js';
import {
  diffVersionSubagents,
  iterSubagentsCapableVersions,
  removeSubagentFromVersion,
} from '../lib/subagents.js';
import { getGlobalDefault } from '../lib/versions.js';
import { resolveAgentName, formatAgentError } from '../lib/agents.js';
import { pruneDuplicates } from './view.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { getTrashDir } from '../lib/state.js';
import { countSessionsOlderThan, deleteSessionsOlderThan } from '../lib/session/db.js';
import { previewRunsPrune, pruneRuns, countAllRuns } from '../lib/routines.js';

type ResourceType = 'commands' | 'skills' | 'hooks' | 'plugins' | 'subagents';
type StateType = 'trash' | 'sessions' | 'runs';
type PruneType = ResourceType | 'versions' | StateType;

const RESOURCE_TYPES: ResourceType[] = ['commands', 'skills', 'hooks', 'plugins', 'subagents'];
const STATE_TYPES: StateType[] = ['trash', 'sessions', 'runs'];
const ALL_TYPES: PruneType[] = [...RESOURCE_TYPES, 'versions', ...STATE_TYPES];

interface PruneOptions {
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  olderThan?: string;
  keep?: string;
}

interface OrphanGroup {
  type: ResourceType;
  agent: AgentId;
  version: string;
  orphans: string[];
}

function scopePairs(
  pairs: Array<{ agent: AgentId; version: string }>,
  all: boolean,
): Array<{ agent: AgentId; version: string }> {
  if (all) return pairs;
  return pairs.filter((p) => p.version === getGlobalDefault(p.agent));
}

function collectOrphans(types: ResourceType[], all: boolean): OrphanGroup[] {
  const groups: OrphanGroup[] = [];

  if (types.includes('commands')) {
    for (const { agent, version } of scopePairs(iterCommandsCapableVersions(), all)) {
      const diff = diffVersionCommands(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'commands', agent, version, orphans: diff.orphans });
      }
    }
  }

  if (types.includes('skills')) {
    for (const { agent, version } of scopePairs(iterSkillsCapableVersions(), all)) {
      const diff = diffVersionSkills(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'skills', agent, version, orphans: diff.orphans });
      }
    }
  }

  if (types.includes('hooks')) {
    for (const { agent, version } of scopePairs(iterHooksCapableVersions(), all)) {
      const diff = diffVersionHooks(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'hooks', agent, version, orphans: diff.orphans });
      }
    }
  }

  if (types.includes('plugins')) {
    for (const { agent, version } of scopePairs(iterPluginsCapableVersions(), all)) {
      const diff = diffVersionPlugins(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'plugins', agent, version, orphans: diff.orphans });
      }
    }
  }

  if (types.includes('subagents')) {
    for (const { agent, version } of scopePairs(iterSubagentsCapableVersions(), all)) {
      const diff = diffVersionSubagents(agent, version);
      if (diff.orphans.length > 0) {
        groups.push({ type: 'subagents', agent, version, orphans: diff.orphans });
      }
    }
  }

  return groups;
}

function removeOne(group: OrphanGroup, name: string): { success: boolean; error?: string } {
  switch (group.type) {
    case 'commands':
      return removeCommandFromVersion(group.agent, group.version, name);
    case 'skills':
      return removeSkillFromVersion(group.agent, group.version, name);
    case 'hooks':
      return removeHookFromVersion(group.agent, group.version, name);
    case 'plugins':
      return removePluginSkillFromVersion(group.agent, group.version, name);
    case 'subagents':
      return removeSubagentFromVersion(group.agent, group.version, name);
  }
}

/**
 * Resolve the optional positional. It can be a resource type, state type,
 * the literal "versions", or an agent name (shorthand for `prune versions <agent>`).
 */
interface ParsedTarget {
  resourceTypes: ResourceType[];
  includeVersions: boolean;
  stateType?: StateType;
  versionAgent?: AgentId;
}

function parseTarget(arg: string | undefined): ParsedTarget {
  if (!arg) {
    return { resourceTypes: RESOURCE_TYPES, includeVersions: true };
  }
  if (RESOURCE_TYPES.includes(arg as ResourceType)) {
    return { resourceTypes: [arg as ResourceType], includeVersions: false };
  }
  if (STATE_TYPES.includes(arg as StateType)) {
    return { resourceTypes: [], includeVersions: false, stateType: arg as StateType };
  }
  if (arg === 'versions') {
    return { resourceTypes: [], includeVersions: true };
  }
  // Try treating as an agent name — shortcut for `prune versions <agent>`.
  const agentId = resolveAgentName(arg);
  if (agentId) {
    return { resourceTypes: [], includeVersions: true, versionAgent: agentId };
  }
  console.log(chalk.red(`Unknown prune target: ${arg}`));
  console.log(chalk.gray(`Available types: ${ALL_TYPES.join(', ')}`));
  console.log(chalk.gray(formatAgentError(arg)));
  process.exit(1);
}

function parseDays(value: string, defaultDays: number): number {
  const match = value.match(/^(\d+)d?$/);
  if (match) return parseInt(match[1], 10);
  return defaultDays;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let size = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      try { size += fs.statSync(fullPath).size; } catch { /* ignore */ }
    }
  }
  return size;
}

async function runTrashPrune(options: PruneOptions): Promise<void> {
  const trashDir = getTrashDir();
  if (!fs.existsSync(trashDir)) {
    console.log(chalk.green('Trash is empty.'));
    return;
  }

  const days = parseDays(options.olderThan || '30d', 30);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const toPrune: Array<{ path: string; mtime: number; size: number }> = [];

  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoffMs) {
          toPrune.push({ path: fullPath, mtime: stat.mtimeMs, size: entry.isDirectory() ? getDirSize(fullPath) : stat.size });
        } else if (entry.isDirectory()) {
          scanDir(fullPath);
        }
      } catch { /* skip inaccessible */ }
    }
  }

  scanDir(trashDir);

  if (toPrune.length === 0) {
    console.log(chalk.green(`No trash entries older than ${days} days.`));
    return;
  }

  const totalSize = toPrune.reduce((sum, e) => sum + e.size, 0);
  console.log(chalk.bold(`Trash entries older than ${days} days\n`));
  for (const entry of toPrune.slice(0, 20)) {
    const age = Math.floor((Date.now() - entry.mtime) / (24 * 60 * 60 * 1000));
    console.log(`  ${chalk.gray(`${age}d ago`)}  ${path.relative(trashDir, entry.path)}`);
  }
  if (toPrune.length > 20) {
    console.log(chalk.gray(`  ... and ${toPrune.length - 20} more`));
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.gray(`${toPrune.length} entries (${formatBytes(totalSize)}). Run without --dry-run to delete.`));
    return;
  }

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.log(chalk.yellow('Non-interactive shell: pass -y to confirm, or --dry-run to preview.'));
      process.exit(1);
    }
    let ok = false;
    try {
      ok = await confirm({ message: `Delete ${toPrune.length} entries (${formatBytes(totalSize)})?`, default: false });
    } catch (err) {
      if (isPromptCancelled(err)) { console.log(chalk.gray('Cancelled')); return; }
      throw err;
    }
    if (!ok) { console.log(chalk.gray('Cancelled')); return; }
  }

  let deleted = 0;
  for (const entry of toPrune) {
    try {
      fs.rmSync(entry.path, { recursive: true, force: true });
      deleted++;
    } catch { /* ignore */ }
  }

  console.log(chalk.green(`Pruned ${deleted} trash entries (${formatBytes(totalSize)}).`));
}

async function runSessionsPrune(options: PruneOptions): Promise<void> {
  const days = parseDays(options.olderThan || '90d', 90);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const count = countSessionsOlderThan(cutoffMs);

  if (count === 0) {
    console.log(chalk.green(`No sessions older than ${days} days.`));
    return;
  }

  console.log(chalk.bold(`Sessions older than ${days} days: ${count}\n`));

  if (options.dryRun) {
    console.log(chalk.gray(`${count} session(s). Run without --dry-run to delete.`));
    return;
  }

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.log(chalk.yellow('Non-interactive shell: pass -y to confirm, or --dry-run to preview.'));
      process.exit(1);
    }
    let ok = false;
    try {
      ok = await confirm({ message: `Delete ${count} session records?`, default: false });
    } catch (err) {
      if (isPromptCancelled(err)) { console.log(chalk.gray('Cancelled')); return; }
      throw err;
    }
    if (!ok) { console.log(chalk.gray('Cancelled')); return; }
  }

  const deleted = deleteSessionsOlderThan(cutoffMs);
  console.log(chalk.green(`Pruned ${deleted} session records.`));
}

async function runRunsPrune(options: PruneOptions): Promise<void> {
  const keep = options.keep ? parseInt(options.keep, 10) : 10;
  if (isNaN(keep) || keep < 0) {
    console.log(chalk.red('--keep must be a non-negative integer'));
    process.exit(1);
  }

  const preview = previewRunsPrune(keep);
  const total = countAllRuns();

  if (preview.length === 0) {
    console.log(chalk.green(`All jobs have ${keep} or fewer runs. Nothing to prune.`));
    return;
  }

  console.log(chalk.bold(`Routine runs to prune (keeping last ${keep} per job)\n`));
  const byJob = new Map<string, number>();
  for (const run of preview) {
    byJob.set(run.jobName, (byJob.get(run.jobName) || 0) + 1);
  }
  for (const [job, count] of byJob) {
    console.log(`  ${chalk.cyan(job)}: ${count} old runs`);
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.gray(`${preview.length} of ${total} runs would be deleted. Run without --dry-run to delete.`));
    return;
  }

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.log(chalk.yellow('Non-interactive shell: pass -y to confirm, or --dry-run to preview.'));
      process.exit(1);
    }
    let ok = false;
    try {
      ok = await confirm({ message: `Delete ${preview.length} old runs?`, default: false });
    } catch (err) {
      if (isPromptCancelled(err)) { console.log(chalk.gray('Cancelled')); return; }
      throw err;
    }
    if (!ok) { console.log(chalk.gray('Cancelled')); return; }
  }

  const { deleted, bytesFreed } = pruneRuns(keep);
  console.log(chalk.green(`Pruned ${deleted} runs (${formatBytes(bytesFreed)}).`));
}

async function runOrphanPrune(
  resourceTypes: ResourceType[],
  options: PruneOptions,
): Promise<void> {
  const groups = collectOrphans(resourceTypes, options.all === true);

  if (groups.length === 0) {
    console.log(chalk.green('No orphans.'));
    return;
  }

  const total = groups.reduce((n, g) => n + g.orphans.length, 0);

  console.log(chalk.bold('Orphans (in version home, not in any source)\n'));
  for (const g of groups) {
    const label = `${g.type} · ${g.agent}@${g.version}`;
    console.log(`  ${chalk.cyan(label)}  ${g.orphans.join(', ')}`);
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.gray(`${total} orphan(s). Run without --dry-run to delete.`));
    return;
  }

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.log(chalk.yellow('Non-interactive shell: pass -y to confirm, or --dry-run to preview.'));
      process.exit(1);
    }
    let ok = false;
    try {
      ok = await confirm({
        message: `Delete ${total} orphan${total === 1 ? '' : 's'}?`,
        default: false,
      });
    } catch (err) {
      if (isPromptCancelled(err)) {
        console.log(chalk.gray('Cancelled'));
        return;
      }
      throw err;
    }
    if (!ok) {
      console.log(chalk.gray('Cancelled'));
      return;
    }
  }

  let removed = 0;
  let failures = 0;
  for (const g of groups) {
    for (const name of g.orphans) {
      const r = removeOne(g, name);
      if (r.success) {
        removed++;
      } else {
        failures++;
        console.log(chalk.red(`  ! ${g.type} ${g.agent}@${g.version} ${name}: ${r.error}`));
      }
    }
  }

  const summary = `Pruned ${removed} orphan${removed === 1 ? '' : 's'}`;
  console.log(chalk.green(summary) + (failures > 0 ? chalk.red(`, ${failures} failed`) : '') + '.');
}

export function registerPruneCommand(program: Command): void {
  program
    .command('prune [target]')
    .description('Remove orphan resources, old versions, trash, sessions, or routine runs')
    .option('--all', 'For orphan cleanup: sweep every installed version (default: current default version per agent)')
    .option('--dry-run', 'Show what would be removed without deleting (default for state targets)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--older-than <days>', 'For trash/sessions: delete entries older than N days (default: 30d for trash, 90d for sessions)')
    .option('--keep <n>', 'For runs: keep the last N runs per job (default: 10)')
    .addHelpText('after', `
Targets:
  (none)     Orphans across commands, skills, hooks + duplicate versions
  commands   Orphan command files only
  skills     Orphan skill directories only
  hooks      Orphan hook scripts only
  versions   Older duplicate version installs only
  <agent>    Older duplicate versions for one agent (e.g. 'claude')
  trash      Soft-deleted resources older than --older-than days (default 30)
  sessions   Session records in sessions.db older than --older-than days (default 90)
  runs       Routine execution logs, keeping only --keep per job (default 10)

Examples:
  # Full sweep: orphan resources + duplicate versions for current defaults
  agents prune

  # Preview what a full sweep would remove
  agents prune --dry-run

  # Just orphan skills
  agents prune skills

  # Just version dedup
  agents prune versions

  # Deduplicate versions for one agent only
  agents prune claude

  # Sweep every installed version's orphans, not only the defaults
  agents prune --all

  # Preview trash entries older than 30 days
  agents prune trash --dry-run

  # Delete trash entries older than 60 days
  agents prune trash --older-than 60 -y

  # Preview session cleanup (90+ days old)
  agents prune sessions --dry-run

  # Delete sessions older than 180 days
  agents prune sessions --older-than 180 -y

  # Preview runs cleanup (keeping last 10)
  agents prune runs --dry-run

  # Keep only the last 5 runs per job
  agents prune runs --keep 5 -y

What's an orphan?
  A command, skill, or hook present inside a version home but missing from every
  configured source (project .agents/, central ~/.agents/, and any enabled extra
  repos). Usually leftovers from a resource that was deleted or moved but never
  reconciled into the version install.

Soft-delete:
  Version directories are NEVER hard-deleted. \`prune\` moves them to
  ~/.agents/.trash/versions/<agent>/<version>/<timestamp>/. Use
  \`agents prune trash\` to expire old trash entries.
`)
    .action(async (target: string | undefined, options: PruneOptions) => {
      const parsed = parseTarget(target);

      if (parsed.stateType) {
        switch (parsed.stateType) {
          case 'trash':
            await runTrashPrune(options);
            break;
          case 'sessions':
            await runSessionsPrune(options);
            break;
          case 'runs':
            await runRunsPrune(options);
            break;
        }
        return;
      }

      if (parsed.resourceTypes.length > 0) {
        await runOrphanPrune(parsed.resourceTypes, options);
        if (parsed.includeVersions) console.log();
      }

      if (parsed.includeVersions) {
        const versionLabel = parsed.versionAgent ? ` for ${parsed.versionAgent}` : '';
        console.log(chalk.bold(`Duplicate versions${versionLabel}`));
        await pruneDuplicates(parsed.versionAgent, options.yes === true, options.dryRun === true);
      }
    });
}
