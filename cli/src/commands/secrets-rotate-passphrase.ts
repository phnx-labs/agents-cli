/**
 * `agents secrets rotate-passphrase` — rotate the encrypted file store's
 * machine-local master passphrase (RUSH-1975).
 *
 * Re-encrypts every `<item>.enc` under a freshly generated key and rewrites the
 * 0600 key file in place, atomically: the new store is staged, verified
 * (round-trip + count), fsync'd, then swapped by directory rename, so a crash
 * leaves the old store intact and readable. Headless-safe and Linux-first — the
 * remediation path for a compromised passphrase (RUSH-1968), where the two
 * supported alternatives are unacceptable (a hand-rolled non-atomic script, or
 * export-to-plaintext which is the exposure being fixed).
 *
 * Dry-run by default, matching `import-keyring`; `--commit` performs the swap.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { machinePassphraseExists, rotatePassphrase } from '../lib/secrets/filestore.js';
import { agentStatus } from '../lib/secrets/agent.js';

/** Register `agents secrets rotate-passphrase` on the parent secrets Command. */
export function registerSecretsRotatePassphraseCommand(secrets: Command): void {
  secrets
    .command('rotate-passphrase')
    .description('Re-key the encrypted file store under a new machine-local passphrase (atomic, headless-safe). Dry-run by default.')
    .option('--commit', 'Perform the rotation (default is dry-run reporting only)')
    .option('--dry-run', 'Report bundle count and round-trip result without re-keying (the default). Still heals an interrupted rotation — that is the one thing it writes.')
    .option('--force', 'Override the safety refusals (held broker unlocks, or a passphrase exported in the environment)')
    .addHelpText('after', `
Rotates the auto-provisioned file-store key at ~/.agents/.secrets-key/passphrase:
decrypts every item under the current key, re-encrypts under a new one, verifies
every item round-trips, then swaps the store and key file atomically. A crash
before the swap leaves the old store readable with the old key; a crash inside the
swap self-heals on the next rotate-passphrase run (not on an ordinary get). No
plaintext secret value or passphrase is ever written to disk, argv, or a log.

Examples:
  # Report what would rotate (no writes)
  agents secrets rotate-passphrase

  # Perform the rotation
  agents secrets rotate-passphrase --commit`)
    .action(async (opts: { commit?: boolean; dryRun?: boolean; force?: boolean }) => {
      try {
        if (opts.commit && opts.dryRun) {
          throw new Error('--commit and --dry-run are mutually exclusive.');
        }
        const dryRun = !opts.commit;

        if (!machinePassphraseExists()) {
          throw new Error(
            'No machine-local passphrase is provisioned on this box, so there is nothing to rotate. ' +
            'This command re-keys the file store\'s auto-provisioned key at ~/.agents/.secrets-key/passphrase.',
          );
        }

        // Guard 1: refuse while the secrets-agent holds live unlocks (macOS), so a
        // concurrent read cannot land against a half-swapped store. --force overrides.
        if (!dryRun && !opts.force) {
          const held = await agentStatus();
          if (held.length > 0) {
            throw new Error(
              `The secrets-agent is holding ${held.length} unlocked bundle(s) (${held.map((e) => e.name).join(', ')}). ` +
              'Lock them first (`agents secrets lock --all`) so no concurrent read races the rotation, or pass --force.',
            );
          }
        }

        // Guard 2: a passphrase exported in the environment shadows the on-disk key
        // file with a now-stale value after the rotation, breaking every read. This
        // is the exact RUSH-1968 footgun — refuse the commit and point at the fix.
        if (!dryRun && !opts.force && (process.env.AGENTS_SECRETS_PASSPHRASE ?? '').length > 0) {
          throw new Error(
            'AGENTS_SECRETS_PASSPHRASE is set in this environment; it would shadow the rotated key file ' +
            'with a stale value and break every read. Unset it (this is the RUSH-1968 fix) before rotating, or pass --force.',
          );
        }

        const report = rotatePassphrase({ dryRun });

        console.log(
          `${chalk.bold(String(report.bundleCount))} item(s) decrypt under the current key and ` +
          `${report.roundTripOk ? chalk.green('round-trip cleanly') : chalk.red('failed to round-trip')} under a new key.`,
        );
        if (report.skipped.length > 0) {
          console.log(chalk.gray(`skipped ${report.skipped.length} orphan file(s) (not re-keyed):`));
          for (const s of report.skipped) console.log(chalk.gray(`  - ${s}`));
        }

        if (report.dryRun) {
          if (report.recoveredInterruptedRotation) {
            // Be precise: this run DID write. Recovery is deliberately not gated on
            // --commit, because healing is how a crashed store becomes readable
            // again without re-keying it.
            console.log(chalk.yellow(
              'Recovered an interrupted rotation: the store was healed back to a single ' +
              'readable state. That is the only thing this dry run wrote — no re-keying happened.',
            ));
          } else {
            console.log(chalk.gray('Dry-run: nothing written.'));
          }
          console.log(chalk.gray(`Pass --commit to re-encrypt the store and swap the key file (${report.keyFilePath}).`));
          return;
        }
        console.log(chalk.green(`Rotated: re-encrypted ${report.bundleCount} item(s) and rewrote ${report.keyFilePath} (mode 0600).`));
        console.log(chalk.gray('The previous key and ciphertext were removed. Any process still holding the old passphrase in its environment must be restarted.'));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
