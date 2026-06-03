/**
 * Shared utilities for command implementations.
 *
 * Small helpers used across multiple commands: prompt cancellation detection,
 * table formatting, spinner management, and platform-specific workarounds.
 */

import * as os from 'os';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import { AGENTS, agentLabel, resolveAgentName } from '../lib/agents.js';
import {
  installVersion,
  listInstalledVersions,
  resolveAgentVersionTargets,
  resolveInstalledAgentTargets,
  VersionNotInstalledError,
  type InstalledAgentTargetResult,
  type VersionSelectionResult,
} from '../lib/versions.js';

/**
 * Check if an error is from user cancelling a prompt (Ctrl+C)
 */
export function isPromptCancelled(err: unknown): boolean {
  return err instanceof Error && (
    err.name === 'ExitPromptError' ||
    err.message.includes('force closed') ||
    err.message.includes('User force closed')
  );
}

/**
 * True when stdin/stdout are attached to a real terminal.
 */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Exit with a clean message when a picker would be required in a non-interactive shell.
 */
export function requireInteractiveSelection(action: string, alternatives: string[]): never {
  console.error(chalk.red(`${action} requires an interactive terminal.`));
  if (alternatives.length > 0) {
    console.error(chalk.gray('Run one of these non-interactive forms instead:'));
    for (const alternative of alternatives) {
      console.error(chalk.cyan(`  ${alternative}`));
    }
  }
  process.exit(1);
}

/**
 * Print a properly-cased "missing argument" error for destructive commands and
 * exit. Destructive commands (remove, disband, disable) deliberately do NOT
 * fall back to an interactive picker — typing the name is the safety check.
 *
 * Lists available items so the user can copy-paste, but never auto-selects.
 */
export function requireDestructiveArg(opts: {
  argName: string;       // e.g. 'team', 'name', 'agent'
  command: string;       // e.g. 'agents teams disband'
  itemNoun: string;      // e.g. 'team', 'plugin' — used for grammar
  available: string[];   // names to list
  emptyHint?: string;    // shown when no items exist
}): never {
  const { argName, command, itemNoun, available, emptyHint } = opts;
  console.error(chalk.red(`Missing required argument: ${argName.toUpperCase()}`));
  console.error('');
  if (available.length === 0) {
    console.error(chalk.gray(emptyHint || `No ${itemNoun}s to choose from.`));
  } else {
    const label = available.length === 1 ? itemNoun : `${itemNoun}s`;
    console.error(chalk.gray(`Available ${label}:`));
    for (const name of available) {
      console.error(`  ${chalk.cyan(name)}`);
    }
    console.error('');
    console.error(chalk.gray(`Re-run with the ${itemNoun} you want:`));
    console.error(chalk.cyan(`  ${command} ${available[0]}`));
  }
  console.error('');
  console.error(
    chalk.gray(`Tip: this is a destructive command, so you have to type the ${itemNoun} name explicitly.`)
  );
  process.exit(2);
}

/**
 * Print long content directly in non-interactive shells, use a pager only for real terminals.
 */
export function printWithPager(output: string, lineCount: number): void {
  if (!isInteractiveTerminal() || lineCount <= 40) {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return;
  }

  const less = spawnSync('less', ['-R'], {
    input: output,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (less.status !== 0) {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  }
}

/**
 * Parse a comma-separated CLI list, trimming whitespace and dropping empties.
 */
export function parseCommaSeparatedList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * A target for resource removal: agent + version.
 */
export interface RemovalTarget {
  agent: string;
  version: string;
  label: string;
}

/**
 * Prompt user to select which agent/version targets to remove a resource from.
 * If only one target, returns it without prompting. If multiple, shows checkbox.
 * Returns empty array if user cancels or selects nothing.
 */
export async function promptRemovalTargets(
  resourceName: string,
  targets: RemovalTarget[],
  options?: { skipPrompt?: boolean }
): Promise<RemovalTarget[]> {
  if (targets.length === 0) return [];
  if (targets.length === 1 || options?.skipPrompt) return targets;

  if (!isInteractiveTerminal()) {
    return targets;
  }

  const { checkbox } = await import('@inquirer/prompts');

  try {
    const selected = await checkbox({
      message: `Select targets to remove '${resourceName}' from`,
      choices: targets.map((t) => ({
        value: t,
        name: t.label,
        checked: true,
      })),
    });
    return selected;
  } catch (err) {
    if (isPromptCancelled(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Format a path for display, using ~ for home directory
 */
export function formatPath(fullPath: string, cwd?: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  const currentDir = cwd || process.cwd();
  if (fullPath.startsWith(currentDir + '/')) {
    return fullPath.slice(currentDir.length + 1);
  }
  return fullPath;
}

/**
 * Parse a --agents selector and collect every (agentId, specificVersion) pair
 * the user requested where the version is a concrete x.y.z (not `default`,
 * not `all`, not `latest`) and is NOT currently installed.
 *
 * This is the lookahead the auto-install wrappers use to decide whether to
 * prompt + install before delegating to resolveAgentVersionTargets.
 */
function collectMissingVersions(
  value: string,
  availableAgents: readonly AgentId[]
): Array<{ agentId: AgentId; version: string }> {
  const missing: Array<{ agentId: AgentId; version: string }> = [];
  const seen = new Set<string>();

  for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    // Literal `all` / `all@all` expand to per-agent — never missing.
    if (raw === 'all' || raw === 'all@all') continue;

    const atIndex = raw.indexOf('@');
    if (atIndex === -1) continue; // bare agent → resolves to default; never missing in this sense

    const agentToken = raw.slice(0, atIndex).trim();
    const versionToken = raw.slice(atIndex + 1).trim();

    // Non-specific selectors handled by the underlying resolver.
    if (!versionToken || versionToken === 'default' || versionToken === 'all') continue;

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !availableAgents.includes(agentId)) continue;

    const installed = listInstalledVersions(agentId);
    if (installed.includes(versionToken)) continue;

    const key = `${agentId}@${versionToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push({ agentId, version: versionToken });
  }

  return missing;
}

/**
 * Sequentially install every requested missing version with a per-version
 * spinner. Aborts via process.exit(1) on the first failure — the user
 * already approved the install so a partial-install outcome is worse than
 * a hard stop.
 */
async function installMissingVersions(
  missing: ReadonlyArray<{ agentId: AgentId; version: string }>
): Promise<void> {
  for (const { agentId, version } of missing) {
    const label = `${agentLabel(agentId)}@${version}`;
    const spinner = ora(`Installing ${label}...`).start();
    try {
      const result = await installVersion(agentId, version, (msg) => {
        spinner.text = msg;
      });
      if (!result.success) {
        spinner.fail(`Failed to install ${label}: ${result.error ?? 'unknown error'}`);
        process.exit(1);
      }
      spinner.succeed(`Installed ${label}`);
    } catch (err) {
      spinner.fail(`Failed to install ${label}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

/**
 * Make sure every specific `agent@x.y.z` the user typed is installed before
 * the caller resolves targets. Returns true if the caller should continue,
 * false if the user declined the prompt. Exported so non-standard caller
 * shapes (e.g. mcp.ts's manifest-shaped parser) can run the pre-flight
 * without going through resolveAgentVersionTargets first.
 */
export async function ensureAgentVersionsInstalled(
  value: string,
  availableAgents: readonly AgentId[],
  options: { yes?: boolean } = {}
): Promise<boolean> {
  const missing = collectMissingVersions(value, availableAgents);
  if (missing.length === 0) return true;

  const summary = missing.map((m) => `${agentLabel(m.agentId)}@${m.version}`).join(', ');

  if (!options.yes) {
    if (!isInteractiveTerminal()) {
      console.error(chalk.red(`Missing agent version(s): ${summary}`));
      console.error(chalk.gray('In a scripted shell, opt in to auto-install:'));
      console.error(chalk.cyan(`  rerun with --yes`));
      console.error(chalk.gray('Or pre-install:'));
      for (const m of missing) {
        console.error(chalk.cyan(`  agents add ${m.agentId}@${m.version}`));
      }
      process.exit(1);
    }

    console.log(chalk.yellow(`\nThe following agent version(s) are not installed:`));
    for (const m of missing) {
      console.log(`  ${chalk.cyan(`${agentLabel(m.agentId)}@${m.version}`)}`);
    }

    let proceed: boolean;
    try {
      proceed = await confirm({
        message: `Install ${missing.length} missing version${missing.length === 1 ? '' : 's'}?`,
        default: true,
      });
    } catch (err) {
      if (isPromptCancelled(err)) return false;
      throw err;
    }
    if (!proceed) return false;
  }

  await installMissingVersions(missing);
  return true;
}

/**
 * Resolve a `--agents` selector and, if any requested `agent@version` isn't
 * installed yet, prompt to install it (or auto-install with --yes) before
 * delegating to resolveAgentVersionTargets. Returns null when the user
 * declines the install prompt — callers should treat that as a clean cancel.
 */
export async function resolveAgentTargetsAutoInstalling(
  value: string,
  availableAgents: readonly AgentId[],
  options: { yes?: boolean; allVersions?: boolean } = {}
): Promise<VersionSelectionResult | null> {
  const ok = await ensureAgentVersionsInstalled(value, availableAgents, options);
  if (!ok) return null;
  return resolveAgentVersionTargets(value, availableAgents, { allVersions: options.allVersions });
}

/**
 * Same as resolveAgentTargetsAutoInstalling but returns the broader
 * InstalledAgentTargetResult that includes `directAgents` (for paths like
 * `agents install` and `mcp register` that fall through to unmanaged homes
 * when no managed version is installed).
 */
export async function resolveInstalledAgentTargetsAutoInstalling(
  value: string,
  availableAgents: readonly AgentId[],
  options: { yes?: boolean; allVersions?: boolean } = {}
): Promise<InstalledAgentTargetResult | null> {
  const ok = await ensureAgentVersionsInstalled(value, availableAgents, options);
  if (!ok) return null;
  return resolveInstalledAgentTargets(value, availableAgents, { allVersions: options.allVersions });
}

// Re-export so callers can `catch (err) { if (err instanceof VersionNotInstalledError) … }`
// without reaching into ../lib/versions directly.
export { VersionNotInstalledError } from '../lib/versions.js';
