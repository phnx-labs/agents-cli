/**
 * `agents setup secrets` — install guidance for the standalone `secrets` CLI,
 * then a pass-through to its own `secrets migrate` onboarding (PHNX-3989).
 *
 * The wizard that used to pick a default backend/policy and delegate imports
 * lived entirely against the in-repo secrets engine. That engine is extracted
 * to `@phnx-labs/secrets-cli`, which owns its own interactive onboarding
 * (`secrets migrate`) — agents-cli never rebundles it (DIST-1), so there is no
 * in-process fallback when it isn't installed: this command names the install
 * command and stops.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { getHistoryDir } from '../lib/state.js';
import { resolveSecretsBin, invocation, SecretsClientError } from '../lib/secrets-client.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/secrets-cli';

export function setupSecretsPrefsPath(): string {
  return path.join(getHistoryDir(), 'setup', 'secrets.json');
}

/** True when the standalone `secrets` executable resolves ($SECRETS_BIN or PATH). */
export function isSecretsCliInstalled(): boolean {
  try {
    resolveSecretsBin();
    return true;
  } catch (err) {
    if (err instanceof SecretsClientError && err.code === 'SECRETS_BIN_MISSING') return false;
    throw err;
  }
}

function recordSetupComplete(): void {
  const file = setupSecretsPrefsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Print install guidance when the standalone is missing, else hand off to its
 * own interactive `secrets migrate`. Returns whether setup is now complete
 * (installed, and — when it ran — `migrate` exited 0).
 */
export async function runSecretsSetupWizard(): Promise<boolean> {
  if (!isSecretsCliInstalled()) {
    console.log(chalk.yellow('The standalone `secrets` CLI is not installed.'));
    console.log(chalk.gray('Install it, then re-run `agents setup secrets`:'));
    console.log(chalk.cyan(`  ${INSTALL_HINT}`));
    return false;
  }
  const bin = resolveSecretsBin();
  const { command, prefix } = invocation(bin);
  const res = spawnSync(command, [...prefix, 'migrate'], { stdio: 'inherit' });
  const ok = (res.status ?? 1) === 0;
  if (ok) recordSetupComplete();
  return ok;
}

/** Register `agents setup secrets` under the parent `setup` command. */
export function registerSetupSecretsCommand(setupCmd: Command): void {
  setupCmd
    .command('secrets')
    .description('Install guidance for the standalone `secrets` CLI, then run its own `secrets migrate` onboarding.')
    .action(async () => {
      if (!(await runSecretsSetupWizard())) process.exitCode = 1;
    });
}
