/**
 * `agents setup browser` — interactive wizard to get `agents browser` working on
 * a fresh machine: detect an installed Chromium-family browser, create the
 * `default` profile pinned to it, optionally make it this machine's default, and
 * point the user at the one manual step we can't automate (first-run + sign-in).
 *
 * Idempotent: re-running shows the current default profile and offers to change
 * the pinned browser or re-point the device default.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { updateMeta } from '../lib/state.js';
import { findFirstInstalledBrowser, listInstalledBrowsers } from '../lib/browser/chrome.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  createProfile,
  findFreeProfilePort,
  getConfiguredDefaultProfileName,
  getProfile,
  type BrowserProfile,
} from '../lib/browser/profiles.js';
import { DEFAULT_VIEWPORT } from '../lib/browser/devices.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

const INSTALL_HINT =
  'Install one of: Google Chrome, Brave, Microsoft Edge, Chromium, or Comet, then re-run `agents setup browser`.\n' +
  '(Safari and Firefox are not supported — agents browser drives over the Chrome DevTools Protocol.)';

/**
 * Interactive browser setup. Returns true if a usable default profile exists
 * afterwards, false if the machine has no supported browser or the user backed
 * out. Never throws on cancel — the `agents setup` hub relies on that.
 */
export async function runBrowserWizard(): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    // Non-interactive: do the safe, deterministic thing (auto-detect + pin a
    // default) without prompting, or print the install hint and bail.
    if (!findFirstInstalledBrowser()) {
      console.error(chalk.red('No supported browser found.\n') + chalk.dim(INSTALL_HINT));
      return false;
    }
    const existing = await getProfile(DEFAULT_BROWSER_PROFILE_NAME);
    if (existing) {
      console.log(chalk.dim(`Browser profile "${DEFAULT_BROWSER_PROFILE_NAME}" already exists.`));
      return true;
    }
    const created = await createAutoDefault();
    console.log(chalk.green(`Created browser profile "${created.name}" → ${created.browser}.`));
    return true;
  }

  const installed = listInstalledBrowsers();
  if (installed.length === 0) {
    console.error(chalk.red('No supported browser found on this machine.'));
    console.log(chalk.dim(INSTALL_HINT));
    return false;
  }

  const { confirm, select } = await import('@inquirer/prompts');

  // If a default profile already exists, this is a reconfigure.
  const existing = await getProfile(DEFAULT_BROWSER_PROFILE_NAME);
  if (existing) {
    console.log(
      chalk.dim(
        `Browser profile "${existing.name}" already exists (${existing.browser}${existing.binary ? ` · ${existing.binary}` : ''}).`,
      ),
    );
    const change = await confirm({ message: 'Re-create it (e.g. to pin a different browser)?', default: false });
    if (!change) {
      await maybeSetDeviceDefault(existing.name, confirm);
      printOnboardingNextStep(existing.name);
      return true;
    }
    // Re-create: drop the old one so createProfile doesn't collide.
    const { deleteProfile } = await import('../lib/browser/profiles.js');
    await deleteProfile(existing.name);
  }

  // Pick which installed browser to pin (auto-select if only one).
  let chosen = installed[0];
  if (installed.length > 1) {
    const value = await select({
      message: 'Which browser should the default profile use?',
      choices: installed.map((b) => ({ name: `${b.browserType}  ${chalk.dim(b.binary)}`, value: b.browserType })),
    });
    chosen = installed.find((b) => b.browserType === value) ?? installed[0];
  }

  const freePort = await findFreeProfilePort();
  const profile: BrowserProfile = {
    name: DEFAULT_BROWSER_PROFILE_NAME,
    description: `${chosen.browserType} profile (agents setup browser)`,
    browser: chosen.browserType,
    binary: chosen.binary,
    endpoints: [`cdp://127.0.0.1:${freePort}`],
    viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
  };
  await createProfile(profile);
  console.log(chalk.green(`\nCreated browser profile "${profile.name}" → ${chosen.browserType} (CDP 127.0.0.1:${freePort}).`));

  await maybeSetDeviceDefault(profile.name, confirm);
  printOnboardingNextStep(profile.name);
  return true;
}

/** Build + persist a `default` profile pinned to the first installed browser. */
async function createAutoDefault(): Promise<BrowserProfile> {
  const detected = findFirstInstalledBrowser();
  if (!detected) throw new Error('No supported browser found.');
  const freePort = await findFreeProfilePort();
  const profile: BrowserProfile = {
    name: DEFAULT_BROWSER_PROFILE_NAME,
    description: `Auto-detected ${detected.browserType} profile`,
    browser: detected.browserType,
    binary: detected.binary,
    endpoints: [`cdp://127.0.0.1:${freePort}`],
    viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
  };
  await createProfile(profile);
  return profile;
}

/** Offer to make `name` this machine's default browser profile (device-local). */
async function maybeSetDeviceDefault(
  name: string,
  confirm: (typeof import('@inquirer/prompts'))['confirm'],
): Promise<void> {
  const current = getConfiguredDefaultProfileName();
  if (current === name) return; // already the device default
  const set = await confirm({
    message: `Make "${name}" this machine's default browser profile?`,
    default: true,
  });
  if (set) {
    updateMeta((m) => ({ ...m, defaultBrowserProfile: name }));
    console.log(chalk.dim(`Bare \`agents browser start\` will now use "${name}" on this machine.`));
  }
}

/** The one step we can't automate: Chrome's first-run + your own sign-in. */
function printOnboardingNextStep(name: string): void {
  console.log(chalk.bold('\nOne manual step left:'));
  console.log(
    '  ' +
      chalk.cyan(`agents browser start --profile ${name}`) +
      chalk.dim('   # finish Chrome first-run + sign in to any sites you want automated'),
  );
  console.log(chalk.dim(`  Then check it's ready:  agents browser profiles doctor ${name}`));
}

/** Register `agents setup browser` under the parent `setup` command. */
export function registerSetupBrowserCommand(setupCmd: Command): void {
  setupCmd
    .command('browser')
    .description('Set up `agents browser` — detect an installed browser and create the default profile.')
    .action(async () => {
      try {
        await runBrowserWizard();
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });
}
