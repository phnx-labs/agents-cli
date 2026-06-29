/**
 * `agents sync` — synchronize central resources into an installed agent version.
 *
 * Forms:
 *   agents sync                                         # umbrella: fetch remote (repos+secrets+sessions) -> reconcile all
 *   agents sync --repos|--secrets|--sessions            # umbrella: fetch only those, then reconcile
 *   agents sync --cloud                                 # umbrella: fetch all, skip reconcile
 *   agents sync --local                                 # umbrella: reconcile all, no fetch
 *   agents sync claude                                  # one agent: uses default/sole installed version
 *   agents sync claude@2.1.142                          # one agent: explicit version
 *   agents sync claude@latest                           # one agent: newest installed
 *   agents sync claude@oldest                           # one agent: oldest installed
 *   agents sync claude@pinned   (= claude@default)      # one agent: the pinned default version
 *   agents sync --agent claude --agent-version 2.1.142  # legacy form, still supported
 *
 * The umbrella stages live in lib/sync-umbrella.ts; this file dispatches to them
 * when no agent is given.
 *
 * In a TTY the command previews available/new resources and lets the user
 * select what to sync (same prompts shown after `agents add`). Pass
 * --yes for non-interactive auto-sync, --force to re-sync when nothing
 * has changed, --quiet for total silence.
 *
 * Hot path:
 *   --launch is the shim entry point. It skips version-home reconciliation
 *   and runs only the cheap project-scoped work (rules compile, workspace
 *   resource mirror, per-scope plugin marketplaces). Filesystem-only,
 *   sub-50ms steady state. Keep changes here surgical.
 */

import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { agentLabel, resolveAgentName } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  isVersionInstalled,
  syncResourcesToVersion,
  parseAgentSpec,
  resolveVersion,
  resolveVersionAlias,
  listInstalledVersions,
  getAvailableResources,
  getActuallySyncedResources,
  getProjectOnlyResources,
  getNewResources,
  hasNewResources,
  promptResourceSelection,
  promptNewResourceSelection,
  type ResourceSelection,
  type SyncResult,
  type AvailableResources,
} from '../lib/versions.js';
import { compileRulesForProject } from '../lib/rules/compile.js';
import { runLaunchSync } from '../lib/project-launch.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { runUmbrellaSync, type UmbrellaFlags } from '../lib/sync-umbrella.js';

interface SyncOpts {
  agent?: string;
  agentVersion?: string;
  projectDir?: string;
  cwd?: string;
  launch?: boolean;
  yes?: boolean;
  force?: boolean;
  quiet?: boolean;
  // Umbrella-verb flags (only meaningful when no agent is given).
  repos?: boolean;
  secrets?: boolean;
  sessions?: boolean;
  cloud?: boolean;
  local?: boolean;
}

/** Register the `agents sync` command. */
export function registerSyncCommand(program: Command): void {
  program
    .command('sync [agentSpec]')
    .summary('Make this machine current, or sync resources into one agent')
    .description('With an [agentSpec], syncs resources (commands, skills, hooks, rules, MCPs, plugins, etc.) into that installed agent version — previews changes and lets you pick. e.g. "claude", "claude@2.1.142", or a selector: @latest / @oldest / @pinned (= @default).\n\nWith NO agent, runs the umbrella verb: fetch remote state (config repos + secrets + sessions) then reconcile it into every installed agent. Scope it with --repos / --secrets / --sessions, --cloud (fetch only), or --local (reconcile only).')
    .option('--agent <agent>', 'Agent identifier (legacy form; prefer the positional spec)')
    .option('--agent-version <version>', 'Version to sync into (legacy form; prefer "agent@version")')
    .option('--project-dir <path>', 'Path to project-level .agents/ directory containing project-scoped resources')
    .option('--cwd <path>', 'Working directory for discovering project manifest and resources')
    .option('--launch', 'Hot-path mode (shim only): skip version-home reconciliation, run project-scoped compile + workspace mirror + plugin marketplaces', false)
    .option('-y, --yes', 'Skip the interactive preview and auto-sync all detected resources', false)
    .option('--force', 'Re-sync even if no changes are detected since the last sync', false)
    .option('--quiet', 'Suppress all output (exit code indicates success)', false)
    // Umbrella verb (no agent given): make this machine current.
    .option('--repos', 'Umbrella: git-pull ~/.agents + enabled ~/.agents-* extras', false)
    .option('--secrets', 'Umbrella: pull encrypted secret bundles from the remote', false)
    .option('--sessions', 'Umbrella: sync session transcripts across machines', false)
    .option('--cloud', 'Umbrella: fetch all remote state but skip the local reconcile', false)
    .option('--local', "Umbrella: reconcile resources into installed agents only (no fetch)", false)
    .action(async (agentSpec: string | undefined, opts: SyncOpts) => {
      await runSync(agentSpec, opts);
    });
}

/**
 * The umbrella verb: bare `agents sync` (no agent) makes this machine current.
 * Resolves the flags + a secrets passphrase (env-only for now; tokenized auth
 * arrives with `agents login`) and runs the fetch+reconcile stages, then prints
 * a one-line summary. Stage failures are non-fatal and surfaced as warnings.
 */
async function runUmbrella(
  opts: SyncOpts,
  quiet: boolean,
  outLog: (msg: string) => void,
  errLog: (msg: string) => void,
): Promise<void> {
  const flags: UmbrellaFlags = {
    repos: opts.repos,
    secrets: opts.secrets,
    sessions: opts.sessions,
    cloud: opts.cloud,
    local: opts.local,
  };
  const passphrase = process.env.AGENTS_SECRETS_PASSPHRASE || undefined;

  if (!quiet) outLog(chalk.bold('Syncing this machine…'));
  try {
    const result = await runUmbrellaSync({
      flags,
      yes: !!opts.yes,
      passphrase,
      log: (msg) => { if (!quiet) outLog(chalk.gray(`  ${msg}`)); },
    });

    if (!quiet) {
      const parts: string[] = [];
      if (result.repos) {
        parts.push(`repos ${result.repos.pulled} pulled` +
          (result.repos.errors.length ? `, ${result.repos.errors.length} failed` : ''));
      }
      if (result.secrets) {
        parts.push(result.secrets.skipped ? 'secrets skipped' : `secrets ${result.secrets.pulled} pulled`);
      }
      if (result.sessions) {
        parts.push(result.sessions.ran ? `sessions ${result.sessions.merged} merged` : 'sessions off');
      }
      if (result.reconciled) parts.push('reconciled');
      outLog(chalk.green(`✓ sync: ${parts.join(' · ') || 'nothing to do'}`));

      const errs = [...(result.repos?.errors ?? []), ...(result.secrets?.errors ?? [])];
      for (const e of errs) errLog(chalk.yellow(`  ! ${e}`));
    }
  } catch (err) {
    errLog(chalk.red(`sync failed: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

async function runSync(agentSpec: string | undefined, opts: SyncOpts): Promise<void> {
  const quiet = !!opts.quiet;
  const errLog = (msg: string) => { if (!quiet) console.error(msg); };
  const outLog = (msg: string) => { if (!quiet) console.log(msg); };

  // ---------- 1. Resolve agent + version ----------
  let agentId: AgentId | undefined;
  let version: string | undefined;

  // A positional @selector typed by the user (latest/oldest/pinned/default/
  // explicit). parseAgentSpec defaults a missing version to 'latest', so a bare
  // `agents sync claude` and `agents sync claude@latest` are indistinguishable
  // after parsing — we only treat the version as a selector when an '@' was
  // actually typed, keeping bare `claude` on the default-version path.
  let selector: string | undefined;

  if (agentSpec) {
    const parsed = parseAgentSpec(agentSpec);
    if (!parsed) {
      errLog(chalk.red(`Invalid agent spec '${agentSpec}'.`));
      errLog(chalk.gray('Examples: claude, claude@2.1.142, claude@latest, claude@oldest, claude@pinned'));
      process.exitCode = 1;
      return;
    }
    agentId = parsed.agent;
    if (agentSpec.includes('@')) selector = parsed.version;
  }

  if (opts.agent) {
    const resolved = resolveAgentName(opts.agent);
    if (!resolved) {
      errLog(chalk.red(`Unknown agent '${opts.agent}'.`));
      process.exitCode = 1;
      return;
    }
    agentId = resolved;
  }
  if (opts.agentVersion) {
    // Legacy flag and the launch-shim hot path (`--agent-version <concrete>`):
    // pass through verbatim. Selector aliases are a positional-spec feature.
    version = opts.agentVersion;
  }

  if (!agentId) {
    // No agent specified → the umbrella verb: make this machine current
    // (fetch repos + secrets + sessions, then reconcile all installed agents).
    await runUmbrella(opts, quiet, outLog, errLog);
    return;
  }

  // ---------- 2. Resolve version (project pin → global default → sole installed) ----------
  // A positional @selector wins over the default-resolution below.
  //   @latest / @oldest        → newest / oldest installed (process.exit if none)
  //   @pinned / @default       → undefined → fall through to the default path
  //   @x.y.z                   → that version (process.exit if not installed)
  if (selector !== undefined && !version) {
    version = resolveVersionAlias(agentId, selector);
  }

  if (!version) {
    version = resolveVersion(agentId, process.cwd()) || undefined;
    if (!version) {
      const installed = listInstalledVersions(agentId);
      if (installed.length === 1) {
        version = installed[0];
      } else if (installed.length === 0) {
        errLog(chalk.red(`No ${agentLabel(agentId)} versions installed.`));
        errLog(chalk.gray(`Install one: agents add ${agentId}@latest`));
        process.exitCode = 1;
        return;
      } else {
        errLog(chalk.red(`No default ${agentLabel(agentId)} version pinned. Specify one:`));
        for (const v of installed) {
          errLog(chalk.gray(`  agents sync ${agentId}@${v}`));
        }
        process.exitCode = 1;
        return;
      }
    }
  }

  if (!isVersionInstalled(agentId, version)) {
    errLog(chalk.red(`${agentLabel(agentId)}@${version} is not installed.`));
    const installed = listInstalledVersions(agentId);
    if (installed.length > 0) {
      errLog(chalk.gray(`Installed: ${installed.join(', ')}`));
    }
    errLog(chalk.gray(`Install it: agents add ${agentId}@${version}`));
    process.exitCode = 1;
    return;
  }

  const projectDir = opts.projectDir;
  const cwd = opts.cwd || process.cwd();

  // ---------- 3. --launch mode bypasses everything below ----------
  if (opts.launch) {
    runLaunchMode(agentId, version, cwd, quiet);
    return;
  }

  // ---------- 4. Decide selection (interactive preview vs auto) ----------
  const force = !!opts.force;
  const yes = !!opts.yes;
  const interactive = !quiet && !yes && isInteractiveTerminal();

  let selection: ResourceSelection | undefined;

  if (interactive) {
    const available = getAvailableResources(cwd);
    const actuallySynced = getActuallySyncedResources(agentId, version, { cwd });
    const projectOnly = getProjectOnlyResources(cwd);
    const newResources = getNewResources(available, actuallySynced, projectOnly);
    const hasAnySynced = anyResources(actuallySynced);

    try {
      if (!hasAnySynced) {
        outLog(chalk.cyan(`Syncing to ${agentLabel(agentId)}@${version}.`));
        const userSelection = await promptResourceSelection(agentId);
        if (!userSelection || Object.keys(userSelection).length === 0) {
          outLog(chalk.gray('Nothing selected. No changes made.'));
          return;
        }
        selection = userSelection;
      } else if (hasNewResources(newResources, agentId, version)) {
        const userSelection = await promptNewResourceSelection(agentId, newResources, version);
        if (!userSelection || Object.keys(userSelection).length === 0) {
          outLog(chalk.gray('Nothing selected. No changes made.'));
          return;
        }
        selection = userSelection;
      } else if (!force) {
        outLog(chalk.gray(`${agentLabel(agentId)}@${version} is already in sync.`));
        outLog(chalk.gray('Run with --force to re-sync, or --yes to bypass this check.'));
        return;
      }
      // else: --force on a fully-synced version → selection stays undefined,
      // syncResourcesToVersion falls through to its pattern-based full sync.
    } catch (e) {
      if (isPromptCancelled(e)) {
        outLog(chalk.gray('Cancelled. No changes made.'));
        return;
      }
      throw e;
    }
  }

  // ---------- 5. Run sync ----------
  const result = syncResourcesToVersion(agentId, version, selection, { projectDir, cwd, force });

  // Compile project-scope rules into the workspace itself so each agent's
  // native loader picks up cwd/<INSTRUCTIONS_FILE>. projectDir is the
  // .agents/ directory; the workspace root is its parent.
  let projectCompile: ReturnType<typeof compileRulesForProject> | null = null;
  if (projectDir) {
    const projectRoot = path.dirname(projectDir);
    projectCompile = compileRulesForProject(projectRoot);
  }

  if (quiet) return;

  // ---------- 6. Detailed output ----------
  printSyncDetail(result, agentId, version, cwd);

  if (projectCompile?.compiled) {
    const linkInfo = projectCompile.symlinks.length > 0
      ? ` (+ ${projectCompile.symlinks.join(', ')})`
      : '';
    console.log(chalk.gray(`Compiled project rules → ${projectCompile.agentsPath}${linkInfo}`));
  }
  if (projectCompile && projectCompile.skippedClobber.length > 0) {
    console.log(chalk.yellow(
      `Skipped (user-authored, not overwritten): ${projectCompile.skippedClobber.join(', ')}`,
    ));
  }
}

function anyResources(r: AvailableResources): boolean {
  return r.commands.length + r.skills.length + r.hooks.length + r.memory.length +
    r.mcp.length + r.permissions.length + r.subagents.length +
    r.plugins.length + r.workflows.length > 0;
}

/** Format the post-sync detail output: per-kind count + a name preview. */
function printSyncDetail(result: SyncResult, agent: AgentId, version: string, cwd: string): void {
  // Booleans in SyncResult (commands, skills, hooks, permissions) carry no
  // name list. Re-derive ground truth from the version home so the user
  // sees what's actually present after the sync.
  const synced = getActuallySyncedResources(agent, version, { cwd });

  type Line = { kind: string; items: string[] };
  const lines: Line[] = [];
  if (result.commands)              lines.push({ kind: 'commands',    items: synced.commands });
  if (result.skills)                lines.push({ kind: 'skills',      items: synced.skills });
  if (result.hooks)                 lines.push({ kind: 'hooks',       items: synced.hooks });
  if (result.memory.length > 0)     lines.push({ kind: 'memory',      items: result.memory });
  if (result.permissions)           lines.push({ kind: 'permissions', items: synced.permissions });
  if (result.mcp.length > 0)        lines.push({ kind: 'mcp',         items: result.mcp });
  if (result.subagents.length > 0)  lines.push({ kind: 'subagents',   items: result.subagents });
  if (result.plugins.length > 0)    lines.push({ kind: 'plugins',     items: result.plugins });
  if (result.workflows.length > 0)  lines.push({ kind: 'workflows',   items: result.workflows });

  if (lines.length === 0) {
    console.log(chalk.gray(`Already in sync — ${agentLabel(agent)}@${version}`));
    return;
  }

  console.log(chalk.green(`Synced to ${agentLabel(agent)}@${version}:`));
  const kindWidth = Math.max(...lines.map(l => l.kind.length));
  const PREVIEW = 5;
  for (const { kind, items } of lines) {
    const padded = kind.padEnd(kindWidth);
    const sorted = [...items].sort((a, b) => a.localeCompare(b));
    const preview = sorted.slice(0, PREVIEW).join(', ');
    const more = sorted.length > PREVIEW ? chalk.gray(`, +${sorted.length - PREVIEW} more`) : '';
    const count = chalk.cyan(`(${sorted.length})`.padStart(5));
    console.log(`  ${chalk.bold(padded)}  ${count}  ${chalk.gray(preview)}${more}`);
  }
}

function runLaunchMode(agent: AgentId, version: string, cwd: string, quiet: boolean): void {
  let result;
  try {
    result = runLaunchSync({ agent, version, cwd });
  } catch (err) {
    if (!quiet) {
      console.error(chalk.yellow(`agents: launch sync skipped (${(err as Error).message})`));
    }
    return;
  }

  if (quiet) return;

  const bits: string[] = [];
  if (result.rulesCompiled) bits.push('rules');
  if (result.workspaceLinks > 0) bits.push(`${result.workspaceLinks} workspace link(s)`);
  const mpCount = Object.keys(result.marketplaces).length;
  if (mpCount > 0) {
    const pluginCount = Object.values(result.marketplaces).reduce((acc, names) => acc + names.length, 0);
    bits.push(`${pluginCount} plugin(s) across ${mpCount} marketplace(s)`);
  }

  if (bits.length === 0) {
    console.log(chalk.gray('No project resources to compile'));
  } else {
    console.log(chalk.green(`Launch sync: ${bits.join(', ')}`));
  }

  if (result.workspaceSkipped.length > 0) {
    console.log(chalk.yellow(
      `Skipped (user-owned, not overwritten): ${result.workspaceSkipped.join(', ')}`,
    ));
  }
}
