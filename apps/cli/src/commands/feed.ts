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
import { machineId } from '../lib/machine-id.js';
import { relTime } from '../lib/format.js';

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
  console.log(`  ${chalk.dim('reply:')} agents message ${b.mailboxId} "<answer>"`);
  console.log();
}

export function registerFeedCommand(program: Command): void {
  program
    .command('feed')
    .description('List open blocks -- decisions agents are waiting on')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const setupWarnings: string[] = [];
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
      const blocks = listBlocks();

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

      const local = machineId();
      console.log(chalk.bold(`${blocks.length} open block${blocks.length === 1 ? '' : 's'}:\n`));
      for (const b of blocks) renderBlock(b, local);
    });
}
