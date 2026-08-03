/**
 * `agents activity` -- the agent-activity lane: a running stream of what agents
 * DID (plan created, PR opened, worktree created, sub-agent spawned, files
 * edited), read from the append-only per-session activity logs.
 *
 * Complements `agents feed` (what agents are WAITING on). Events are emitted at
 * hook time by 11-activity-log.py, so this reader never re-parses transcripts --
 * it tails the logs and collapses routine work to counts, surfacing milestones
 * individually and newest-first.
 *
 * Fleet-wide and project-grouped BY DEFAULT: the question this command answers
 * is "what are my agents doing", and agents run on every box, so a local-only
 * flat stream answered a narrower question than anyone asked. Each run fans the
 * same `activity --json` payload out across the fleet the way `agents feed`
 * does, merges every peer's stream host-tagged, joins each item to live sessions
 * (project / ticket / execution host), and buckets it by project -- one level,
 * no sub-grouping, with the machines named in each project's header.
 *
 * `--local` scopes back to this machine, `--host <box>` to named peers, and
 * `--flat` (or `--group-by none`) restores the single newest-first stream.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  ACTIVITY_HOOK_DEFINITIONS,
  collapseActivity,
  enrichActivityEvents,
  capActivityEvents,
  ensureActivityLogHook,
  filterActivityByProject,
  filterActivityEvents,
  formatActivityGroupMeta,
  formatEnrichedActivityLine,
  formatProgressUpdate,
  groupActivity,
  mergeActivityEvents,
  parseActivityPayload,
  readRecentActivity,
  styleForEvent,
  tierForEvent,
  type ActivityGroupBy,
  type ActivitySessionHint,
  type EnrichedActivityEvent,
} from '../lib/activity.js';
import { gatherRemoteAgentsJson } from '../lib/remote-agents-json.js';
import { resolveProjectKey } from '../lib/project-key.js';
import { listProjectDefs, resolveProjectNameForCwd } from '../lib/projects.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { shouldIncludeLocalFeed, remoteFeedHostsToDial } from './feed.js';
import { getActiveSessions } from '../lib/session/active.js';
import type { ActiveSession } from '../lib/session/active.js';

/** Recursion guard: a peer answering a fan-out never re-fans-out itself. */
export const ACTIVITY_NO_FANOUT_ENV = 'AGENTS_ACTIVITY_LOCAL';

/** `--group-by` values; `none` is the opt-out that `--flat` also selects. */
const GROUP_BY_VALUES: ActivityGroupBy[] = ['project', 'device', 'agent'];
const GROUP_BY_NONE = 'none';

/** Grouping when neither `--group-by` nor `--flat` is given. */
const DEFAULT_GROUP_BY: ActivityGroupBy = 'project';

/**
 * How much further back than `--limit` the LOCAL log read goes, so routine
 * churn on this box can't crowd the fleet's milestones out of the window
 * ({@link capActivityEvents} does the real capping).
 */
const LOCAL_READ_HEADROOM = 5;

interface ActivityOpts {
  json?: boolean;
  all?: boolean;
  milestones?: boolean;
  limit: number;
  since?: number;
  local?: boolean;
  host?: string[];
  device?: string[];
  devicesAll?: boolean;
  hostsAll?: boolean;
  groupBy?: string;
  flat?: boolean;
  project?: string;
  filter?: string;
}

/**
 * Wire the activity-log hooks into each hooks-capable version's settings.
 *
 * Only a failure that leaves THIS command's log unwritten is worth a warning.
 * `registerHooksToSettings` reports every unresolved hook in the manifest — a
 * missing `inject-session-id` script, someone else's half-installed plugin —
 * and echoing all of them printed five wrapped lines of unrelated noise above
 * the timeline on every run. Those belong to `agents doctor`, which exists to
 * find them; here they are dropped. What still surfaces: an activity-hook
 * failure, and any error attributable to NO manifest hook — a corrupt
 * settings.json or an unwritable hooks file aborts registration for the whole
 * agent, which is exactly a failure that leaves the activity log unwritten.
 */
async function installActivityHooks(): Promise<string[]> {
  const warnings: string[] = [];
  const hookInstall = ensureActivityLogHook();
  if (hookInstall.error) {
    warnings.push(hookInstall.error);
    return warnings;
  }
  const [{ iterHooksCapableVersions, parseHookManifest, registerHooksToSettings }, { getVersionHomePath }] = await Promise.all([
    import('../lib/hooks.js'),
    import('../lib/versions.js'),
  ]);
  const manifest = parseHookManifest({ warn: false });
  const manifestNames = Object.keys(manifest);
  for (const { agent, version } of iterHooksCapableVersions({ agent: 'claude' })) {
    const result = registerHooksToSettings(agent, getVersionHomePath(agent, version), manifest);
    const ours = result.errors.filter(
      (e) => isActivityHookError(e) || !isManifestHookError(e, manifestNames),
    );
    if (ours.length > 0) warnings.push(`${agent}@${version}: ${ours.join('; ')}`);
  }
  return warnings;
}

/**
 * Does this hook-registration error concern one of the activity-log hooks?
 * `registerHooksToSettings` prefixes each error with the manifest hook name
 * (`<name>: script not found`), so the entry names are the discriminator.
 */
export function isActivityHookError(error: string): boolean {
  return Object.keys(ACTIVITY_HOOK_DEFINITIONS).some((name) => error.startsWith(`${name}:`));
}

/**
 * Is this error attributable to a named manifest hook at all? Errors that name
 * no hook — `Failed to parse settings.json`, `Failed to write
 * agents-cli-hooks.ts: …` — are agent-level aborts, not per-hook noise, and
 * must never be filtered out.
 */
export function isManifestHookError(error: string, manifestNames: string[]): boolean {
  return manifestNames.some((name) => error.startsWith(`${name}:`));
}

/**
 * Session facts (project / ticket / execution host) keyed for the read-time
 * join. These sessions are this machine's, so their cwds get the canonical
 * defined-project-first resolution rather than the bare cwd fold.
 */
function activityHintsFromSessions(
  sessions: ActiveSession[],
  resolveProject: (cwd?: string | null) => string | undefined = resolveProjectKey,
): ActivitySessionHint[] {
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    ticket: s.ticket?.id,
    // Where the process actually lives — the SSH-resolved provenance host, else
    // the cross-machine `machine` id. Normalized to match the event `host` form.
    executionHost: s.provenance?.host ? normalizeHost(s.provenance.host) : s.machine,
    project: resolveProject(s.cwd),
  }));
}

/**
 * Render one enriched event. Deliberate progress posts (`status.posted`) use the
 * rich multi-line {@link formatProgressUpdate} (joining the ticket the event's
 * session carries); every other milestone keeps the compact enriched line.
 */
function renderEnrichedEntry(
  ev: EnrichedActivityEvent,
  opts: { showHost?: boolean; showProject?: boolean; indent?: string } = {},
): string {
  if (ev.event === 'status.posted') {
    const body = formatProgressUpdate(ev, { joined: { ticketId: ev.ticket } });
    return opts.indent ? body.split('\n').map((l) => `${opts.indent}${l}`).join('\n') : body;
  }
  return formatEnrichedActivityLine(ev, opts);
}

/** Print one flat, newest-first stream (the default view). */
function renderFlat(events: EnrichedActivityEvent[], opts: ActivityOpts): void {
  const { milestones, counts, subagentCount } = collapseActivity(events);
  process.stdout.write(chalk.bold('\n  recent activity\n'));
  const shown = opts.all ? events : milestones;
  for (const ev of shown) {
    process.stdout.write(`${renderEnrichedEntry(ev, { showHost: true, showProject: true })}\n`);
  }
  if (!opts.all) {
    const parts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([event, n]) => `${styleForEvent(event).label} ×${n}`);
    if (parts.length > 0) process.stdout.write(chalk.gray(`\n  · ${parts.join('  ')}\n`));
  }
  if (subagentCount > 0) {
    process.stdout.write(chalk.magenta(`\n  ⑂ ${subagentCount} sub-agent${subagentCount === 1 ? '' : 's'} spawned\n`));
  }
  process.stdout.write('\n');
}

/** Max peers named in the unreachable note before the rest collapse to `+N`. */
const UNREACHABLE_NAME_LIMIT = 4;

/**
 * One compact trailing note for peers that didn't answer the fan-out. Now that
 * every run dials the fleet, an offline box is routine -- but never silent: the
 * reader has to know the timeline is missing a machine, not that the machine
 * was idle. Empty string when everything answered.
 */
export function formatUnreachableNote(skipped: string[]): string {
  if (skipped.length === 0) return '';
  const named = skipped.slice(0, UNREACHABLE_NAME_LIMIT);
  const rest = skipped.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', ');
  const noun = skipped.length === 1 ? 'device' : 'devices';
  return chalk.gray(`  · ${skipped.length} ${noun} unreachable: ${list}\n\n`);
}

/** Print the bucketed view (`--group-by project|device|agent`). */
function renderGrouped(events: EnrichedActivityEvent[], by: ActivityGroupBy, opts: ActivityOpts): void {
  const groups = groupActivity(events, by);
  // The grouping dimension is redundant on each line -- drop it from the tags.
  const showHost = by !== 'device';
  const showProject = by !== 'project';
  process.stdout.write(chalk.bold(`\n  activity by ${by}\n`));
  for (const group of groups) {
    // `▸ <label>  <meta>` -- label leads in cyan so projects scan down the
    // left edge (mirrors the `agents sessions` overview), the counts and the
    // machines that touched this project trail behind it in gray.
    const meta = formatActivityGroupMeta(group, { showDevices: by !== 'device' });
    process.stdout.write(`\n  ${chalk.cyan('▸')} ${chalk.cyan.bold(group.label)}  ${chalk.gray(meta)}\n`);
    const { milestones, counts, subagentCount } = collapseActivity(group.events);
    const shown = opts.all ? group.events : milestones;
    for (const ev of shown) {
      process.stdout.write(`${renderEnrichedEntry(ev, { showHost, showProject, indent: '  ' })}\n`);
    }
    if (!opts.all) {
      const parts = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([event, n]) => `${styleForEvent(event).label} ×${n}`);
      if (parts.length > 0) process.stdout.write(chalk.gray(`    · ${parts.join('  ')}\n`));
    }
    if (subagentCount > 0) {
      process.stdout.write(chalk.magenta(`    ⑂ ${subagentCount} sub-agent${subagentCount === 1 ? '' : 's'} spawned\n`));
    }
  }
  process.stdout.write('\n');
}

/**
 * Resolve `--group-by` / `--flat` into the grouping dimension, or `undefined`
 * for a flat stream. Throws on an unknown value so the caller can exit 1 --
 * a mistyped dimension must not silently fall back to the default.
 */
export function resolveActivityGrouping(opts: Pick<ActivityOpts, 'groupBy' | 'flat'>): ActivityGroupBy | undefined {
  if (opts.flat) return undefined;
  if (opts.groupBy === undefined) return DEFAULT_GROUP_BY;
  if (opts.groupBy === GROUP_BY_NONE) return undefined;
  if (!GROUP_BY_VALUES.includes(opts.groupBy as ActivityGroupBy)) {
    throw new Error(`--group-by must be one of: ${[...GROUP_BY_VALUES, GROUP_BY_NONE].join(', ')}`);
  }
  return opts.groupBy as ActivityGroupBy;
}

/** Which machines an invocation reads from. Pure -- no SSH, no device registry. */
export interface ActivityScope {
  /** Read this box's own activity logs. */
  includeLocal: boolean;
  /** Dial peers over SSH. */
  wantRemote: boolean;
  /** Peers to dial; `undefined` means "every reachable device". */
  remoteHosts?: string[];
}

/**
 * Decide the read scope. Fleet-wide is the DEFAULT -- agents run on every box,
 * so "what are my agents doing" is a fleet question -- and three things narrow
 * it: `--local`, an explicit `--host`/`--device` list, and the recursion guard
 * a peer answering a fan-out carries (else every peer would re-fan the fleet).
 * `--devices-all`/`--hosts-all` are kept as explicit no-ops for scripts that
 * already pass them.
 */
export function resolveActivityScope(
  opts: Pick<ActivityOpts, 'local' | 'host'>,
  self: string,
  noFanoutEnv = process.env[ACTIVITY_NO_FANOUT_ENV] === '1',
): ActivityScope {
  if (opts.local === true || noFanoutEnv) return { includeLocal: true, wantRemote: false };
  const explicitHosts = opts.host;
  if (explicitHosts && explicitHosts.length > 0) {
    const remoteHosts = remoteFeedHostsToDial(explicitHosts, self) ?? [];
    return {
      includeLocal: shouldIncludeLocalFeed(explicitHosts, self),
      wantRemote: remoteHosts.length > 0,
      remoteHosts,
    };
  }
  return { includeLocal: true, wantRemote: true };
}

export function registerActivityCommand(program: Command): void {
  program
    .command('activity')
    .description('Recent agent activity across the fleet -- plans, PRs, worktrees, sub-agents, by project')
    .option('--json', 'Emit the (enriched) event list as JSON')
    .option('--all', 'Include routine activity (file edits) inline, not collapsed')
    .option('--milestones', 'Only milestone events (plans, PRs, worktrees, sub-agents)')
    .option('-n, --limit <n>', 'Cap the milestones shown (routine work rides along as counts); with --all, caps every event', (v) => parseInt(v, 10), 40)
    .option('--since <minutes>', 'Only events within the last N minutes', (v) => parseInt(v, 10))
    .option('--local', 'Only this machine -- skip the cross-machine SSH fan-out')
    .option('-H, --host <target...>', 'Scope to remote machine(s) over SSH; repeatable')
    .option('--device <target...>', 'Alias for --host; repeatable')
    .option('--devices-all', 'Fan out to every reachable device (the default; kept for scripts)')
    .option('--hosts-all', 'Alias for --devices-all')
    .option('--group-by <field>', 'Bucket the stream by project | device | agent | none (default: project)')
    .option('--flat', 'One newest-first stream instead of project buckets')
    .option('--project <name>', 'Only items under one project; exact match on the resolved (defined-project-first) label')
    .option('--filter <text>', 'Narrow to items matching a project / device / agent / event / ticket')
    .addHelpText('after', `
Examples:
  agents activity                              # the whole fleet, by project
  agents activity --local                      # just this machine
  agents activity --flat                       # one newest-first stream
  agents activity --host yosemite-s1           # one box over SSH
  agents activity --project rush               # one defined project, fleet-wide
  agents activity --filter RUSH-2100           # one ticket, fleet-wide
  agents activity --group-by device            # by machine instead of project

Fleet-wide and project-grouped by default: the same 'activity --json' runs on
every reachable peer and the streams merge host-tagged. Each item is enriched by
JOINING to live sessions (project, execution host, Linear ticket) -- never by
re-parsing transcripts. Project labels are canonical: a cwd inside a defined
project (~/.agents/projects/<name>.yaml) reads as that project's name, so a
multi-repo project is one bucket; anything else folds to its repository. Each
project header names the machines its work ran on.
`)
    .action(async (opts: ActivityOpts) => {
      if (opts.device?.length) opts.host = [...(opts.host ?? []), ...opts.device];
      let groupBy: ActivityGroupBy | undefined;
      try {
        groupBy = resolveActivityGrouping(opts);
      } catch (err) {
        process.stderr.write(chalk.red(`${(err as Error).message}\n`));
        process.exitCode = 1;
        return;
      }
      // `parseInt` yields NaN for a non-numeric -n, and every downstream slice
      // against NaN is empty — an unreadable flag would otherwise render as
      // "No recent agent activity", which is a lie about the fleet.
      if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
        process.stderr.write(chalk.red('--limit must be a positive number\n'));
        process.exitCode = 1;
        return;
      }

      const self = machineId();
      const { includeLocal, wantRemote, remoteHosts } = resolveActivityScope(opts, self);

      const warnings = includeLocal ? await installActivityHooks() : [];

      const sinceMs = typeof opts.since === 'number' && opts.since > 0
        ? Date.now() - opts.since * 60_000
        : undefined;

      // Each peer contributes its own newest `-n` window, so the merged pool is
      // already several times the cap. The local read is the one source that
      // would otherwise be capped twice, and reading further back costs nothing
      // (the files are tailed either way) — so it gets the headroom.
      let events: EnrichedActivityEvent[] = includeLocal
        ? readRecentActivity({ sinceMs, limit: opts.limit * LOCAL_READ_HEADROOM })
        : [];

      // Peers that were dialed but never answered, reported once at the end
      // rather than as a line each above the timeline.
      let unreachable: string[] = [];
      if (wantRemote) {
        const remoteArgs = ['activity', '--json', '-n', String(opts.limit)];
        if (typeof opts.since === 'number' && opts.since > 0) remoteArgs.push('--since', String(opts.since));
        const remote = await gatherRemoteAgentsJson({
          args: remoteArgs,
          noFanoutEnv: ACTIVITY_NO_FANOUT_ENV,
          hosts: remoteHosts?.length ? remoteHosts : undefined,
          parse: parseActivityPayload,
          quiet: true,
        });
        events = mergeActivityEvents(events, remote.items);
        unreachable = remote.skipped;
      }

      // Enrich by joining to live LOCAL sessions (ticket/project/execution host).
      // Remote events arrive already enriched by their own peer, so the join only
      // fills local ones; the pure fallbacks (cwd->project, host->device) cover
      // everything either way. Skip the ps/lsof scan when there's nothing to show.
      // Project labels are canonical: a defined project's name wins over the
      // repo-level key, so a multi-repo project buckets as one.
      const projectDefs = listProjectDefs();
      const resolveProject = (cwd?: string | null) => resolveProjectNameForCwd(cwd, projectDefs);
      const sessions = includeLocal && events.length > 0 ? await getActiveSessions() : [];
      let enriched = enrichActivityEvents(events, activityHintsFromSessions(sessions, resolveProject), resolveProject);

      if (opts.milestones) enriched = enriched.filter((e) => tierForEvent(e.event) === 'milestone');
      if (opts.project) enriched = filterActivityByProject(enriched, opts.project);
      if (opts.filter) enriched = filterActivityEvents(enriched, opts.filter);
      enriched = capActivityEvents(enriched, opts.limit, { all: opts.all || opts.milestones });

      if (opts.json) {
        // stdout stays clean JSON, but an unanswered peer is never a silent drop.
        if (unreachable.length > 0) process.stderr.write(formatUnreachableNote(unreachable));
        process.stdout.write(`${JSON.stringify(enriched, null, 2)}\n`);
        return;
      }

      for (const w of warnings) process.stderr.write(chalk.yellow(`  ! ${w}\n`));

      if (enriched.length === 0) {
        process.stdout.write(chalk.gray('No recent agent activity. Events appear here as agents create plans, open PRs, and spawn sub-agents.\n'));
        process.stdout.write(formatUnreachableNote(unreachable));
        return;
      }

      if (groupBy) renderGrouped(enriched, groupBy, opts);
      else renderFlat(enriched, opts);
      process.stdout.write(formatUnreachableNote(unreachable));
    });
}
