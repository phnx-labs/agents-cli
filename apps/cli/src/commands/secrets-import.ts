/**
 * `agents secrets import-keyring` — migrate agents-cli secrets out of the native
 * credential store (GNOME Keyring / Windows Credential Manager) and into the
 * encrypted file store.
 *
 * Why: on headless Linux/Windows the file store is the durable, passwordless
 * backend, but secrets written earlier (e.g. while a desktop keyring was
 * unlocked) can linger in the native store where a headless session can't reach
 * them. This is the Linux/Windows analogue of the macOS `migrate-acl` /
 * orphan sweep. Dry-run by default; `--commit` performs the copy.
 *
 * Requires the native store to be reachable/unlocked — a locked keyring can't be
 * read, so unlock it first (or the values are already only in the file store and
 * there is nothing to do).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { importNativeItems } from '../lib/secrets/index.js';

/** Register `agents secrets import-keyring` on the parent secrets Command. */
export function registerSecretsImportKeyringCommand(secrets: Command): void {
  secrets
    .command('import-keyring')
    .description('Migrate agents-cli secrets from the OS keyring / Credential Manager into the encrypted file store (headless-safe). Dry-run by default.')
    .option('--commit', 'Perform the import (default is dry-run reporting only)')
    .option('--prefix <p>', 'Only import items beginning with PREFIX (default: all agents-cli items)')
    .action((opts: { commit?: boolean; prefix?: string }) => {
      try {
        if (process.platform === 'darwin') {
          throw new Error(
            'import-keyring is for the Linux/Windows file-store fallback. On macOS use `agents secrets migrate-acl`.',
          );
        }
        const commit = !!opts.commit;
        const report = importNativeItems(opts.prefix ?? '', commit);

        if (!report.available) {
          console.log(chalk.gray('No native credential tooling found (secret-tool / PowerShell) — nothing to import.'));
          return;
        }
        if (report.locked) {
          console.error(chalk.yellow(
            'The native credential store is locked/unreachable, so its secrets can\'t be read. ' +
            'Unlock it and retry (a locked store can\'t be migrated).',
          ));
          process.exit(1);
        }
        if (report.results.length === 0) {
          console.log(chalk.green('Nothing to import — no native secrets outside the file store.'));
          return;
        }

        const imported = report.results.filter((r) => r.status === 'imported' || r.status === 'would-import');
        const existing = report.results.filter((r) => r.status === 'exists');
        const failed = report.results.filter((r) => r.status === 'failed');

        for (const r of report.results) {
          if (r.status === 'imported') console.log(`  ${chalk.green('imported')}  ${r.item}`);
          else if (r.status === 'would-import') console.log(`  ${chalk.cyan('would import')}  ${r.item}`);
          else if (r.status === 'exists') console.log(`  ${chalk.gray('exists')}    ${r.item} ${chalk.gray('(already in file store)')}`);
          else console.log(`  ${chalk.red('failed')}    ${r.item} ${chalk.gray(r.detail ?? '')}`);
        }
        console.log();

        if (!commit) {
          console.log(chalk.gray(`Dry-run: ${imported.length} would be imported, ${existing.length} already present, ${failed.length} unreadable. Pass --commit to write.`));
          return;
        }
        if (failed.length > 0) {
          console.error(chalk.yellow(`Imported ${imported.length}; ${existing.length} already present; ${failed.length} failed.`));
          process.exit(1);
        }
        console.log(chalk.green(`Imported ${imported.length} secret(s) into the file store (${existing.length} already present).`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
