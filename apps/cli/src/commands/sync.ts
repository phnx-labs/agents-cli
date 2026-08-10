/**
 * `agents sync` — synchronize central resources into an installed agent version.
 *
 * Forms:
 *   agents sync                                         # umbrella: fetch config repos -> reconcile all (secrets opt-in)
 *   agents sync --repos|--secrets                       # umbrella: fetch only those, then reconcile
 *   agents sync --cloud                                 # umbrella: fetch all, skip reconcile
 *   agents sync --local                                 # umbrella: reconcile all, no fetch
 *   agents sync system                                  # one repo: git pull --rebase (pull-only mirror)
 *   agents sync user                                    # one repo: git pull --rebase + push
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
import { resolveSyncPassphraseFromEnv } from '../lib/secrets/sync-passphrase.js';
import { agentLabel, resolveAgentName, MANAGED_AGENT_IDS, isAgentHardDeprecated, hardDeprecationError } from '../lib/agents.js';
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
  buildRepoScopedSelection,
  mergeRepoScopedSelections,
  listRepoNames,
  getVersionHomePath,
  type ResourceSelection,
  type SyncResult,
  type AvailableResources,
} from '../lib/versions.js';
import { capableAgents } from '../lib/capabilities.js';
import { parseHookManifest, registerHooksToSettings } from '../lib/hooks.js';
import { compileRulesForProject } from '../lib/rules/compile.js';
import { runLaunchSync } from '../lib/project-launch.js';
import { formatKeptProjectResources } from '../lib/project-resources.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { runUmbrellaSync, type UmbrellaFlags } from '../lib/sync-umbrella.js';
import { addHostOption } from '../lib/hosts/option.js';
import { syncRepoGit } from '../lib/git.js';
import { getSystemAgentsDir, getUserAgentsDir, getEnabledExtraRepos } from '../lib/state.js';

interface SyncOpts {
  agent?: string;
  agentVersion?: string;
  repo?: string;
  projectDir?: string;
  cwd?: string;
  launch?: boolean;
  yes?: boolean;
  force?: boolean;
  quiet?: boolean;
  /**
   * Machine-readable output. Also required by the fleet fan-out path
   * (`agents sync --host all`), which injects `--json` on every peer so the
   * roster can parse per-device results. Without this option registered,
   * remotes reject the flag with `unknown option '--json'` (RUSH-2216).
   */
  json?: boolean;
  // Umbrella-verb flags (only meaningful when no agent is given).
  repos?: boolean;
  secrets?: boolean;
  cloud?: boolean;
  local?: boolean;
}

/** Emit one JSON object to stdout for `--json` callers / fleet fan-out. */
function emitJson(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

/** Register the `agents sync` command. */
export function registerSyncCommand(program: Command): void {
  addHostOption(program.command('sync [agentSpec] [repo]'))
    .summary('Make this machine current, or sync resources into one agent')
    .description('With an [agentSpec], syncs resources (commands, skills, hooks, rules, MCPs, plugins, etc.) into that installed agent version — previews changes and lets you pick. e.g. "claude", "claude@2.1.142", a selector: @latest / @oldest / @pinned (= @default), or @all for every installed version.\n\nAppend a [repo] (or pass --repo) to scope the sync to a single DotAgent repo — system / user / project / <alias>. e.g. "agents sync claude@all system" reconciles only the system repo\'s resources into every installed Claude.\n\nGive a DotAgent repo name ALONE — "agents sync system" / "agents sync user" / "agents sync <alias>" — to git-sync that one repo: git pull --rebase against origin when the tree is clean; when it is dirty, fast-forward anyway if no incoming path is uncommitted, else refuse and name what collided. The user repo and extra aliases also push local commits up; the system repo is a pull-only mirror.\n\nWith NO agent, runs the umbrella verb: fetch the config repos then reconcile them into every installed agent. Secrets are opt-in — add --secrets to pull secret bundles. Session transcripts are queryable live via "agents sessions --host <machine>", or moved with "agents sessions export/import". Also: --cloud (fetch only), --local (reconcile only).')
    .option('--agent <agent>', 'Agent identifier (legacy form; prefer the positional spec)')
    .option('--agent-version <version>', 'Version to sync into (legacy form; prefer "agent@version")')
    .option('--repo <name>', 'Scope the sync to a single DotAgent repo: system / user / project / <alias> (also accepted as a positional)')
    .option('--project-dir <path>', 'Path to project-level .agents/ directory containing project-scoped resources')
    .option('--cwd <path>', 'Working directory for discovering project manifest and resources')
    .option('--launch', 'Hot-path mode (shim only): skip version-home reconciliation, run project-scoped compile + workspace mirror + plugin marketplaces', false)
    .option('-y, --yes', 'Skip the interactive preview and auto-sync all detected resources', false)
    .option('--force', 'Re-sync even if no changes are detected since the last sync', false)
    .option('--quiet', 'Suppress all output (exit code indicates success)', false)
    .option('--json', 'Emit machine-readable JSON (also accepted so fleet fan-out via --host all can parse each peer)', false)
    // Umbrella verb (no agent given): make this machine current.
    .option('--repos', 'Umbrella: git-pull ~/.agents + enabled ~/.agents-* extras', false)
    .option('--secrets', 'Umbrella: pull encrypted secret bundles from the remote', false)
    .option('--cloud', 'Umbrella: fetch all remote state but skip the local reconcile', false)
    .option('--local', "Umbrella: reconcile resources into installed agents only (no fetch)", false)
    .action(async (agentSpec: string | undefined, repo: string | undefined, opts: SyncOpts) => {
      await runSync(agentSpec, repo, opts);
    });
}

/**
 * Resolve a DotAgent repo name to its git working directory + whether local
 * commits should be pushed. `system` is a pull-only mirror of the npm-shipped
 * upstream; `user` and enabled extra aliases are user-owned and push. `project`
 * (and unknown names) return null — the project `.agents/` lives inside the
 * user's own project repo and is not independently git-synced here.
 */
function resolveRepoGitTarget(repo: string): { dir: string; push: boolean } | null {
  if (repo === 'system') return { dir: getSystemAgentsDir(), push: false };
  if (repo === 'user') return { dir: getUserAgentsDir(), push: true };
  const extra = getEnabledExtraRepos().find((e) => e.alias === repo);
  if (extra) return { dir: extra.dir, push: true };
  return null;
}

/**
 * `agents sync <repo>` — git-sync a single DotAgent repo: pull --rebase against
 * origin on a clean tree; on a dirty one, fast-forward anyway when no incoming
 * path is uncommitted, else refuse naming the collision. Pushes local commits
 * for user-owned repos. Delegates the git work to `syncRepoGit`.
 */
async function runRepoGitSync(
  repo: string,
  quiet: boolean,
  outLog: (msg: string) => void,
  errLog: (msg: string) => void,
  json = false,
): Promise<void> {
  const target = resolveRepoGitTarget(repo);
  if (!target) {
    if (json) {
      emitJson({
        ok: false,
        mode: 'repo-git',
        repo,
        error: `The '${repo}' repo isn't independently git-synced.`,
      });
    } else {
      errLog(chalk.red(`The '${repo}' repo isn't independently git-synced.`));
      errLog(chalk.gray('Syncable repos: system (pull-only), user, and enabled extra-repo aliases.'));
    }
    process.exitCode = 1;
    return;
  }

  if (!quiet && !json) outLog(chalk.bold(`Syncing ${repo} repo…`) + chalk.gray(` (${target.dir})`));
  const result = await syncRepoGit(target.dir, { push: target.push });

  if (!result.success) {
    if (json) {
      emitJson({ ok: false, mode: 'repo-git', repo, error: result.error ?? 'sync failed' });
    } else {
      errLog(chalk.red(`sync ${repo} failed: ${result.error}`));
    }
    process.exitCode = 1;
    return;
  }

  if (json) {
    emitJson({
      ok: true,
      mode: 'repo-git',
      repo,
      commit: result.commit,
      pushed: !!result.pushed,
    });
    return;
  }

  if (!quiet) {
    const note = result.pushed ? ' · pushed' : ' · pull-only';
    outLog(chalk.green(`✓ ${repo} → ${result.commit}${note}`));
  }
}

/** Human label for a repo choice in the interactive picker. */
function repoChoiceLabel(repo: string): string {
  switch (repo) {
    case 'system': return 'system  — shared, npm-shipped defaults';
    case 'user': return 'user    — your ~/.agents config';
    case 'project': return "project — this repo's .agents";
    default: return `${repo}  — extra repo`;
  }
}

/**
 * Interactive bare `agents sync` (TTY, no flags): two checklists — which
 * DotAgent repos to sync FROM, and which installed agents to sync INTO. Then
 * freshen the selected git-syncable repos (pull-only) and reconcile the chosen
 * repos' resources into each selected agent's default version, registering
 * hooks so synced hook scripts actually fire.
 */
async function runInteractiveReconcile(
  opts: SyncOpts,
  outLog: (msg: string) => void,
  errLog: (msg: string) => void,
): Promise<void> {
  const { checkbox } = await import('@inquirer/prompts');
  const cwd = opts.cwd || process.cwd();

  const installedAgents = MANAGED_AGENT_IDS.filter((a) => listInstalledVersions(a).length > 0);
  if (installedAgents.length === 0) {
    errLog(chalk.red('No agents installed. Install one: agents add claude@latest'));
    process.exitCode = 1;
    return;
  }

  let repos: string[];
  let agents: AgentId[];
  try {
    repos = await checkbox<string>({
      message: 'Sync resources FROM which repos?',
      choices: listRepoNames().map((r) => ({ value: r, name: repoChoiceLabel(r), checked: true })),
    });
    if (repos.length === 0) {
      outLog(chalk.gray('No repos selected. Nothing to do.'));
      return;
    }
    agents = await checkbox<AgentId>({
      message: 'Sync INTO which agents?',
      choices: installedAgents.map((a) => ({ value: a, name: agentLabel(a), checked: true })),
    });
    if (agents.length === 0) {
      outLog(chalk.gray('No agents selected. Nothing to do.'));
      return;
    }
  } catch (e) {
    if (isPromptCancelled(e)) {
      outLog(chalk.gray('Cancelled. No changes made.'));
      return;
    }
    throw e;
  }

  // 1. Freshen the selected git-syncable repos (pull-only; `project` has no
  //    independent remote). Failures are non-fatal — reconcile still runs.
  for (const repo of repos) {
    const target = resolveRepoGitTarget(repo);
    if (!target) continue;
    const res = await syncRepoGit(target.dir, { push: false });
    if (res.success) outLog(chalk.gray(`  pulled ${repo} → ${res.commit}`));
    else outLog(chalk.yellow(`  ! ${repo}: ${(res.error ?? 'pull failed').split('\n')[0]}`));
  }

  // 2. One selection spanning the chosen repos.
  const selection = mergeRepoScopedSelections(repos, cwd);
  const hasResources = selection.memory === 'all' || Object.entries(selection).some(
    ([kind, v]) => kind !== 'memory' && Array.isArray(v) && v.length > 0,
  );
  if (!hasResources) {
    outLog(chalk.gray(`Nothing from ${repos.join(', ')} to sync.`));
    return;
  }

  // 3. Reconcile into each selected agent's default (or sole) version, then
  //    register hooks so synced hook scripts fire.
  const hookManifest = parseHookManifest();
  const hookCapable = new Set(capableAgents('hooks'));
  for (const agentId of agents) {
    const version = resolveVersion(agentId, cwd) || listInstalledVersions(agentId).slice(-1)[0];
    if (!version) continue;
    const result = syncResourcesToVersion(agentId, version, selection, { cwd, prune: true });
    printSyncDetail(result, agentId, version, cwd);
    if (result.hooks && hookCapable.has(agentId) && Object.keys(hookManifest).length > 0) {
      registerHooksToSettings(agentId, getVersionHomePath(agentId, version), hookManifest);
    }
  }
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
  json = false,
): Promise<void> {
  // Interactive bare `agents sync` (a TTY, no --yes, no scope flag) drops into
  // the two-checklist picker: which repos to sync from, which agents to sync
  // into. Any explicit flag, --yes, or --json keeps the non-interactive path.
  // --json is a machine consumer (and the fleet fan-out injects it), so never
  // open a picker under it.
  const anyExplicitFlag = !!(opts.repos || opts.secrets || opts.cloud || opts.local);
  if (!quiet && !json && !opts.yes && !anyExplicitFlag && isInteractiveTerminal()) {
    await runInteractiveReconcile(opts, outLog, errLog);
    return;
  }

  const flags: UmbrellaFlags = {
    repos: opts.repos,
    secrets: opts.secrets,
    cloud: opts.cloud,
    local: opts.local,
  };
  // Same chokepoint as `agents secrets push/pull` — prefers AGENTS_SYNC_PASSPHRASE,
  // falls back to the deprecated master-key name with a single warning.
  const passphrase = resolveSyncPassphraseFromEnv().value ?? undefined;

  // Fleet fan-out only injects --json (not --yes). Treat --json as non-interactive
  // so refresh({ skipPrompts }) never tries to prompt over SSH.
  const yes = !!opts.yes || json;

  if (!quiet && !json) outLog(chalk.bold('Syncing this machine…'));
  try {
    const result = await runUmbrellaSync({
      flags,
      yes,
      passphrase,
      // quiet under --json so refresh() cannot pollute the JSON stdout the fleet parses.
      quiet: quiet || json,
      log: (msg) => { if (!quiet && !json) outLog(chalk.gray(`  ${msg}`)); },
    });

    if (json) {
      emitJson({
        ok: true,
        mode: 'umbrella',
        plan: result.plan,
        repos: result.repos,
        secrets: result.secrets,
        devices: result.devices,
        reconciled: result.reconciled,
      });
      return;
    }

    if (!quiet) {
      const parts: string[] = [];
      if (result.repos) {
        parts.push(`repos ${result.repos.pulled} pulled` +
          (result.repos.errors.length ? `, ${result.repos.errors.length} failed` : ''));
      }
      if (result.secrets) {
        parts.push(result.secrets.skipped ? 'secrets skipped' : `secrets ${result.secrets.pulled} pulled`);
      }
      if (result.reconciled) parts.push('reconciled');
      outLog(chalk.green(`✓ sync: ${parts.join(' · ') || 'nothing to do'}`));

      const errs = [...(result.repos?.errors ?? []), ...(result.secrets?.errors ?? [])];
      for (const e of errs) errLog(chalk.yellow(`  ! ${e}`));
    }
  } catch (err) {
    if (json) {
      emitJson({ ok: false, mode: 'umbrella', error: (err as Error).message });
    } else {
      errLog(chalk.red(`sync failed: ${(err as Error).message}`));
    }
    process.exitCode = 1;
  }
}

async function runSync(agentSpec: string | undefined, repoArg: string | undefined, opts: SyncOpts): Promise<void> {
  const json = !!opts.json;
  // --json is a machine consumer: suppress human stdout/stderr chatter so the
  // single JSON object on stdout stays parseable for fleet fan-out.
  const quiet = !!opts.quiet || json;
  const errLog = (msg: string) => { if (!quiet) console.error(msg); };
  const outLog = (msg: string) => { if (!quiet) console.log(msg); };
  // Failures under --json still need a structured line on stdout so fleet
  // fan-out's safeJsonParse gets a real object (not "unknown option").
  const failJson = (payload: Record<string, unknown>) => {
    if (json) emitJson({ ok: false, ...payload });
  };

  // ---------- 1. Resolve agent + version ----------
  let agentId: AgentId | undefined;
  let version: string | undefined;

  // A positional @selector typed by the user (latest/oldest/pinned/default/
  // all/explicit). parseAgentSpec defaults a missing version to 'latest', so a
  // bare `agents sync claude` and `agents sync claude@latest` are
  // indistinguishable after parsing — we only treat the version as a selector
  // when an '@' was actually typed, keeping bare `claude` on the
  // default-version path.
  let selector: string | undefined;

  // Repo-level git sync: a DotAgent repo name given ALONE (no agent, no second
  // positional) means "git-sync that repo" — pull --rebase, and push for
  // user-owned repos. This is distinct from the [repo] resource-scoping arg
  // below, and it precedes agent-spec parsing because repo names like
  // "system"/"user" would otherwise fail parseAgentSpec.
  if (agentSpec && !opts.agent && !repoArg && listRepoNames().includes(agentSpec)) {
    await runRepoGitSync(agentSpec, quiet, outLog, errLog, json);
    return;
  }

  if (agentSpec) {
    const parsed = parseAgentSpec(agentSpec);
    if (!parsed) {
      failJson({
        mode: 'agent',
        error: `Invalid agent spec '${agentSpec}'.`,
        hint: 'Examples: claude, claude@2.1.142, claude@latest, claude@oldest, claude@pinned, claude@all',
      });
      if (!json) {
        errLog(chalk.red(`Invalid agent spec '${agentSpec}'.`));
        errLog(chalk.gray('Examples: claude, claude@2.1.142, claude@latest, claude@oldest, claude@pinned, claude@all'));
      }
      process.exitCode = 1;
      return;
    }
    agentId = parsed.agent;
    if (agentSpec.includes('@')) selector = parsed.version;
  }

  // Repo scope: --repo flag wins over the positional. Validate against the
  // known DotAgent repos so a typo fails loudly instead of syncing nothing.
  const repoScope = opts.repo || repoArg;
  if (repoScope !== undefined) {
    const known = listRepoNames();
    if (!known.includes(repoScope)) {
      failJson({ mode: 'agent', error: `Unknown repo '${repoScope}'.`, known });
      if (!json) {
        errLog(chalk.red(`Unknown repo '${repoScope}'.`));
        errLog(chalk.gray(`Known repos: ${known.join(', ')}`));
      }
      process.exitCode = 1;
      return;
    }
  }

  if (opts.agent) {
    const resolved = resolveAgentName(opts.agent);
    if (!resolved) {
      failJson({ mode: 'agent', error: `Unknown agent '${opts.agent}'.` });
      if (!json) errLog(chalk.red(`Unknown agent '${opts.agent}'.`));
      process.exitCode = 1;
      return;
    }
    agentId = resolved;
  }
  if (agentId && isAgentHardDeprecated(agentId)) {
    failJson({ mode: 'agent', error: hardDeprecationError(agentId) });
    if (!json) errLog(chalk.red(hardDeprecationError(agentId)));
    process.exitCode = 1;
    return;
  }
  if (opts.agentVersion) {
    // Legacy flag and the launch-shim hot path (`--agent-version <concrete>`):
    // pass through verbatim. Selector aliases are a positional-spec feature.
    version = opts.agentVersion;
  }

  if (!agentId) {
    // No agent specified → the umbrella verb: make this machine current
    // (fetch repos + secrets + sessions, then reconcile all installed agents).
    // This is the path fleet fan-out (`--host all`) hits with injected --json.
    await runUmbrella(opts, quiet, outLog, errLog, json);
    return;
  }

  const projectDir = opts.projectDir;
  const cwd = opts.cwd || process.cwd();
  const force = !!opts.force;

  // ---------- 2a. @all: reconcile every installed version of this agent ----------
  // Non-interactive by design — fanning an interactive preview across N
  // versions is unusable. Honors an optional repo scope.
  if (selector === 'all') {
    const installed = listInstalledVersions(agentId);
    if (installed.length === 0) {
      failJson({ mode: 'agent-all', agent: agentId, error: `No ${agentLabel(agentId)} versions installed.` });
      if (!json) {
        errLog(chalk.red(`No ${agentLabel(agentId)} versions installed.`));
        errLog(chalk.gray(`Install one: agents add ${agentId}@latest`));
      }
      process.exitCode = 1;
      return;
    }
    let selection: ResourceSelection | undefined;
    if (repoScope) {
      selection = buildRepoScopedSelection(repoScope, cwd);
      if (Object.keys(selection).length === 0) {
        if (json) emitJson({ ok: true, mode: 'agent-all', agent: agentId, repo: repoScope, versions: [], note: 'nothing to sync' });
        else outLog(chalk.gray(`Nothing from repo '${repoScope}' to sync.`));
        return;
      }
    }
    const scopeLabel = repoScope ? chalk.gray(` (repo: ${repoScope})`) : '';
    if (!json) outLog(chalk.cyan(`Syncing ${installed.length} ${agentLabel(agentId)} version(s)${scopeLabel}.`));
    const versions: Array<{ version: string; result: SyncResult }> = [];
    for (const v of installed) {
      // A repo scope makes @all a full reconcile of that repo → prune resources
      // it no longer provides. Bare @all (no repo) leaves selection undefined
      // and falls through to the full-sync orphan sweep, so prune is a no-op
      // there (it requires a caller selection).
      const result = syncResourcesToVersion(agentId, v, selection, { projectDir, cwd, force, prune: !!repoScope });
      versions.push({ version: v, result });
      if (!quiet && !json) printSyncDetail(result, agentId, v, cwd);
    }
    if (json) {
      emitJson({
        ok: true,
        mode: 'agent-all',
        agent: agentId,
        repo: repoScope,
        versions: versions.map(({ version: v, result }) => ({
          version: v,
          commands: !!result.commands,
          skills: !!result.skills,
          hooks: !!result.hooks,
          memory: result.memory,
          mcp: result.mcp,
          permissions: !!result.permissions,
          subagents: result.subagents,
          plugins: result.plugins,
          workflows: result.workflows,
          pruned: result.pruned,
        })),
      });
    }
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
        failJson({ mode: 'agent', agent: agentId, error: `No ${agentLabel(agentId)} versions installed.` });
        if (!json) {
          errLog(chalk.red(`No ${agentLabel(agentId)} versions installed.`));
          errLog(chalk.gray(`Install one: agents add ${agentId}@latest`));
        }
        process.exitCode = 1;
        return;
      } else {
        failJson({
          mode: 'agent',
          agent: agentId,
          error: `No default ${agentLabel(agentId)} version pinned.`,
          installed,
        });
        if (!json) {
          errLog(chalk.red(`No default ${agentLabel(agentId)} version pinned. Specify one:`));
          for (const v of installed) {
            errLog(chalk.gray(`  agents sync ${agentId}@${v}`));
          }
        }
        process.exitCode = 1;
        return;
      }
    }
  }

  if (!isVersionInstalled(agentId, version)) {
    const installed = listInstalledVersions(agentId);
    failJson({
      mode: 'agent',
      agent: agentId,
      version,
      error: `${agentLabel(agentId)}@${version} is not installed.`,
      installed,
    });
    if (!json) {
      errLog(chalk.red(`${agentLabel(agentId)}@${version} is not installed.`));
      if (installed.length > 0) {
        errLog(chalk.gray(`Installed: ${installed.join(', ')}`));
      }
      errLog(chalk.gray(`Install it: agents add ${agentId}@${version}`));
    }
    process.exitCode = 1;
    return;
  }

  // ---------- 3. --launch mode bypasses everything below ----------
  if (opts.launch) {
    runLaunchMode(agentId, version, cwd, quiet, json);
    return;
  }

  // ---------- 3b. Repo-scoped single-version sync ----------
  // An explicit --repo / positional repo is a targeted request, so skip the
  // interactive preview and reconcile just that repo's resources.
  if (repoScope) {
    const scoped = buildRepoScopedSelection(repoScope, cwd);
    if (Object.keys(scoped).length === 0) {
      if (json) {
        emitJson({
          ok: true,
          mode: 'agent',
          agent: agentId,
          version,
          repo: repoScope,
          note: 'nothing to sync',
        });
      } else {
        outLog(chalk.gray(`Nothing from repo '${repoScope}' to sync into ${agentLabel(agentId)}@${version}.`));
      }
      return;
    }
    const result = syncResourcesToVersion(agentId, version, scoped, { projectDir, cwd, force, prune: true });
    if (json) {
      emitJson(agentSyncJson(agentId, version, result, repoScope));
    } else if (!quiet) {
      printSyncDetail(result, agentId, version, cwd);
    }
    return;
  }

  // ---------- 4. Decide selection (interactive preview vs auto) ----------
  // --json forces non-interactive (machine consumer / fleet fan-out).
  const yes = !!opts.yes || json;
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

  if (json) {
    emitJson({
      ...agentSyncJson(agentId, version, result),
      projectCompile: projectCompile
        ? {
            compiled: !!projectCompile.compiled,
            agentsPath: projectCompile.agentsPath,
            symlinks: projectCompile.symlinks,
            skippedClobber: projectCompile.skippedClobber,
          }
        : null,
    });
    return;
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

/** Stable `--json` payload for a single agent@version resource sync. */
function agentSyncJson(
  agent: AgentId,
  version: string,
  result: SyncResult,
  repo?: string,
): Record<string, unknown> {
  return {
    ok: true,
    mode: 'agent',
    agent,
    version,
    ...(repo !== undefined ? { repo } : {}),
    commands: !!result.commands,
    skills: !!result.skills,
    hooks: !!result.hooks,
    memory: result.memory,
    mcp: result.mcp,
    permissions: !!result.permissions,
    subagents: result.subagents,
    plugins: result.plugins,
    workflows: result.workflows,
    projectSkipped: result.projectSkipped,
    pruned: result.pruned,
  };
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

  const kept = formatKeptProjectResources(result.projectSkipped);

  // Removals from source-deleted resources (RUSH-2438). Rendered even when
  // nothing was added, so a reconcile that only pruned still reports it.
  const prunedLines = (Object.entries(result.pruned) as Array<[string, string[]]>)
    .filter(([, names]) => names.length > 0)
    .map(([kind, names]) => ({ kind, items: names }));

  if (lines.length === 0 && prunedLines.length === 0) {
    console.log(chalk.gray(`Already in sync — ${agentLabel(agent)}@${version}`));
    if (kept) console.log(chalk.gray(kept));
    return;
  }

  const PREVIEW = 5;
  const printKindLine = (label: string, items: string[], width: number, color: (s: string) => string) => {
    const padded = label.padEnd(width);
    const sorted = [...items].sort((a, b) => a.localeCompare(b));
    const preview = sorted.slice(0, PREVIEW).join(', ');
    const more = sorted.length > PREVIEW ? chalk.gray(`, +${sorted.length - PREVIEW} more`) : '';
    const count = color(`(${sorted.length})`.padStart(5));
    console.log(`  ${chalk.bold(padded)}  ${count}  ${chalk.gray(preview)}${more}`);
  };

  if (lines.length > 0) {
    console.log(chalk.green(`Synced to ${agentLabel(agent)}@${version}:`));
    const kindWidth = Math.max(...lines.map(l => l.kind.length));
    for (const { kind, items } of lines) printKindLine(kind, items, kindWidth, chalk.cyan);
  }

  if (prunedLines.length > 0) {
    console.log(chalk.yellow(`Pruned from ${agentLabel(agent)}@${version} (removed from source):`));
    const kindWidth = Math.max(...prunedLines.map(l => l.kind.length));
    for (const { kind, items } of prunedLines) printKindLine(kind, items, kindWidth, chalk.yellow);
  }

  if (kept) console.log(chalk.gray(kept));
}

function runLaunchMode(agent: AgentId, version: string, cwd: string, quiet: boolean, json = false): void {
  let result;
  try {
    result = runLaunchSync({ agent, version, cwd });
  } catch (err) {
    if (json) {
      emitJson({
        ok: false,
        mode: 'launch',
        agent,
        version,
        error: (err as Error).message,
      });
      process.exitCode = 1;
    } else if (!quiet) {
      console.error(chalk.yellow(`agents: launch sync skipped (${(err as Error).message})`));
    }
    return;
  }

  if (json) {
    emitJson({
      ok: true,
      mode: 'launch',
      agent,
      version,
      rulesCompiled: !!result.rulesCompiled,
      workspaceLinks: result.workspaceLinks,
      marketplaces: result.marketplaces,
      workspaceSkipped: result.workspaceSkipped,
    });
    return;
  }

  if (quiet) return;

  const bits: string[] = [];
  if (result.rulesCompiled) bits.push('rules');
  if (result.workspaceLinks > 0) bits.push(`${result.workspaceLinks} project resource(s)`);
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

  const kept = formatKeptProjectResources(result.workspaceSkipped);
  if (kept) console.log(chalk.gray(kept));
}
