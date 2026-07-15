/**
 * Interactive provisioning flow for cross-machine session sync. Collects R2
 * credentials, writes the `r2.backups` bundle (via the pure lib helper), probes
 * connectivity, and opts the machine into the `session-sync` beta. Shared by
 * `agents setup` (offered, opt-in) and `agents sessions sync --setup` (explicit).
 *
 * The prompt/UI lives here in the command layer; the credential-writing and
 * connectivity logic is the pure, unit-tested `lib/session/sync/provision.ts`.
 */

import chalk from 'chalk';
import ora from 'ora';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { isSyncConfigured } from '../lib/session/sync/config.js';
import { writeSyncBundle, probeR2Connectivity, readStoredEncKey } from '../lib/session/sync/provision.js';
import { setBetaEnabled } from '../lib/beta.js';

const SYNC_BETA = 'session-sync' as const;

export interface ProvisionFlowOptions {
  /**
   * True when invoked explicitly (`agents sessions sync --setup`): we go straight
   * into provisioning. False when offered inside `agents setup`: we ask first,
   * default to No, and silently skip when already configured.
   */
  explicit?: boolean;
}

const nonEmpty = (v: string): true | string => (v.trim().length > 0 ? true : 'required');

/**
 * Run the guided session-sync setup. Never throws for expected outcomes
 * (non-interactive shell, user declines, cancels, or a failed probe) — returns
 * quietly so a first-run `agents setup` is never blocked by the optional step.
 */
export async function promptAndProvisionSessionSync(opts: ProvisionFlowOptions = {}): Promise<void> {
  if (!isInteractiveTerminal()) {
    if (opts.explicit) console.error(chalk.red('Session-sync setup needs an interactive terminal.'));
    return;
  }

  const alreadyConfigured = isSyncConfigured();
  const { confirm, input, password } = await import('@inquirer/prompts');

  try {
    if (!opts.explicit) {
      if (alreadyConfigured) return; // first-run setup: nothing to do
      const want = await confirm({
        message: 'Set up cross-machine session sync (encrypted transcripts via Cloudflare R2)?',
        default: false,
      });
      if (!want) return;
    } else if (alreadyConfigured) {
      const reconfigure = await confirm({
        message: 'Session sync is already configured. Re-enter R2 credentials?',
        default: false,
      });
      if (!reconfigure) {
        const key = readStoredEncKey();
        if (key) {
          console.log(chalk.dim('\nShared encryption key (paste on every other machine you sync):'));
          console.log('  ' + chalk.cyan(key));
        }
        return;
      }
    }

    console.log(chalk.dim('\nR2 credentials — Cloudflare dashboard > R2 > Manage API Tokens (needs read+write):'));
    const accountId = (await input({ message: 'R2 account ID:', validate: nonEmpty })).trim();
    const bucketName = (await input({ message: 'R2 bucket name:', validate: nonEmpty })).trim();
    const accessKeyId = (await password({ message: 'R2 access key ID:', mask: true })).trim();
    const secretAccessKey = (await password({ message: 'R2 secret access key:', mask: true })).trim();
    const endpoint = (await input({
      message: 'S3 endpoint override (blank = Cloudflare R2):',
      default: '',
    })).trim();

    // Encryption key: the first machine mints one; every other machine pastes it
    // so the whole fabric shares a single key (and can decrypt each other).
    const firstMachine = await confirm({ message: 'Is this the FIRST machine in your sync fabric?', default: true });
    let encKey: string | undefined;
    if (!firstMachine) {
      encKey = (await password({
        message: 'Paste the shared R2_SYNC_ENC_KEY from your first machine:',
        mask: true,
        validate: nonEmpty,
      })).trim();
    }

    const { encKeyAction } = writeSyncBundle({
      accountId, bucketName, accessKeyId, secretAccessKey,
      endpoint: endpoint || undefined,
      encKey: encKey || undefined,
    });

    const spinner = ora('Validating R2 read+write...').start();
    const probe = await probeR2Connectivity();
    if (!probe.ok) {
      spinner.fail(`R2 probe failed: ${probe.error}`);
      console.log(chalk.yellow(
        'Credentials were saved to the r2.backups bundle but not verified. Fix them and re-run ' +
        '`agents sessions sync --setup`, or rotate one key with `agents secrets rotate r2.backups <KEY>`.',
      ));
      return; // do not auto-enable sync against credentials that don't work
    }
    spinner.succeed('R2 read+write verified.');

    setBetaEnabled([SYNC_BETA], true);
    console.log(chalk.green('\nSession sync configured and enabled') + chalk.dim(' (the daemon syncs every ~90s).'));

    if (encKeyAction === 'generated') {
      const key = readStoredEncKey();
      console.log(chalk.bold('\nShared encryption key — paste this on every OTHER machine you sync:'));
      console.log('  ' + chalk.cyan(key ?? '(unavailable)'));
      console.log(chalk.dim('Anyone with this key can decrypt your transcripts. Keep it secret.'));
    }
    console.log(chalk.dim('\nSync now with: agents sessions sync'));
  } catch (err) {
    if (isPromptCancelled(err)) {
      console.log(chalk.yellow('\nSession-sync setup cancelled.'));
      return;
    }
    throw err;
  }
}
