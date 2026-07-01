/**
 * `agents wallet` — a device-local credit-card vault backed by macOS Keychain.
 *
 * UX intent matches Apple Wallet: list cards freely (no biometric), reveal
 * a card with Touch ID. Card numbers never leave the device. This is NOT
 * Apple Pay — we store the real PAN, not a network DPAN, and do not generate
 * per-transaction cryptograms. The help text reflects this.
 *
 * Bundle layout:
 *   ~/.agents/wallet/cards.json                   metadata (id, last4, brand, exp)
 *   agents-cli.secrets.wallet.<id>                JSON {pan, cvc, cardholder}
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { terminalWidth, truncateToWidth } from '../lib/session/width.js';
import {
  addCard,
  detectBrand,
  isValidLuhn,
  listCards,
  readIndex,
  removeCard,
  renameCard,
  showCard,
  type CardBrand,
  type CardMetadata,
} from '../lib/wallet/index.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';

function brandLabel(b: CardBrand): string {
  switch (b) {
    case 'visa': return 'Visa';
    case 'mastercard': return 'Mastercard';
    case 'amex': return 'American Express';
    case 'discover': return 'Discover';
    case 'diners': return 'Diners Club';
    case 'jcb': return 'JCB';
    case 'unionpay': return 'UnionPay';
    default: return 'Card';
  }
}

function formatExp(month: string, year: string): string {
  return `${month}/${year.slice(-2)}`;
}

/** Width of the id column (incl. its 2-space gap): full UUID >=104, short id >=80, none below. */
export function walletIdWidth(cols: number): number {
  return cols >= 104 ? 2 + 36 : cols >= 80 ? 2 + 8 : 0;
}

/** Nickname column width. Shrinks so the whole row fits even at the 60-col floor. */
export function walletNickWidth(cols: number): number {
  const rest = 2 + 1 + 18 + 1 + 10 + 1 + 9 + walletIdWidth(cols); // everything but the nickname
  return Math.max(8, Math.min(24, cols - rest));
}

export function renderRow(c: CardMetadata, cols = terminalWidth()): string {
  const nickW = walletNickWidth(cols);
  const nick = truncateToWidth(c.nickname, nickW).padEnd(nickW);
  const brand = brandLabel(c.brand).padEnd(18);
  const last4 = `•••• ${c.last4}`.padEnd(10);
  const exp = formatExp(c.exp_month, c.exp_year);
  // Full 36-char UUID pushed rows to ~106 chars; size the id to the terminal.
  const id = cols >= 104 ? c.id : cols >= 80 ? c.id.slice(0, 8) : '';
  const idCol = id ? `  ${chalk.gray(id)}` : '';
  return `  ${chalk.cyan(nick)} ${brand} ${last4} ${chalk.gray('exp ' + exp)}${idCol}`;
}

async function promptString(message: string, validate?: (v: string) => true | string): Promise<string> {
  const { input } = await import('@inquirer/prompts');
  return await input({ message, validate });
}

async function promptSecret(message: string): Promise<string> {
  const { password } = await import('@inquirer/prompts');
  return await password({ message, mask: true });
}

function requireTTY(action: string): void {
  if (!isInteractiveTerminal()) {
    throw new Error(`'agents wallet ${action}' requires an interactive terminal.`);
  }
}

export function registerWalletCommands(program: Command): void {
  const cmd = program
    .command('wallet')
    .description(
      'Device-local credit-card vault backed by macOS Keychain (Touch ID required to reveal). ' +
      'Encrypted at rest, never leaves your device. Not Apple Pay — stores real PANs, no tokenization.'
    );

  setHelpSections(cmd, {
    examples: `
      $ agents wallet add                              # interactive: PAN, CVC, expiry, nickname
      $ agents wallet list                             # last 4 only, no Touch ID prompt
      $ agents wallet show personal-amex               # Touch ID required, reveals full card
      $ agents wallet rename personal-amex "Travel"
      $ agents wallet remove personal-amex
    `,
  });

  cmd
    .command('add')
    .description('Add a card to the vault. Interactive prompt for PAN, CVC, expiry, cardholder, nickname.')
    .option('--nickname <name>', 'Set the nickname non-interactively (still prompts for PAN/CVC)')
    .option('--stdin-json', 'Read all fields as a JSON object on stdin (for IPC callers). Emits the new card metadata as JSON to stdout.')
    .action(async (opts: { nickname?: string; stdinJson?: boolean }) => {
      try {
        if (opts.stdinJson) {
          const raw = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            process.stdin.on('data', (c: Buffer | string) => {
              chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
            });
            process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            process.stdin.on('error', reject);
          });
          const input = JSON.parse(raw);
          const meta = addCard(input);
          process.stdout.write(JSON.stringify({ card: meta }) + '\n');
          return;
        }
        requireTTY('add');
        const pan = (await promptSecret('Card number')).replace(/\s+/g, '');
        if (!/^\d+$/.test(pan)) throw new Error('PAN must contain only digits.');
        if (!isValidLuhn(pan)) throw new Error('PAN failed Luhn checksum — typo?');
        const brand = detectBrand(pan);
        console.log(chalk.gray(`Detected: ${brandLabel(brand)} •••• ${pan.slice(-4)}`));

        const exp_month = await promptString('Expiration month (MM)', (v) => {
          const n = Number(v);
          return Number.isInteger(n) && n >= 1 && n <= 12 ? true : 'Month must be 1-12';
        });
        const exp_year = await promptString('Expiration year (YY or YYYY)', (v) => {
          const d = v.replace(/\D/g, '');
          return d.length === 2 || d.length === 4 ? true : 'Year must be 2 or 4 digits';
        });
        const cvc = (await promptSecret('CVC')).replace(/\s+/g, '');
        if (!/^\d{3,4}$/.test(cvc)) throw new Error('CVC must be 3 or 4 digits.');
        const cardholder = await promptString('Cardholder name (as printed)');
        const nickname = opts.nickname?.trim() || await promptString('Nickname (e.g. Personal Amex)', (v) => v.trim() ? true : 'Required');

        const meta = addCard({ nickname, pan, cvc, cardholder, exp_month, exp_year });
        console.log(chalk.green(`Added ${brandLabel(meta.brand)} •••• ${meta.last4} as '${meta.nickname}' (id: ${meta.id})`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('list')
    .alias('ls')
    .description('List stored cards (metadata only — last 4, brand, expiry). No biometric prompt.')
    .option('--json', 'Emit JSON to stdout')
    .action((opts: { json?: boolean }) => {
      try {
        const cards = listCards();
        if (opts.json) {
          process.stdout.write(JSON.stringify({ cards }, null, 2) + '\n');
          return;
        }
        if (cards.length === 0) {
          console.log(chalk.gray('No cards in wallet. Try: agents wallet add'));
          return;
        }
        const walletCols = terminalWidth();
        const nickW = walletNickWidth(walletCols);
        const idHeader = walletIdWidth(walletCols) ? '        ID' : '';
        console.log(chalk.bold(`  ${'NICKNAME'.padEnd(nickW)} ${'BRAND'.padEnd(18)} ${'LAST4'.padEnd(10)} EXP${idHeader}`));
        for (const c of cards) console.log(renderRow(c, walletCols));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('show <id>')
    .description('Reveal a card. Touch ID required. Argument is a card id or nickname.')
    .option('--json', 'Emit JSON to stdout (still triggers Touch ID)')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const full = showCard(id);
        if (opts.json) {
          process.stdout.write(JSON.stringify(full, null, 2) + '\n');
          return;
        }
        console.log();
        console.log(chalk.bold(`  ${full.nickname}`));
        console.log(`  ${chalk.gray('Brand     ')} ${brandLabel(full.brand)}`);
        console.log(`  ${chalk.gray('Number    ')} ${full.pan.match(/.{1,4}/g)?.join(' ') ?? full.pan}`);
        console.log(`  ${chalk.gray('CVC       ')} ${full.cvc}`);
        console.log(`  ${chalk.gray('Expires   ')} ${formatExp(full.exp_month, full.exp_year)}`);
        console.log(`  ${chalk.gray('Holder    ')} ${full.cardholder}`);
        console.log();
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('remove <id>')
    .alias('rm')
    .description('Remove a card from the vault. Argument is a card id or nickname.')
    .action((id: string) => {
      try {
        const meta = removeCard(id);
        if (!meta) {
          console.error(chalk.red(`No card found matching '${id}'.`));
          process.exit(1);
        }
        console.log(chalk.green(`Removed '${meta.nickname}' (${brandLabel(meta.brand)} •••• ${meta.last4}).`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('rename <id> <new-nickname>')
    .description('Rename a card. Argument is the current id or nickname.')
    .action((id: string, newNickname: string) => {
      try {
        const meta = renameCard(id, newNickname);
        console.log(chalk.green(`Renamed to '${meta.nickname}'.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
