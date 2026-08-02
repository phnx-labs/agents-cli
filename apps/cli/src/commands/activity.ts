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
 * Fleet-wide by opt-in: `--devices-all` (or `--host <box>`) fans the same
 * `activity --json` payload out across the fleet the way `agents feed` does,
 * merges every peer's stream host-tagged, and joins each item to live sessions
 * (project / ticket / execution host) so `--group-by project` shows, per
 * project, what each agent did, where, and for which ticket -- progress at a
 * glance. Local-only stays the default.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  collapseActivity,
  enrichActivityEvents,
  ensureActivityLogHook,
  filterActivityEvents,
  formatActivityGroupHeader,
  formatEnrichedActivityLine,
  formatProgressUpdate,
  groupActivity,
  mergeActivityEvents,
  parseActivityPayload,
  projectFromCwd,
  readRecentActivity,
  styleForEvent,
  tierForEvent,
  type ActivityGroupBy,
  type ActivitySessionHint,
  type EnrichedActivityEvent,
} from '../lib/activity.js';
import { gatherRemoteAgentsJson } from '../lib/remote-agents-json.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { shouldIncludeLocalFeed, remoteFeedHostsToDial } from './feed.js';
import { getActiveSessions } from '../lib/session/active.js';
import type { ActiveSession } from '../lib/session/active.js';

/** Recursion guard: a peer answering a fan-out never re-fans-out itself. */
export const ACTIVITY_NO_FANOUT_ENV = 'AGENTS_ACTIVITY_LOCAL';

const GROUP_BY_VALUES: ActivityGroupBy[] = ['project', 'device', 'agent'];

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
  filter?: string;
}

/** Wire the activity-log hooks into each hooks-capable version's settings. */
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
  for (const { agent, version } of iterHooksCapableVersions({ agent: 'claude' })) {
    const result = registerHooksToSettings(agent, getVersionHomePath(agent, version), manifest);
    if (result.errors.length > 0) warnings.push(`${agent}@${version}: ${result.errors.join('; ')}`);
  }
  return warnings;
}

/** Session facts (project / ticket / execution host) keyed for the read-time join. */
function activityHintsFromSessions(sessions: ActiveSession[]): ActivitySessionHint[] {
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    ticket: s.ticket?.id,
    // Where the process actually lives — the SSH-resolved provenance host, else
    // the cross-machine `machine` id. Normalized to match the event `host` form.
    executionHost: s.provenance?.host ? normalizeHost(s.provenance.host) : s.machine,
    project: projectFromCwd(s.cwd),
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

/** Print the bucketed view (`--group-by project|device|agent`). */
function renderGrouped(events: EnrichedActivityEvent[], by: ActivityGroupBy, opts: ActivityOpts): void {
  const groups = groupActivity(events, by);
  // The grouping dimension is redundant on each line -- drop it from the tags.
  const showHost = by !== 'device';
  const showProject = by !== 'project';
  process.stdout.write(chalk.bold(`\n  activity by ${by}\n`));
  for (const group of groups) {
    process.stdout.write(`\n  ${chalk.bold(formatActivityGroupHeader(group))}\n`);
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

export function registerActivityCommand(program: Command): void {
  program
    .command('activity')
    .description('Recent agent activity -- plans, PRs, worktrees, sub-agents (newest first)')
    .option('--json', 'Emit the (enriched) event list as JSON')
    .option('--all', 'Include routine activity (file edits) inline, not collapsed')
    .option('--milestones', 'Only milestone events (plans, PRs, worktrees, sub-agents)')
    .option('-n, --limit <n>', 'Cap the number of events shown', (v) => parseInt(v, 10), 40)
    .option('--since <minutes>', 'Only events within the last N minutes', (v) => parseInt(v, 10))
    .option('--local', 'Only this machine -- skip the cross-machine SSH fan-out')
    .option('-H, --host <target...>', 'Scope to remote machine(s) over SSH; repeatable')
    .option('--device <target...>', 'Alias for --host; repeatable')
    .option('--devices-all', 'Fan out to every reachable device on the fleet')
    .option('--hosts-all', 'Alias for --devices-all')
    .option('--group-by <field>', 'Bucket the stream by project | device | agent')
    .option('--filter <text>', 'Narrow to items matching a project / device / agent / event / ticket')
    .addHelpText('after', `
Examples:
  agents activity                              # this machine, newest first
  agents activity --devices-all --group-by project   # per project across the fleet
  agents activity --host yosemite-s1           # one box over SSH
  agents activity --devices-all --filter RUSH-2100   # one ticket, fleet-wide
  agents activity --milestones                 # only plans / PRs / worktrees / sub-agents

Each item is enriched by JOINING to live sessions (project, execution host,
Linear ticket) -- never by re-parsing transcripts. --devices-all runs the same
'activity --json' on each peer and merges the streams host-tagged.
`)
    .action(async (opts: ActivityOpts) => {
      if (opts.device?.length) opts.host = [...(opts.host ?? []), ...opts.device];
      const groupBy = opts.groupBy as ActivityGroupBy | undefined;
      if (groupBy && !GROUP_BY_VALUES.includes(groupBy)) {
        process.stderr.write(chalk.red(`--group-by must be one of: ${GROUP_BY_VALUES.join(', ')}\n`));
        process.exitCode = 1;
        return;
      }

      const self = machineId();
      const forceLocal = opts.local === true || process.env[ACTIVITY_NO_FANOUT_ENV] === '1';
      const explicitHosts = opts.host;
      const wantAll = Boolean(opts.devicesAll || opts.hostsAll);
      const wantRemote = !forceLocal && (wantAll || (explicitHosts != null && explicitHosts.length > 0));
      // Local events are included unless an explicit --host list excludes this box.
      let includeLocal = true;
      if (wantRemote && explicitHosts && explicitHosts.length > 0) {
        includeLocal = shouldIncludeLocalFeed(explicitHosts, self);
      }

      const warnings = includeLocal ? await installActivityHooks() : [];

      const sinceMs = typeof opts.since === 'number' && opts.since > 0
        ? Date.now() - opts.since * 60_000
        : undefined;

      let events: EnrichedActivityEvent[] = includeLocal
        ? readRecentActivity({ sinceMs, limit: opts.limit })
        : [];

      if (wantRemote) {
        // Explicit hosts drop self (it's the local read); --devices-all dials
        // every online peer (hosts undefined).
        const remoteHosts = explicitHosts?.length ? remoteFeedHostsToDial(explicitHosts, self) : undefined;
        if (!explicitHosts?.length || (remoteHosts && remoteHosts.length > 0)) {
          const remoteArgs = ['activity', '--json', '-n', String(opts.limit)];
          if (typeof opts.since === 'number' && opts.since > 0) remoteArgs.push('--since', String(opts.since));
          const remote = await gatherRemoteAgentsJson({
            args: remoteArgs,
            noFanoutEnv: ACTIVITY_NO_FANOUT_ENV,
            hosts: remoteHosts,
            parse: parseActivityPayload,
          });
          events = mergeActivityEvents(events, remote.items);
        }
      }

      // Enrich by joining to live LOCAL sessions (ticket/project/execution host).
      // Remote events arrive already enriched by their own peer, so the join only
      // fills local ones; the pure fallbacks (cwd->project, host->device) cover
      // everything either way. Skip the ps/lsof scan when there's nothing to show.
      const sessions = includeLocal && events.length > 0 ? await getActiveSessions() : [];
      let enriched = enrichActivityEvents(events, activityHintsFromSessions(sessions));

      if (opts.milestones) enriched = enriched.filter((e) => tierForEvent(e.event) === 'milestone');
      if (opts.filter) enriched = filterActivityEvents(enriched, opts.filter);
      enriched = enriched.slice(0, opts.limit);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(enriched, null, 2)}\n`);
        return;
      }

      for (const w of warnings) process.stderr.write(chalk.yellow(`  ! ${w}\n`));

      if (enriched.length === 0) {
        process.stdout.write(chalk.gray('No recent agent activity. Events appear here as agents create plans, open PRs, and spawn sub-agents.\n'));
        return;
      }

      if (groupBy) renderGrouped(enriched, groupBy, opts);
      else renderFlat(enriched, opts);
    });
}
