/**
 * Shared `mint` subcommand registered on both `agents auth` (the ticket
 * surface) and `agents accounts` (the credential noun). Implementation lives
 * in lib/auth-mint.ts so neither command file owns the seed path.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { readStdinSync, runOrDie } from '../lib/format.js';
import { isInteractiveTerminal } from './utils.js';
import {
  getMintFlow,
  listMintableHarnesses,
  mintAndSeed,
  type MintAndSeedResult,
} from '../lib/auth-mint.js';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printResult(result: MintAndSeedResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      harness: result.harness,
      account: result.account,
      email: result.email,
      authBundleKey: result.authBundleKey,
      rotated: result.rotated,
      fleet: result.fleet,
    }, null, 2));
    return;
  }
  const verb = result.rotated ? 'Rotated' : 'Minted';
  console.log(chalk.green(
    `${verb} ${result.harness} setup-token for ${result.email} into account '${result.account}' and reserved auth bundle key ${result.authBundleKey}.`,
  ));
  console.log(chalk.gray('The token is never printed. Native OAuth was not copied.'));
  console.log(chalk.gray(`Run: agents run ${result.harness} --account ${result.account}`));
  if (result.fleet.length) {
    for (const row of result.fleet) {
      console.log(chalk.green(`  synced ${row.device} (${row.message})`));
    }
  }
}

export function registerMintCommand(parent: Command): Command {
  const mint = parent
    .command('mint <harness>')
    .description('Mint a long-lived setup-token and seed it as a named account')
    .option('--account <name-or-email>', 'Named account to create/rotate, or the account email')
    .option('--email <email>', 'Email that keys the reserved auth bundle when --account is a name')
    .option('--token-stdin', 'Seed an already-minted token from stdin (skip the PTY drive)')
    .option('--code <code>', 'Authorization code to paste into the setup-token prompt')
    .option('--no-open', 'Print the authorize URL instead of opening a browser')
    .option('--fleet', 'Sync the minted account and reserved auth bundle to every other registered device')
    .option('--device <name>', 'Sync to this device (repeatable)', collect, [] as string[])
    .option('--json', 'Machine-readable result (never includes the token)')
    .action((harness: string, o: {
      account?: string;
      email?: string;
      tokenStdin?: boolean;
      code?: string;
      open?: boolean;
      fleet?: boolean;
      device?: string[];
      json?: boolean;
    }, command: Command) => {
      const json = !!o.json || !!command.optsWithGlobals().json;
      return runOrDie(async () => {
        getMintFlow(harness);
        let token: string | undefined;
        if (o.tokenStdin) {
          token = readStdinSync();
          if (!token) throw new Error('No value received on stdin. Pass the setup-token on stdin with --token-stdin.');
        } else if (!isInteractiveTerminal() && !o.code) {
          throw new Error(
            `Minting ${harness} interactively needs a TTY (or --token-stdin / --code). Supported harnesses: ${listMintableHarnesses().join(', ')}.`,
          );
        }
        const result = await mintAndSeed({
          harness,
          account: o.account,
          email: o.email,
          token,
          code: o.code,
          open: o.open,
          fleet: o.fleet,
          devices: o.device,
          hooks: o.tokenStdin || o.code || !isInteractiveTerminal() ? undefined : {
            readCode: async () => {
              const { input } = await import('@inquirer/prompts');
              return input({ message: 'Paste the authorization code from the browser' });
            },
          },
        });
        printResult(result, json);
      }, { json });
    });

  setHelpSections(mint, {
    examples: `agents accounts mint claude
agents accounts mint claude --account ada@example.com
agents accounts mint claude --account work --email ada@example.com
agents accounts mint claude --token-stdin < token.txt
agents accounts mint claude --fleet
agents auth mint claude --account ada@example.com --json`,
    notes: `Claude is the only harness with an interactive long-lived setup-token (\`claude setup-token\`, ~1 year, shareable across machines). The command drives that flow in a PTY, opens the authorize URL, captures a well-formed sk-ant-oat01- token (refusing the #1767 TTY-banner capture), and seeds:
  1. a named provider account (policy never) for \`agents run --account\` / \`agents accounts sync\`
  2. the reserved FILE-BASED auth bundle keyed per email, which usage/probe reads
Native rotating OAuth is never copied. Other harnesses fail loud: device-code login is \`agents fleet login\`; API keys are \`agents accounts add\`.
Already have a token? \`--token-stdin\` skips the browser dance. \`agents auth mint\` is the same command as \`agents accounts mint\`.`,
  });

  return mint;
}
