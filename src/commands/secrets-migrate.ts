/**
 * `agents secrets migrate-acl` — refresh existing keychain items so they pick
 * up the new SecAccess ACL written by the signed Agents CLI.app helper.
 *
 * Items created before 1.19.2 (or by `security add-generic-password` directly)
 * may carry the legacy "this-app-only" ACL that prompts the user for a
 * password on every read. Re-writing them through the helper bakes in the
 * empty trusted-app ACL that suppresses the prompt and lets the helper read
 * them under LocalAuthentication instead.
 *
 * Sequence per item:
 *   1. Read the current value (no auth prompt path — uses the unauthenticated
 *      `security` CLI for non-sync items, helper `get` for sync items).
 *   2. Append (item, value, sync) to an encrypted backup before any writes.
 *   3. Delete + rewrite via the helper so macOS hands us a fresh ACL on the
 *      new item.
 *   4. Read back via the helper to verify the value round-trips.
 *
 * `--dry-run` (default) reports the planned actions. `--commit` performs the
 * writes and produces the backup.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  deleteKeychainToken,
  getKeychainToken,
  getKeychainTokens,
  hasKeychainToken,
  listKeychainItems,
  listLegacyKeychainItems,
  listOrphanedKeychainItems,
  migrateOrphanedKeychainItems,
  setKeychainToken,
} from '../lib/secrets/index.js';
import { getBackupsDir } from '../lib/state.js';
import { encryptBlob, MIN_PASSPHRASE_LEN } from '../lib/secrets/sync.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

const ITEM_PREFIX = 'agents-cli.';

interface MigrationRecord {
  item: string;
  sync: boolean;
  value: string;
}

interface MigrationResult {
  item: string;
  status: 'ok' | 'verify-failed' | 'write-failed' | 'read-failed';
  detail?: string;
}

function enumerateItems(): Array<{ item: string; sync: boolean }> {
  const seen = new Map<string, { item: string; sync: boolean }>();
  for (const item of listKeychainItems(ITEM_PREFIX)) {
    // hasKeychainToken with sync=false probes the non-synced keychain; the
    // helper's list returns both. We don't try to distinguish — re-write with
    // sync=false by default and only flip to sync=true if the value is only
    // readable via the synced-only probe.
    const localExists = hasKeychainToken(item);
    seen.set(item, { item, sync: !localExists });
  }
  return [...seen.values()];
}

function writeEncryptedBackup(records: MigrationRecord[], passphrase: string): string {
  const dir = getBackupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `keychain-pre-migrate-${iso}.json.enc`);
  const envelope = encryptBlob(JSON.stringify({ v: 1, records }), passphrase);
  fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
  return file;
}

async function promptPassphrase(): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A backup passphrase is required. Run from a TTY or set AGENTS_BACKUP_PASSPHRASE.');
  }
  const { password } = await import('@inquirer/prompts');
  const first = await password({ message: 'Backup passphrase (used to encrypt the pre-migration snapshot)', mask: true });
  if (first.length < MIN_PASSPHRASE_LEN) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters.`);
  const second = await password({ message: 'Confirm passphrase', mask: true });
  if (first !== second) throw new Error('Passphrases do not match.');
  return first;
}

function migrateOne(record: MigrationRecord): MigrationResult {
  const { item, value } = record;
  // Delete + re-add to force macOS to bind a fresh ACL on the new item.
  // SecItemUpdate preserves the existing ACL, so an in-place rewrite would
  // not fix the legacy "enter password" prompt.
  try {
    deleteKeychainToken(item);
  } catch (err) {
    return { item, status: 'write-failed', detail: `delete: ${(err as Error).message}` };
  }
  try {
    setKeychainToken(item, value);
  } catch (err) {
    // Try to restore the old value so we don't lose data on a write failure.
    // The backup is the durable safety net; this is best-effort UX.
    try { setKeychainToken(item, value); } catch { /* swallow */ }
    return { item, status: 'write-failed', detail: `set: ${(err as Error).message}` };
  }
  let readBack: string;
  try {
    readBack = getKeychainToken(item);
  } catch (err) {
    return { item, status: 'verify-failed', detail: `read-back: ${(err as Error).message}` };
  }
  if (readBack !== value) {
    return { item, status: 'verify-failed', detail: 'value mismatch after rewrite' };
  }
  return { item, status: 'ok' };
}

/** Register `agents secrets migrate-acl` on the parent secrets Command. */
export function registerSecretsMigrateAclCommand(secrets: Command): void {
  secrets
    .command('migrate-acl')
    .description('Refresh legacy keychain ACLs and re-home items stranded in a stale access group. Dry-run by default.')
    .option('--commit', 'Perform writes (default is dry-run reporting only)')
    .option('--prefix <p>', `Restrict to items beginning with PREFIX (default ${ITEM_PREFIX})`, ITEM_PREFIX)
    .option('--all', 'Rewrite EVERY matching item, not just legacy stragglers (slower; a Touch ID prompt per item)')
    .option('--passphrase-env <var>', 'Read the backup passphrase from this env var instead of prompting')
    .action(async (opts: { commit?: boolean; prefix?: string; all?: boolean; passphraseEnv?: string }) => {
      try {
        if (process.platform !== 'darwin') {
          throw new Error('migrate-acl is macOS-only. Linux items already use the keyring-native ACL model.');
        }
        const prefix = opts.prefix ?? ITEM_PREFIX;
        if (!prefix.startsWith(ITEM_PREFIX)) {
          throw new Error(
            `--prefix must start with '${ITEM_PREFIX}' to avoid touching unrelated Keychain items (got '${prefix}').`,
          );
        }
        // Two independent classes of work under one command:
        //   (a) Legacy ACL stragglers — items still in the file-based keychain
        //       with a pre-migration trusted-app ACL. Rewritten value-by-value.
        //   (b) Orphaned access groups — data-protection items filed under a
        //       pre-#279 non-concrete group, invisible to the pinned queries.
        //       Re-homed by the helper behind a single Touch ID.
        // Default: only legacy stragglers for (a); `--all` forces a full rewrite.
        const names = opts.all ? listKeychainItems(prefix) : listLegacyKeychainItems(prefix);
        const items = names.map((item) => {
          const localExists = hasKeychainToken(item);
          return { item, sync: !localExists };
        });
        const orphans = listOrphanedKeychainItems(prefix);

        if (items.length === 0 && orphans.length === 0) {
          console.log(
            opts.all
              ? chalk.gray(`No keychain items with prefix '${prefix}'.`)
              : chalk.green(`Nothing to migrate — all items under '${prefix}' use the modern ACL and access group.`),
          );
          return;
        }

        const label = opts.all ? 'item' : 'legacy item';
        if (items.length > 0) {
          console.log(chalk.bold(`Found ${items.length} ${label}(s) under '${prefix}' with an outdated ACL.`));
        }
        if (orphans.length > 0) {
          console.log(chalk.bold(`Found ${orphans.length} orphaned item(s) under '${prefix}' in a stale access group.`));
        }

        if (!opts.commit) {
          for (const { item, sync } of items) {
            console.log(`  ${chalk.cyan(item)} ${chalk.gray(sync ? '(synced)' : '(local)')}`);
          }
          for (const item of orphans) {
            console.log(`  ${chalk.cyan(item)} ${chalk.yellow('(orphaned access group)')}`);
          }
          console.log();
          console.log(chalk.gray('Dry-run — pass --commit to perform the migration.'));
          return;
        }

        // ---- Commit phase ----
        let okCount = 0;
        let failCount = 0;

        // (a) Legacy ACL rewrite. Snapshot every value first (one batched read
        // behind a single helper process), encrypt, then delete + re-add.
        if (items.length > 0) {
          const fetched = getKeychainTokens(items.map((i) => i.item));
          const records: MigrationRecord[] = [];
          for (const { item, sync } of items) {
            const value = fetched.get(item);
            if (value === undefined) {
              console.error(chalk.red(`Skipping '${item}': read failed or item absent.`));
              continue;
            }
            records.push({ item, sync, value });
          }
          if (records.length === 0) {
            console.error(chalk.red('No legacy items could be read. Aborting before any writes.'));
            process.exit(1);
          }
          const passphrase = opts.passphraseEnv
            ? (() => {
                const v = process.env[opts.passphraseEnv!];
                if (!v) throw new Error(`Env var '${opts.passphraseEnv}' not set.`);
                if (v.length < MIN_PASSPHRASE_LEN) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters.`);
                return v;
              })()
            : await promptPassphrase();
          const backupPath = writeEncryptedBackup(records, passphrase);
          // Quick fingerprint so the user can sanity-check recovery without decrypting.
          const fingerprint = crypto
            .createHash('sha256')
            .update(records.length + '\n' + records.map((r) => r.item).sort().join('\n'))
            .digest('hex')
            .slice(0, 12);
          console.log(chalk.green(`Encrypted backup written to ${backupPath} (sha256-12: ${fingerprint}).`));
          const results: MigrationResult[] = [];
          for (const record of records) {
            const r = migrateOne(record);
            results.push(r);
            if (r.status === 'ok') {
              console.log(`  ${chalk.green('ok')}     ${record.item}`);
            } else {
              console.log(`  ${chalk.red(r.status)} ${record.item} ${chalk.gray(r.detail ?? '')}`);
            }
          }
          const ok = results.filter((r) => r.status === 'ok').length;
          okCount += ok;
          failCount += results.length - ok;
          if (results.length - ok > 0) {
            console.error(chalk.gray(`Restore from ${backupPath} using the backup passphrase if needed.`));
          }
        }

        // (b) Orphan re-home — one helper call, one Touch ID for the batch. The
        // helper adds the pinned copy before deleting the orphan, so no pre-write
        // backup is needed (a failed add leaves the orphan intact and readable).
        if (orphans.length > 0) {
          console.log(chalk.bold(`Re-homing ${orphans.length} orphaned item(s) into the current access group (one Touch ID)…`));
          const results = migrateOrphanedKeychainItems(prefix);
          const healed = new Set<string>();
          for (const r of results) {
            healed.add(r.item);
            if (r.status === 'ok') {
              okCount += 1;
              console.log(`  ${chalk.green('ok')}     ${r.item}`);
            } else {
              failCount += 1;
              console.log(`  ${chalk.red(r.status)} ${r.item} ${chalk.gray(r.detail ?? '')}`);
            }
          }
          // Any orphan we listed but the helper couldn't reach (e.g. under a
          // different signing team) — surface it, never drop it silently.
          for (const item of orphans) {
            if (!healed.has(item)) {
              failCount += 1;
              console.log(`  ${chalk.red('fail')} ${item} ${chalk.gray('unreachable (different signing team?)')}`);
            }
          }
        }

        const total = okCount + failCount;
        console.log();
        if (failCount === 0) {
          console.log(chalk.green(`Migrated ${okCount}/${total} item(s).`));
        } else {
          console.error(chalk.yellow(`Migrated ${okCount}/${total} item(s); ${failCount} failed.`));
          process.exit(1);
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
