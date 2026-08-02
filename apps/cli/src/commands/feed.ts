/**
 * `agents feed` -- operator inbox + agent status posts.
 *
 * Default (`agents feed`): list open blocks (decisions agents are waiting on).
 * Aggregates block records from the local feed store and, with --host, from
 * reachable remote hosts via SSH passthrough. Each block carries enough
 * identity for `agents message` to route a reply back to the right agent.
 *
 * Default view groups by **outcome** (ticket / PR / worktree / Unassigned) so
 * an operator sees dozens of deliverables, not ~1,100 agents. Pass `--flat`
 * for the legacy per-agent list.
 *
 * `agents feed post`: agent-callable free-text progress into the activity
 * stream (milestone `status.posted`). Session/agent/host/runtime/pid identity
 * is auto-stamped from env + the pid registry — no domain-specific flags.
 * Humans watch via the feed activity lane / `agents activity`.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { ensureFeedPublishHook, listAskStats, listBlocks, recordNotified, type OpenBlock } from '../lib/feed.js';
import {
  ensureActivityLogHook,
  readRecentActivity,
  formatActivityLine,
  formatProgressUpdate,
  mergeActivityEvents,
  parseActivityPayload,
  type ActivityEvent,
  type EnrichedActivityEvent,
} from '../lib/activity.js';
import { postFeedStatus } from '../lib/feed-post.js';
import {
  enrichBlocksFromSessions,
  groupBlocksByOutcome,
  isUnambiguousOutcomeAnswer,
  openBlocksForOutcome,
  stampBlockOutcomes,
  type OutcomeGroup,
  type SessionOutcomeHint,
} from '../lib/feed-outcome.js';
import {
  classifyBlock,
  filterBlocksForFeed,
  suppressionDigest,
} from '../lib/ask-classifier.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { relTime } from '../lib/format.js';
import { gatherRemoteAgentsJson } from '../lib/remote-agents-json.js';
import { loadPolicy, applyPolicyToBlock, isPhoneUrgent } from '../lib/feed-policy.js';
import { notifyUrgentBlock } from '../lib/notify.js';
import { gcMailbox } from '../lib/mailbox-gc.js';
import { isValidMailboxId } from '../lib/mailbox.js';
import { getActiveSessions } from '../lib/session/active.js';
import { mailboxIdForActiveSession } from '../lib/mailbox-target.js';
import { GLYPH, masthead } from '../lib/comms-render.js';
import { discoverSessions } from '../lib/session/discover.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import {
  buildSessionSignals,
  rankFeedBlocks,
  synthesizeControlCards,
  type FeedSessionSignal,
} from '../lib/feed-ranking.js';

export const FEED_NO_FANOUT_ENV = 'AGENTS_FEED_LOCAL';

/** Right-hand masthead summary: `N blocks · M agents`. */
export function formatFeedMastheadRight(blocks: OpenBlock[]): string {
  const agents = new Set(blocks.map((b) => b.mailboxId)).size;
  return `${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${agents} agent${agents === 1 ? '' : 's'}`;
}

/** Reply hint matching the shared fleet-comms reply line. */
export function formatFeedReplyHint(mailboxId: string): string {
  return `↳ ag message ${mailboxId} "…"`;
}

export function parseRemoteFeed(stdout: string, machine: string): OpenBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const blocks: OpenBlock[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const block = item as Partial<OpenBlock>;
    if (!block.blockId || !block.sessionId || !block.mailboxId || !block.questions?.length) continue;
    // A crafted mailboxId (path separators, `.`/`..`) would throw inside
    // mailboxDir() when policy runs against the block, aborting the whole
    // dispatch loop — drop it here so a malicious peer can't smuggle one in.
    if (!isValidMailboxId(block.mailboxId)) continue;
    blocks.push({ ...block, host: machine } as OpenBlock);
  }
  return blocks;
}

/** Merge local and remote rows, keeping the first copy of a host/session block. */
export function mergeFeedBlocks(...groups: OpenBlock[][]): OpenBlock[] {
  const byIdentity = new Map<string, OpenBlock>();
  for (const block of groups.flat()) {
    const key = `${normalizeHost(block.host)}:${block.blockId}`;
    if (!byIdentity.has(key)) byIdentity.set(key, block);
  }
  return [...byIdentity.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

export type FeedControlAction = 'pause' | 'kill';

function matchesControlTarget(signal: FeedSessionSignal, target: string): boolean {
  return [
    signal.mailboxId,
    signal.sessionId,
    signal.cloudTaskId,
    signal.pid !== undefined ? String(signal.pid) : undefined,
  ].some((value) => value === target);
}

export async function controlFeedSession(
  action: FeedControlAction,
  target: string,
  signals: FeedSessionSignal[],
): Promise<string> {
  const signal = signals.find((s) => matchesControlTarget(s, target));
  if (!signal) throw new Error(`No live feed session matches '${target}'.`);

  if (signal.cloudProvider && signal.cloudTaskId) {
    const provider = resolveProvider(signal.cloudProvider);
    await provider.cancel(signal.cloudTaskId);
    return `${action === 'pause' ? 'paused' : 'killed'} cloud task ${signal.cloudTaskId}`;
  }

  if (!signal.pid) {
    throw new Error(`Session '${target}' has no local pid or cancellable cloud task.`);
  }

  if (action === 'pause') {
    if (process.platform === 'win32') {
      throw new Error('Pause is not supported for local Windows processes; use --kill.');
    }
    process.kill(signal.pid, 'SIGSTOP');
    return `paused pid ${signal.pid}`;
  }

  process.kill(signal.pid, 'SIGTERM');
  return `killed pid ${signal.pid}`;
}

function hostToken(host: string): string {
  return normalizeHost(host.split('@').pop() || host);
}

export function shouldIncludeLocalFeed(hosts: string[] | undefined, self: string): boolean {
  return !hosts?.length || hosts.some((host) => hostToken(host) === self);
}

export function remoteFeedHostsToDial(hosts: string[] | undefined, self: string): string[] | undefined {
  if (!hosts?.length) return undefined;
  return hosts.filter((host) => hostToken(host) !== self);
}

export function prepareLocalFeedBlocks(
  localBlocks: OpenBlock[],
  opts: { includeLocal: boolean; all?: boolean; dispatch?: boolean },
): { visible: OpenBlock[]; dispatch: OpenBlock[]; filter: ReturnType<typeof filterBlocksForFeed> } {
  const filter = filterBlocksForFeed(localBlocks, {
    apply: opts.includeLocal && (!opts.all || opts.dispatch === true),
  });
  return {
    visible: opts.all ? localBlocks : filter.surfaced,
    dispatch: filter.surfaced,
    filter,
  };
}

function renderBlock(b: OpenBlock, localHost: string, indent = ''): void {
  const host = b.host !== localHost ? chalk.yellow(` [${b.host}]`) : '';
  const runtime = chalk.gray(b.runtime);
  const age = chalk.gray(relTime(b.ts));
  const cls = b.blockClass ? chalk.gray(`(${b.blockClass})`) : '';
  const consequence = b.consequence && b.consequence !== 'normal' ? chalk.red(`[${b.consequence}]`) : '';
  const cost = b.costOfDelay ? chalk.gray(`cost:${b.costOfDelay}`) : '';
  const rank = b.delayRank ? chalk.gray(`rank:${Math.round(b.delayRank.score)}`) : '';
  // Shared fleet-comms glyphs: ▲ open ask, ✓ answered (see comms-render GLYPH).
  const marker = b.answer
    ? chalk.green(GLYPH.delivered)
    : b.kind === 'control'
      ? chalk.red('!')
    : !b.parkedAt
      ? chalk.yellow(GLYPH.ask)
      : ' ';
  console.log(`${indent}${marker} ${chalk.cyan(b.mailboxId)}${host}  ${runtime}  ${age}  ${cls} ${consequence} ${cost} ${rank}`.trimEnd());
  for (const question of b.questions) {
    const header = question.header ? chalk.gray(`[${question.header}] `) : '';
    console.log(`${indent}  ${header}${question.text}`);
    if (question.options?.length) {
      for (let i = 0; i < question.options.length; i++) {
        const o = question.options[i];
        const desc = o.description ? chalk.gray(` -- ${o.description}`) : '';
        console.log(`${indent}    ${chalk.dim(`${i + 1}.`)} ${o.label}${desc}`);
      }
    }
  }
  if (b.ticket || b.pr || b.worktreeSlug) {
    const meta = [b.ticket, b.pr, b.worktreeSlug].filter(Boolean).join('  ');
    console.log(`${indent}  ${chalk.gray(meta)}`);
  }

  if (b.answer) {
    const verified = b.answer.verified ? chalk.green(GLYPH.delivered) : chalk.yellow('?');
    const who = b.answer.answeredFrom + (b.answer.answeredBy ? ` (${b.answer.answeredBy})` : '');
    console.log(`${indent}  ${chalk.green('answered')} by ${who} ${verified}`);
  }
  if (b.parkedAt) {
    console.log(`${indent}  ${chalk.red('hard-parked')} ${relTime(b.parkedAt)}`);
  }
  if (b.defaultedAt) {
    console.log(`${indent}  ${chalk.yellow('defaulted')} ${relTime(b.defaultedAt)}`);
  }
  if (b.receipts && b.receipts.length > 0) {
    const latest = b.receipts[b.receipts.length - 1];
    console.log(`${indent}  ${chalk.dim('delivery:')} ${latest.status}`);
  }
  if (b.continuedAt) {
    console.log(`${indent}  ${chalk.green('continued')} ${relTime(b.continuedAt)}`);
  }
  if (b.notifiedAt) {
    console.log(`${indent}  ${chalk.dim('notified')} ${relTime(b.notifiedAt)}`);
  }
  if (b.runaway) {
    console.log(`${indent}  ${chalk.red('runaway:')} ${b.runaway.reason}`);
    console.log(`${indent}  ${chalk.dim(`control: ag feed --pause ${b.mailboxId}  ·  ag feed --kill ${b.mailboxId}`)}`);
  }
  if (b.needy) {
    console.log(`${indent}  ${chalk.yellow('needy:')} ${b.needy.askCountLastHour}/${b.needy.threshold} asks in the last hour`);
    console.log(`${indent}  ${chalk.dim(`inspect: ag sessions ${b.sessionId}`)}`);
  }

  if (!b.answer && !b.parkedAt && b.kind !== 'control') {
    console.log(`${indent}  ${chalk.dim(formatFeedReplyHint(b.mailboxId))}`);
  }
  console.log();
}

/** Human summary line for one outcome rollup. */
export function formatOutcomeHeader(group: OutcomeGroup): string {
  const { agents, open, answered, parked } = group.counts;
  const parts = [
    `${agents} agent${agents === 1 ? '' : 's'}`,
    open > 0 ? `${open} needs you` : null,
    answered > 0 ? `${answered} answered` : null,
    parked > 0 ? `${parked} parked` : null,
  ].filter(Boolean);
  return `${group.outcome.label} · ${parts.join(' · ')}`;
}

function renderOutcomeGroup(group: OutcomeGroup, localHost: string): void {
  console.log(chalk.bold(formatOutcomeHeader(group)));
  if (isUnambiguousOutcomeAnswer(group) && openBlocksForOutcome(group).length > 1) {
    const ids = openBlocksForOutcome(group).map((b) => b.mailboxId).join(', ');
    console.log(chalk.dim(`  same question on ${openBlocksForOutcome(group).length} agents — fan-out safe: ${ids}`));
  }
  for (const b of group.blocks) {
    renderBlock(b, localHost, '  ');
  }
}

/** Map active sessions into the lightweight hints outcome enrichment needs. */
export function sessionHintsFromActive(
  sessions: Array<{
    sessionId?: string;
    agentId?: string;
    ticket?: { id?: string };
    pr?: { url?: string; number?: number };
    worktree?: { slug?: string };
  }>,
): SessionOutcomeHint[] {
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    agentId: s.agentId,
    // Same precedence as mailboxIdForActiveSession (agentId ?? sessionId).
    mailboxId: s.agentId ?? s.sessionId,
    ticketId: s.ticket?.id,
    prNumber: s.pr?.number,
    prUrl: s.pr?.url,
    worktreeSlug: s.worktree?.slug,
  }));
}

export function registerFeedCommand(program: Command): void {
  const feed = program
    .command('feed')
    .description('Open blocks (needs you) + agent status posts (feed post)')
    .option('--json', 'Output as JSON (each block stamped with its outcome + ask class)')
    .option('--filter <view>', 'What to show: needs (default) · updates · all', 'needs')
    .option('--flat', 'List one block per agent instead of grouping by outcome')
    .option('--all', 'Include stalls/FYIs that policy would suppress (default: hide them)')
    .option('--local', 'Only this machine -- skip the cross-machine SSH fan-out')
    .option('-H, --host <target...>', 'Scope to remote machine(s) over SSH; repeatable')
    .option('--device <target...>', 'Alias for --host; repeatable')
    .option('--dispatch', 'Run stall suppression + default-on-no-answer policy and urgent notifications')
    .option('--pause <id>', 'Pause a runaway/needy local process (SIGSTOP) or cancel a cloud task')
    .option('--kill <id>', 'Kill a runaway/needy local process (SIGTERM) or cancel a cloud task');

  feed
    .command('post')
    .description('Post a status update to the fleet activity stream (for agents)')
    .argument('<text...>', 'What just happened — one short human line')
    .option('--session <id>', 'Session id escape hatch (default: auto from env / pid registry)')
    .option('--attach <path-or-url...>', 'Attach an artifact (local file or URL); repeatable')
    .option('--json', 'Emit the written event as JSON')
    .addHelpText('after', `
Examples:
  # Inside an agents-cli run (session identity is already in the env):
  agents feed post "CHANGELOG pushed; watching CI and mac-mini E2E"
  agents feed post "cover render ready" --attach ./out/cover.png
  agents feed post "ready for review" --json

  # Outside a run, pass the session explicitly:
  agents feed post "manual note" --session 00998b0e-2d15-4d2f-a58b-974a886c9b47

Identity (session, agent, host, runtime, pid, launchId) is stamped automatically.
Domain facts (tickets, PRs) are not CLI flags — join them on the session at read time.
`)
    .action((
      textParts: string[],
      opts: { session?: string; attach?: string[]; json?: boolean },
      cmd?: { opts: () => { session?: string; attach?: string[]; json?: boolean }; parent?: { opts: () => { json?: boolean } } },
    ) => {
      // Parent `feed` also declares `--json` (for the list view). Commander
      // binds the flag on the parent, so a `feed post … --json` lands on
      // parent.opts().json — not the child. Read both.
      const flags = {
        session: opts?.session ?? cmd?.opts?.()?.session,
        attach: opts?.attach ?? cmd?.opts?.()?.attach,
        json: Boolean(opts?.json ?? cmd?.opts?.()?.json ?? cmd?.parent?.opts?.()?.json),
      };
      try {
        const { event } = postFeedStatus({
          text: Array.isArray(textParts) ? textParts.join(' ') : String(textParts ?? ''),
          sessionId: flags.session,
          attach: flags.attach,
        });
        if (flags.json) {
          console.log(JSON.stringify(event, null, 2));
          return;
        }
        console.log(formatProgressUpdate(event));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  feed.action(async (opts: {
      json?: boolean;
      filter?: string;
      flat?: boolean;
      all?: boolean;
      local?: boolean;
      host?: string[];
      device?: string[];
      dispatch?: boolean;
      pause?: string;
      kill?: string;
    }) => {
      if (opts.device?.length) opts.host = [...(opts.host ?? []), ...opts.device];
      const self = machineId();
      const filter = resolveFeedFilter(opts.filter);
      const includeLocal = shouldIncludeLocalFeed(opts.host, self);
      const setupWarnings: string[] = [];
      if (includeLocal) {
        // Feed and activity hooks are independent -- install both, and register
        // the manifest as long as at least one wrote its entries (don't couple
        // activity registration to the feed hook succeeding).
        const hookInstall = ensureFeedPublishHook();
        const activityInstall = ensureActivityLogHook();
        if (hookInstall.error) setupWarnings.push(hookInstall.error);
        if (activityInstall.error) setupWarnings.push(activityInstall.error);
        if (!hookInstall.error || !activityInstall.error) {
          const [{ iterHooksCapableVersions, parseHookManifest, registerHooksToSettings }, { getVersionHomePath }] = await Promise.all([
            import('../lib/hooks.js'),
            import('../lib/versions.js'),
          ]);
          const manifest = parseHookManifest({ warn: false });
          for (const { agent, version } of iterHooksCapableVersions({ agent: 'claude' })) {
            const result = registerHooksToSettings(agent, getVersionHomePath(agent, version), manifest);
            if (result.errors.length > 0) {
              setupWarnings.push(`${agent}@${version}: ${result.errors.join('; ')}`);
            }
          }
        }
      }

      // Trailing lane under the block views: `--filter all` appends the same
      // fleet-wide updates section, anything else the compact local lane.
      const renderTrailingActivity = async (): Promise<void> => {
        if (filter === 'all') {
          console.log();
          renderUpdatesView(await gatherStatusPosts({
            limit: UPDATES_VIEW_LIMIT, hosts: opts.host, local: opts.local, includeLocal, self,
          }));
          return;
        }
        if (includeLocal) renderActivityLane();
      };

      // Updates view: deliberate progress posts only (blocks are decisions, not
      // announcements). Short-circuits the block pipeline — no dispatch policy —
      // but fans out like the block view, because a post lands on whichever box
      // ran the agent.
      if (filter === 'updates') {
        for (const warning of setupWarnings) {
          console.error(chalk.yellow(`Feed hook setup warning: ${warning}`));
        }
        const updates = await gatherStatusPosts({
          limit: opts.json ? UPDATES_JSON_LIMIT : UPDATES_VIEW_LIMIT,
          hosts: opts.host,
          local: opts.local,
          includeLocal,
          self,
        });
        if (opts.json) {
          console.log(JSON.stringify(updates, null, 2));
          return;
        }
        renderUpdatesView(updates);
        return;
      }

      // Active sessions feed both the GC sweep and outcome enrichment (ticket/PR).
      let sessions: Awaited<ReturnType<typeof getActiveSessions>> = [];
      if (includeLocal) {
        sessions = await getActiveSessions();
      }
      const sessionMetas = includeLocal && sessions.length > 0 ? await discoverSessions({ all: true, limit: 5000 }) : [];
      const localSignals = buildSessionSignals(sessions, sessionMetas);

      if (opts.pause || opts.kill) {
        if (!includeLocal) {
          throw new Error('Feed controls run on the local machine. Re-run against the target host with --local.');
        }
        const action = opts.pause ? 'pause' : 'kill';
        const target = opts.pause ?? opts.kill ?? '';
        console.log(await controlFeedSession(action, target, localSignals));
        return;
      }

      if (opts.dispatch && includeLocal) {
        // Liveness sweep: drop messages to dead agents and retire stale blocks
        // before we render the feed.
        const activeBoxIds = new Set(sessions.map(mailboxIdForActiveSession).filter((id): id is string => !!id));
        const gcResult = gcMailbox(activeBoxIds);
        if (gcResult.blocksRemoved > 0 || gcResult.messagesDroppedDead > 0) {
          console.log(
            chalk.yellow(`gc: ${gcResult.messagesDroppedDead} dead messages, ${gcResult.blocksRemoved} stale blocks removed`),
          );
        }
      }

      let localBlocks = includeLocal
        ? [...listBlocks(), ...synthesizeControlCards(localSignals, listAskStats())]
        : [];

      // Fill missing ticket/PR/worktree from live session meta before local
      // policy mutates the store, so outcome keys land even when the publish
      // hook had no deliverable stamp.
      if (sessions.length > 0) {
        localBlocks = enrichBlocksFromSessions(localBlocks, sessionHintsFromActive(sessions));
      }

      // Stall suppression (RUSH-1477) must only mutate blocks owned by this
      // machine. Remote peers run their own `feed --json`; never enqueue a
      // policy answer into a local mailbox for a remote agent.
      const preparedLocal = prepareLocalFeedBlocks(localBlocks, {
        includeLocal,
        all: opts.all,
        dispatch: opts.dispatch,
      });
      const visibleLocalBlocks = preparedLocal.visible;
      const dispatchBlocks = preparedLocal.dispatch;

      let blocks = visibleLocalBlocks;
      const forceLocal = opts.local === true || process.env[FEED_NO_FANOUT_ENV] === '1';
      if (!forceLocal) {
        const remoteHosts = remoteFeedHostsToDial(opts.host, self);
        if (!opts.host?.length || (remoteHosts && remoteHosts.length > 0)) {
          const remote = await gatherRemoteAgentsJson({
            // Bare --json stays a block array so older peers and scripts keep working.
            args: ['feed', '--json'],
            noFanoutEnv: FEED_NO_FANOUT_ENV,
            hosts: remoteHosts,
            parse: parseRemoteFeed,
          });
          blocks = mergeFeedBlocks(visibleLocalBlocks, remote.items);
        }
      }

      blocks = rankFeedBlocks(blocks, localSignals);
      const digest = suppressionDigest(preparedLocal.filter);
      if (digest && !opts.json) {
        console.log(chalk.dim(digest));
      }

      if (opts.dispatch) {
        const policy = loadPolicy();
        const now = new Date();
        for (const b of dispatchBlocks) {
          // Wrap per-block policy so one malformed block (e.g. a crafted
          // mailboxId that throws in mailboxDir) can't abort the whole loop and
          // strand every remaining block's dispatch.
          try {
            const result = applyPolicyToBlock(b, policy, now);
            if (result.action !== 'none') {
              console.log(`${chalk.yellow('policy')} ${b.blockId}: ${result.action}`);
            }
            if (isPhoneUrgent(b, policy)) {
              const notifyResult = await notifyUrgentBlock(b, { dryRun: opts.json });
              if (notifyResult.ok && !notifyResult.skipped) {
                recordNotified(b.blockId);
                console.log(`${chalk.green('notified')} ${b.blockId}`);
              } else if (notifyResult.error) {
                console.error(chalk.yellow(`Notification failed for ${b.blockId}: ${notifyResult.error}`));
              }
            }
          } catch (err) {
            console.error(chalk.yellow(`Skipped block ${b.blockId}: ${(err as Error).message}`));
          }
        }
      }

      for (const warning of setupWarnings) {
        console.error(chalk.yellow(`Feed hook setup warning: ${warning}`));
      }

      if (opts.json) {
        // Always a block array (stamped with outcome + ask class) so remote fan-out
        // and scripts keep a stable contract. Human grouping is text-only.
        const stamped = stampBlockOutcomes(blocks).map((b) => ({
          ...b,
          ask: classifyBlock(b),
        }));
        console.log(JSON.stringify(stamped, null, 2));
        return;
      }

      if (blocks.length === 0) {
        console.log(chalk.gray(digest ? 'No open blocks after stall suppression.' : 'No open blocks.'));
        await renderTrailingActivity();
        return;
      }

      // Shared fleet-comms masthead (same family as `agents mailboxes`).
      console.log(
        masthead({
          title: 'they need you',
          accent: 'amber',
          host: self,
          right: formatFeedMastheadRight(blocks),
        }),
      );
      console.log();

      if (opts.flat) {
        for (const b of blocks) renderBlock(b, self);
        return;
      }

      const groups = groupBlocksByOutcome(blocks).sort((a, b) => {
        const ar = Math.max(...a.blocks.map((block) => block.delayRank?.score ?? 0));
        const br = Math.max(...b.blocks.map((block) => block.delayRank?.score ?? 0));
        return br - ar;
      });
      for (const g of groups) renderOutcomeGroup(g, self);
      await renderTrailingActivity();
    });
}

/** Feed view selector (RUSH-2015): decisions, progress, or both. */
export type FeedFilter = 'needs' | 'updates' | 'all';

/** Normalize a raw --filter value; unknown/empty falls back to the default. */
export function resolveFeedFilter(raw: string | undefined): FeedFilter {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'updates' || v === 'update') return 'updates';
  if (v === 'all') return 'all';
  return 'needs';
}

/**
 * Render one activity event in the lane: deliberate progress posts
 * (`status.posted`) use the rich multi-line {@link formatProgressUpdate}; hook
 * milestones (PR, commit, …) keep the compact {@link formatActivityLine}.
 */
function renderActivityEntry(ev: ActivityEvent): void {
  if (ev.event === 'status.posted') {
    console.log(formatProgressUpdate(ev));
  } else {
    console.log(formatActivityLine(ev, { showHost: true }));
  }
}

/** How far back the updates view looks for deliberate progress posts. */
const UPDATES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Posts kept per machine in the rendered view / the `--json` payload. */
const UPDATES_VIEW_LIMIT = 30;
const UPDATES_JSON_LIMIT = 100;

/**
 * The most recent `limit` deliberate progress posts on THIS machine, newest
 * first. The event filter is pushed into the reader so `limit` counts posts —
 * slicing first and filtering after returned an empty view on a busy box, where
 * routine `file.edited` hook events fill the whole slice.
 */
function readStatusPosts(limit: number): ActivityEvent[] {
  return readRecentActivity({
    sinceMs: Date.now() - UPDATES_WINDOW_MS,
    limit,
    events: ['status.posted'],
  });
}

/**
 * Progress posts across the fleet, newest first. An agent posts on whichever
 * box it runs on, so a local-only read shows the operator a fraction of what
 * the fleet reported. Peers are dialed with the same SSH fan-out the block view
 * uses; `--local` (or the no-fanout env guard on a peer) keeps it to this box.
 */
async function gatherStatusPosts(opts: {
  limit: number;
  hosts?: string[];
  local?: boolean;
  includeLocal: boolean;
  self: string;
}): Promise<EnrichedActivityEvent[]> {
  const local: EnrichedActivityEvent[] = opts.includeLocal ? readStatusPosts(opts.limit) : [];
  const forceLocal = opts.local === true || process.env[FEED_NO_FANOUT_ENV] === '1';
  if (forceLocal) return local;
  const remoteHosts = opts.hosts?.length ? remoteFeedHostsToDial(opts.hosts, opts.self) : undefined;
  if (opts.hosts?.length && (!remoteHosts || remoteHosts.length === 0)) return local;
  const remote = await gatherRemoteAgentsJson({
    args: ['feed', '--filter', 'updates', '--json'],
    noFanoutEnv: FEED_NO_FANOUT_ENV,
    hosts: remoteHosts,
    parse: parseActivityPayload,
  });
  return mergeActivityEvents(local, remote.items).slice(0, opts.limit);
}

/**
 * Render the **Updates** view: deliberate progress posts only (`status.posted`),
 * recency-ordered, with rich identity chips. Pure `file.edited` / git-hook noise
 * is excluded so operators see announcements, not tool churn.
 */
function renderUpdatesView(updates: ActivityEvent[]): void {
  const hosts = new Set(updates.map((e) => e.host).filter(Boolean));
  console.log(
    masthead({
      title: 'updates',
      accent: 'cyan',
      host: hosts.size > 1 ? `${hosts.size} machines` : (updates[0]?.host ?? machineId()),
      right: `${updates.length} post${updates.length === 1 ? '' : 's'}`,
    }),
  );
  console.log();
  if (updates.length === 0) {
    console.log(chalk.gray('  No progress updates yet. Agents post them with `agents feed post "…"`.'));
    return;
  }
  for (const ev of updates) {
    console.log(formatProgressUpdate(ev));
    console.log();
  }
}

/**
 * Print a compact "recent activity" lane under the feed: the last few milestone
 * events (plans, PRs, worktrees, sub-agents, progress posts) from the append-only
 * activity logs. Read-only tail of the logs -- no transcript re-parsing. Silent
 * when empty.
 */
function renderActivityLane(limit = 6): void {
  const events = readRecentActivity({
    sinceMs: Date.now() - 24 * 60 * 60 * 1000,
    limit,
    tier: 'milestone',
  });
  if (events.length === 0) return;
  console.log(chalk.bold('\n  recent activity'));
  for (const ev of events) renderActivityEntry(ev);
  console.log(chalk.gray('  → agents activity  for the full stream'));
}
