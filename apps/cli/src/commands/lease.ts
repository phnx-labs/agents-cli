/**
 * `agents lease` — manage the disposable cloud boxes used by `agents run --lease`.
 *
 * Today: `agents lease gc`, which stops expired + idle "orphan" boxes that are
 * holding a provider's server quota (the cause of the `server_limit` 403 a new
 * lease hits). Reaping is conservative: only boxes whose lease has expired AND
 * that have been untouched for a safety window are eligible (see `isReapSafe`),
 * so a box a concurrent run just reused is never stopped.
 */

import type { Command } from 'commander';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { crabboxList, reapSafeOrphans, reapOrphans, setLeaseSecretsBundle, type CrabboxBox } from '../lib/crabbox/cli.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { bundleExists, readBundle, writeBundle, keychainRef, bundleItemStore } from '../lib/secrets/bundles.js';
import { secretsKeychainItem } from '../lib/secrets/index.js';
import type { SecretsBundle } from '../lib/secrets/bundles.js';

function fmtIdle(box: CrabboxBox): string {
  if (box.lastTouchedAt === null) return 'idle ?';
  const iso = new Date(box.lastTouchedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `idle since ${iso}Z`;
}

const HETZNER_BUNDLE = 'hetzner.com';
const HCLOUD_KEY = 'HCLOUD_TOKEN';
const HETZNER_CONSOLE_URL = 'https://console.hetzner.cloud/';

/** Best-effort: open a URL in the user's default browser. Never throws. */
function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {
    /* best-effort */
  }
}

/** Validate a Hetzner token against the live API. Exported for unit tests (fetch injectable). */
export async function validateHetznerToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const res = await fetchImpl('https://api.hetzner.cloud/v1/servers?per_page=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return 'valid';
    if (res.status === 401 || res.status === 403) return 'invalid';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * One-time credential setup for `agents run --lease` (Hetzner today). Opens the
 * token page, collects a token, validates it against the live API, stores it in
 * the keychain bundle `hetzner.com`, and persists it as the default lease bundle
 * (so `--lease` needs no env var or flag afterward). Returns true on success.
 * Never throws for expected outcomes (non-interactive, cancel, repeated failure).
 */
export async function runLeaseSetup(opts: { provider?: string } = {}): Promise<boolean> {
  const provider = opts.provider ?? 'hetzner';
  if (provider !== 'hetzner') {
    console.error(chalk.yellow(`lease setup: only 'hetzner' is supported today (got '${provider}').`));
    return false;
  }
  if (!isInteractiveTerminal()) {
    console.error(
      chalk.red(
        'lease setup needs an interactive terminal. For CI/headless, set AGENTS_LEASE_SECRETS_BUNDLE ' +
          'or store HCLOUD_TOKEN in a keychain bundle.',
      ),
    );
    return false;
  }

  console.error(chalk.bold('\nSet up leasing (Hetzner) — one time (~30s):'));
  console.error(chalk.dim('Opening the Hetzner console. Create/select a project, then Security → API Tokens →'));
  console.error(chalk.dim('Generate a token with Read & Write permission, and copy it.\n'));
  openUrl(HETZNER_CONSOLE_URL);

  const { password } = await import('@inquirer/prompts');
  const ora = (await import('ora')).default;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = (await password({ message: 'Paste your Hetzner API token:', mask: true })).trim();
      if (!token) {
        console.error(chalk.yellow('No token entered.'));
        continue;
      }

      const spinner = ora('Validating token against the Hetzner API…').start();
      const result = await validateHetznerToken(token);
      if (result === 'invalid') {
        spinner.fail('Token rejected by Hetzner (401/403). Try again.');
        continue;
      }
      if (result === 'unreachable') spinner.warn('Could not reach the Hetzner API to validate — storing anyway.');
      else spinner.succeed('Token valid — Hetzner API reachable.');

      // Store into the `hetzner.com` keychain bundle (mirrors writeSyncBundle).
      const bundle: SecretsBundle = bundleExists(HETZNER_BUNDLE)
        ? readBundle(HETZNER_BUNDLE)
        : { name: HETZNER_BUNDLE, description: 'Hetzner Cloud API token for crabbox leases', vars: {} };
      const store = bundleItemStore(bundle.backend);
      store.set(secretsKeychainItem(HETZNER_BUNDLE, HCLOUD_KEY), token);
      bundle.vars[HCLOUD_KEY] = keychainRef(HCLOUD_KEY);
      writeBundle(bundle);

      setLeaseSecretsBundle(HETZNER_BUNDLE);
      console.error(chalk.green(`\n✔ Stored in keychain bundle '${HETZNER_BUNDLE}' and set as the default lease provider.`));
      console.error(chalk.dim('  Run `agents run <agent> "…" --lease` — no env var, no flag needed.'));
      return true;
    }
    console.error(chalk.yellow('lease setup: no valid token after 3 attempts — aborted.'));
    return false;
  } catch (e) {
    if (isPromptCancelled(e)) {
      console.error(chalk.yellow('lease setup cancelled.'));
      return false;
    }
    throw e;
  }
}

export function registerLeaseCommand(program: Command): void {
  const lease = program
    .command('lease')
    .description('Manage the disposable cloud boxes used by `agents run --lease`.');

  lease
    .command('setup')
    .description('One-time credential setup so `agents run --lease` works with no env var or flag.')
    .option('--provider <name>', 'Cloud provider (only hetzner today)', 'hetzner')
    .action(async (opts: { provider?: string }) => {
      const ok = await runLeaseSetup({ provider: opts.provider });
      process.exit(ok ? 0 : 1);
    });

  lease
    .command('gc')
    .description(
      'Stop expired, idle lease boxes that are holding your provider quota. Safe: never stops a box in active use.',
    )
    .option('--dry-run', 'List reap-safe orphan boxes without stopping any', false)
    .option('--yes', 'Stop them without the interactive confirm', false)
    .option('--json', 'Output JSON', false)
    .action(async (opts: { dryRun?: boolean; yes?: boolean; json?: boolean }) => {
      const boxOpts = { secretsBundle: process.env.AGENTS_LEASE_SECRETS_BUNDLE };
      const nowSecs = Math.floor(Date.now() / 1000);

      let candidates: CrabboxBox[];
      try {
        candidates = reapSafeOrphans(crabboxList(boxOpts), nowSecs);
      } catch (e) {
        console.error(chalk.red(`lease gc: ${(e as Error).message}`));
        process.exit(1);
        return;
      }

      if (candidates.length === 0) {
        if (opts.json) console.log(JSON.stringify({ candidates: [], reaped: [] }));
        else console.error(chalk.gray('No reap-safe orphan boxes — nothing to collect.'));
        return;
      }

      if (!opts.json) {
        console.error(chalk.bold(`${candidates.length} reap-safe orphan box(es):`));
        for (const b of candidates) {
          console.error(`  ${chalk.cyan(b.slug)} ${chalk.dim(`(${b.class ?? '?'}, ${fmtIdle(b)})`)}`);
        }
      }

      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify({ candidates, reaped: [] }, null, 2));
        else console.error(chalk.gray('\n--dry-run: nothing stopped. Re-run with --yes to stop them.'));
        return;
      }

      // Destructive: stopping boxes the agent did not create needs an explicit yes.
      if (!opts.yes) {
        const { isInteractiveTerminal, isPromptCancelled } = await import('./utils.js');
        if (!isInteractiveTerminal()) {
          console.error(chalk.yellow('Refusing to stop boxes without --yes in a non-interactive shell.'));
          process.exit(1);
          return;
        }
        try {
          const { confirm } = await import('@inquirer/prompts');
          const ok = await confirm({ message: `Stop these ${candidates.length} box(es)?`, default: false });
          if (!ok) {
            console.error(chalk.yellow('Aborted — no boxes stopped.'));
            return;
          }
        } catch (e) {
          if (isPromptCancelled(e)) {
            console.error(chalk.yellow('Aborted — no boxes stopped.'));
            return;
          }
          throw e;
        }
      }

      // Re-list at stop time (freshness re-check) so a box touched since the
      // preview is not stopped out from under an active run.
      const { candidates: stopped, reaped } = reapOrphans({ ...boxOpts, nowSecs });
      if (opts.json) console.log(JSON.stringify({ candidates: stopped, reaped }, null, 2));
      else console.error(chalk.green(`Stopped ${reaped.length}/${stopped.length} box(es): ${reaped.join(', ') || '(none)'}`));
    });
}
