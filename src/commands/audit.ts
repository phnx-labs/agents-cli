/**
 * `agents audit` — inspect the tamper-evident audit log of dispatched runs.
 *
 * Every run that reaches the exec dispatch chokepoint appends one hash-chained
 * record (see src/lib/audit/log.ts). This command walks that chain:
 *
 *   agents audit verify   Confirm the chain is intact; report the first break.
 *   agents audit list     Print recent records (newest last).
 *
 * `verify` exits non-zero when the chain is broken so it can gate CI / governance
 * checks.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  verifyAuditChain,
  readAuditLog,
  getAuditLogPath,
  type AuditRecord,
} from '../lib/audit/log.js';

interface ListOptions {
  limit?: string;
  json?: boolean;
}

function renderRow(r: AuditRecord, i: number): string {
  const idx = chalk.gray(String(i).padStart(4));
  const time = chalk.gray(r.ts.slice(0, 19).replace('T', ' '));
  const who = `${r.agent}@${r.version}`.padEnd(20);
  const outcome = r.outcome === 'ok' ? chalk.green('ok  ') : chalk.red('fail');
  const mode = chalk.cyan(r.mode.padEnd(6));
  return `${idx}  ${time}  ${who} ${mode} ${outcome} exit=${r.exit}  ${r.repo}`;
}

export function registerAuditCommands(program: Command): void {
  const audit = program
    .command('audit')
    .description('Inspect the tamper-evident audit log of dispatched runs');

  audit
    .command('verify')
    .description('Walk the hash chain and report OK or the first broken index')
    .option('--json', 'Output the result as JSON')
    .action((options: { json?: boolean }) => {
      const result = verifyAuditChain();
      if (options.json) {
        console.log(JSON.stringify(result));
        process.exit(result.ok ? 0 : 1);
      }
      if (result.ok) {
        const n = readAuditLog().length;
        console.log(chalk.green(`✓ audit chain intact — ${n} record(s) verified`));
        console.log(chalk.gray(`  ${getAuditLogPath()}`));
        process.exit(0);
      }
      console.error(chalk.red(`✗ audit chain BROKEN at record #${result.brokenAt}`));
      console.error(chalk.gray(`  ${getAuditLogPath()}`));
      process.exit(1);
    });

  audit
    .command('list')
    .description('Print recent audit records (oldest-first)')
    .option('--limit <n>', 'Max records to show (default 50)', '50')
    .option('--json', 'Output raw records as JSON')
    .action((options: ListOptions) => {
      const all = readAuditLog();
      if (options.json) {
        console.log(JSON.stringify(all, null, 2));
        return;
      }
      if (all.length === 0) {
        console.log(chalk.gray('No audit records yet.'));
        return;
      }
      const limit = Math.max(1, parseInt(options.limit ?? '50', 10) || 50);
      const start = Math.max(0, all.length - limit);
      for (let i = start; i < all.length; i++) console.log(renderRow(all[i], i));
      console.log(chalk.gray(`\n${all.length} record(s). Log: ${getAuditLogPath()}`));
    });
}
