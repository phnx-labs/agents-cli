/**
 * `agents feed` -- list open blocks (decisions agents are waiting on).
 *
 * Aggregates block records from the local feed store and, with --host, from
 * reachable remote hosts via SSH passthrough. Each block carries enough
 * identity for `agents message` to route a reply back to the right agent.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { ensureFeedPublishHook, listBlocks, type OpenBlock } from '../lib/feed.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { relTime } from '../lib/format.js';
import { gatherRemoteAgentsJson } from '../lib/remote-agents-json.js';

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

function renderBlock(b: OpenBlock, localHost: string): void {
  const host = b.host !== localHost ? chalk.yellow(` [${b.host}]`) : '';
  const runtime = chalk.gray(b.runtime);
  const age = chalk.gray(relTime(b.ts));
  console.log(`${chalk.cyan(b.mailboxId)}${host}  ${runtime}  ${age}`);
  for (const question of b.questions) {
    const header = question.header ? chalk.gray(`[${question.header}] `) : '';
    console.log(`  ${header}${question.text}`);
    if (question.options?.length) {
      for (let i = 0; i < question.options.length; i++) {
        const o = question.options[i];
        const desc = o.description ? chalk.gray(` -- ${o.description}`) : '';
        console.log(`    ${chalk.dim(`${i + 1}.`)} ${o.label}${desc}`);
      }
    }
  }
  if (b.ticket || b.pr) {
    const meta = [b.ticket, b.pr].filter(Boolean).join('  ');
    console.log(`  ${chalk.gray(meta)}`);
  }

  if (b.answer) {
    const who = b.answer.answeredFrom + (b.answer.answeredBy ? ` (${b.answer.answeredBy})` : '');
    console.log(`  ${chalk.green('answered')} by ${who}`);
  }
  if (b.receipts && b.receipts.length > 0) {
    const latest = b.receipts[b.receipts.length - 1];
    console.log(`  ${chalk.dim('delivery:')} ${latest.status}`);
  }
  if (b.continuedAt) {
    console.log(`  ${chalk.green('continued')} ${relTime(b.continuedAt)}`);
  }

  if (!b.answer) {
    console.log(`  ${chalk.dim('reply:')} agents message ${b.mailboxId} "<answer>"`);
  }
  console.log();
}

export function registerFeedCommand(program: Command): void {
  program
    .command('feed')
    .description('List open blocks -- decisions agents are waiting on')
    .option('--json', 'Output as JSON')
    .option('--local', 'Only this machine -- skip the cross-machine SSH fan-out')
    .option('-H, --host <target...>', 'Scope to remote machine(s) over SSH; repeatable')
    .option('--device <target...>', 'Alias for --host; repeatable')
    .action(async (opts: { json?: boolean; local?: boolean; host?: string[]; device?: string[] }) => {
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

      const localBlocks = includeLocal ? listBlocks() : [];
      let blocks = localBlocks;
      const forceLocal = opts.local === true || process.env[FEED_NO_FANOUT_ENV] === '1';
      if (!forceLocal) {
        const remoteHosts = remoteFeedHostsToDial(opts.host, self);
        if (!opts.host?.length || (remoteHosts && remoteHosts.length > 0)) {
          const remote = await gatherRemoteAgentsJson({
            args: ['feed', '--json'],
            noFanoutEnv: FEED_NO_FANOUT_ENV,
            hosts: remoteHosts,
            parse: parseRemoteFeed,
          });
          blocks = mergeFeedBlocks(localBlocks, remote.items);
        }
      }

      for (const warning of setupWarnings) {
        console.error(chalk.yellow(`Feed hook setup warning: ${warning}`));
      }

      if (opts.json) {
        console.log(JSON.stringify(blocks, null, 2));
        return;
      }

      if (blocks.length === 0) {
        console.log(chalk.gray('No open blocks.'));
        return;
      }

      console.log(chalk.bold(`${blocks.length} open block${blocks.length === 1 ? '' : 's'}:\n`));
      for (const b of blocks) renderBlock(b, self);
    });
}
