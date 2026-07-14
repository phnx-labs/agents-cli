/**
 * `agents feed` -- list open blocks (decisions agents are waiting on).
 *
 * Aggregates block records from the local feed store and, with --host, from
 * reachable remote hosts via SSH passthrough. Each block carries enough
 * identity for `agents message` to route a reply back to the right agent.
 *
 * Default view groups by **outcome** (ticket / PR / worktree / Unassigned) so
 * an operator sees dozens of deliverables, not ~1,100 agents. Pass `--flat`
 * for the legacy per-agent list.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { ensureFeedPublishHook, listBlocks, recordNotified, type OpenBlock } from '../lib/feed.js';
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
import { getActiveSessions } from '../lib/session/active.js';
import { mailboxIdForActiveSession } from '../lib/mailbox-target.js';

export const FEED_NO_FANOUT_ENV = 'AGENTS_FEED_LOCAL';

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

function renderBlock(b: OpenBlock, localHost: string, indent = ''): void {
  const host = b.host !== localHost ? chalk.yellow(` [${b.host}]`) : '';
  const runtime = chalk.gray(b.runtime);
  const age = chalk.gray(relTime(b.ts));
  const cls = b.blockClass ? chalk.gray(`(${b.blockClass})`) : '';
  const consequence = b.consequence && b.consequence !== 'normal' ? chalk.red(`[${b.consequence}]`) : '';
  const cost = b.costOfDelay ? chalk.gray(`cost:${b.costOfDelay}`) : '';
  console.log(`${indent}${chalk.cyan(b.mailboxId)}${host}  ${runtime}  ${age}  ${cls} ${consequence} ${cost}`.trimEnd());
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
    const verified = b.answer.verified ? chalk.green('✓') : chalk.yellow('?');
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

  if (!b.answer && !b.parkedAt) {
    console.log(`${indent}  ${chalk.dim('reply:')} agents message ${b.mailboxId} "<answer>"`);
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
  program
    .command('feed')
    .description('List open blocks -- decisions agents are waiting on (grouped by outcome)')
    .option('--json', 'Output as JSON (each block stamped with its outcome + ask class)')
    .option('--flat', 'List one block per agent instead of grouping by outcome')
    .option('--all', 'Include stalls/FYIs that policy would suppress (default: hide them)')
    .option('--local', 'Only this machine -- skip the cross-machine SSH fan-out')
    .option('-H, --host <target...>', 'Scope to remote machine(s) over SSH; repeatable')
    .option('--device <target...>', 'Alias for --host; repeatable')
    .option('--dispatch', 'Run stall suppression + default-on-no-answer policy and urgent notifications')
    .action(async (opts: {
      json?: boolean;
      flat?: boolean;
      all?: boolean;
      local?: boolean;
      host?: string[];
      device?: string[];
      dispatch?: boolean;
    }) => {
      if (opts.device?.length) opts.host = [...(opts.host ?? []), ...opts.device];
      const self = machineId();
      const includeLocal = shouldIncludeLocalFeed(opts.host, self);
      const setupWarnings: string[] = [];
      if (includeLocal) {
        const hookInstall = ensureFeedPublishHook();
        if (hookInstall.error) {
          setupWarnings.push(hookInstall.error);
        } else {
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

      // Active sessions feed both the GC sweep and outcome enrichment (ticket/PR).
      let sessions: Awaited<ReturnType<typeof getActiveSessions>> = [];
      if (includeLocal) {
        sessions = await getActiveSessions();
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

      const localBlocks = includeLocal ? listBlocks() : [];
      let blocks = localBlocks;
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
          blocks = mergeFeedBlocks(localBlocks, remote.items);
        }
      }

      // Fill missing ticket/PR/worktree from live session meta so outcome keys
      // land even when the publish hook had no deliverable stamp.
      if (sessions.length > 0) {
        blocks = enrichBlocksFromSessions(blocks, sessionHintsFromActive(sessions));
      }

      // Stall suppression (RUSH-1477): auto-answer "should I…?" / "what's next?"
      // so they never render. Applied on every feed read unless --all; --dispatch
      // also applies so unattended ticks drain the stall backlog.
      const filter = filterBlocksForFeed(blocks, {
        apply: !opts.all || opts.dispatch === true,
      });
      if (!opts.all) {
        blocks = filter.surfaced;
      }
      const digest = suppressionDigest(filter);
      if (digest && !opts.json) {
        console.log(chalk.dim(digest));
      }

      if (opts.dispatch) {
        const policy = loadPolicy();
        const now = new Date();
        for (const b of blocks) {
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
        return;
      }

      if (opts.flat) {
        console.log(chalk.bold(`${blocks.length} open block${blocks.length === 1 ? '' : 's'}:\n`));
        for (const b of blocks) renderBlock(b, self);
        return;
      }

      const groups = groupBlocksByOutcome(blocks);
      const openOutcomes = groups.filter((g) => g.counts.open > 0).length;
      console.log(
        chalk.bold(
          `${groups.length} outcome${groups.length === 1 ? '' : 's'} · ${blocks.length} block${blocks.length === 1 ? '' : 's'}` +
            (openOutcomes > 0 ? ` · ${openOutcomes} need you` : '') +
            ':\n',
        ),
      );
      for (const g of groups) renderOutcomeGroup(g, self);
    });
}
