/**
 * Preferences onboarding — the guided path over the same device-config keys the
 * `agents devices …` commands write (lib/device-config.ts). Two questions, each
 * TTY-only, skippable, and absent non-interactively:
 *
 *   1. "Which machine do you sit at?"   → `interactive.host` (central config:)
 *   2. "Which browser should agents drive on THIS machine?"
 *                                       → `browser.profile` (device-local default)
 *
 * Shared by the bare `agents setup` flow (a short step after the capability
 * hub) and by `agents setup fleet` (interactive host after a successful sync).
 * Unset always keeps today's behavior — skipping is a real choice, not a
 * partial state.
 */

import chalk from 'chalk';
import { listInstalledBrowsers } from '../lib/browser/chrome.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  getAutoDetectedProfile,
  createProfile,
  findFreeProfilePort,
  getConfiguredDefaultProfileName,
  getProfile,
  type BrowserProfile,
} from '../lib/browser/profiles.js';
import { DEFAULT_VIEWPORT } from '../lib/browser/devices.js';
import { getConfigValue, setConfigValue } from '../lib/device-config.js';
import { loadDevices, type DeviceRegistry } from '../lib/devices/registry.js';
import { machineId } from '../lib/machine-id.js';
import { isInteractiveTerminal } from './utils.js';

const SKIP = '__skip__';

/** Registered macOS device names, sorted — the interactive-host candidates. */
export function macDeviceNames(reg: DeviceRegistry): string[] {
  return Object.values(reg)
    .filter((d) => d.platform === 'macos')
    .map((d) => d.name)
    .sort();
}

/**
 * The interactive-host picker's highlighted default: this machine when it is a
 * candidate (the common case — you run setup on the box you sit at), else the
 * first candidate. null when there are no candidates.
 */
export function defaultInteractiveHostChoice(candidates: string[], self: string = machineId()): string | null {
  if (candidates.length === 0) return null;
  return candidates.includes(self) ? self : candidates[0];
}

/**
 * The browser picker's highlighted default — the same browser auto-detect
 * would win, since `listInstalledBrowsers` returns platform priority order
 * (macOS: chrome first). null when nothing is installed.
 */
export function defaultBrowserChoice<T extends { browserType: string }>(installed: T[]): T['browserType'] | null {
  return installed.length > 0 ? installed[0].browserType : null;
}

/**
 * Offer to set the interactive host when none is configured and the registry
 * has more than one macOS device. Returns true when a host was set. Silent
 * no-op non-TTY, when already set, or with fewer than two candidates (the
 * answer is obvious or absent).
 */
export async function maybePickInteractiveHost(): Promise<boolean> {
  if (!isInteractiveTerminal()) return false;
  if (getConfigValue('interactive.host').value !== undefined) return false;
  const macs = macDeviceNames(await loadDevices());
  if (macs.length < 2) return false;

  const { select } = await import('@inquirer/prompts');
  const self = machineId();
  const picked = await select({
    message: 'Which machine do you sit at? (agents open browser windows and artifacts there)',
    default: defaultInteractiveHostChoice(macs, self) ?? SKIP,
    choices: [
      ...macs.map((n) => ({ name: n === self ? `${n}  ${chalk.dim('(this machine)')}` : n, value: n })),
      { name: `Skip ${chalk.dim('— decide later: agents devices config <name> interactive.host <name>')}`, value: SKIP },
    ],
  });
  if (picked === SKIP) return false;
  setConfigValue('interactive.host', picked);
  console.log(chalk.green(`Interactive host: '${picked}'`) + chalk.dim(' — marked ★ interactive in `agents devices list`.'));
  return true;
}

/**
 * Offer to pin this machine's default browser profile to a chosen browser.
 * Only asked when there is nothing to preserve: no configured device default
 * AND no existing `default` profile (an existing profile is the user's earlier
 * choice — never re-pinned behind their back). The list is the installed
 * Chromium-family browsers plus a "None — this box uses the fleet hub" opt-out.
 *
 * This is the ONE place a default browser is chosen for a machine (PHNX-3296):
 * a bare `agents browser start` no longer auto-detects and mints one, so picking
 * here (or `agents browser use` / `agents setup browser` later) is how a box
 * gets a local default at all. Picking "None" leaves it to the fleet hub
 * (`browser.device`). Returns true when a profile was created and set as the
 * device default. Silent no-op non-TTY — a headless box relies on the hub.
 */
export async function maybePickBrowserProfile(deps: {
  /** Force interactivity in a test; defaults to a real TTY probe. */
  interactive?: boolean;
  /** Inject the prompt so the pick is testable without a TTY. */
  select?: (config: { message: string; default?: string; choices: Array<{ name: string; value: string }> }) => Promise<string>;
} = {}): Promise<boolean> {
  const interactive = deps.interactive ?? isInteractiveTerminal();
  if (!interactive) return false;
  if (getConfiguredDefaultProfileName()) return false;
  if (await getAutoDetectedProfile()) return false;
  const installed = listInstalledBrowsers();
  if (installed.length === 0) return false;

  const config = {
    message: 'Which browser should agents drive on THIS machine?',
    default: defaultBrowserChoice(installed) ?? SKIP,
    choices: [
      ...installed.map((b) => ({ name: `${b.browserType}  ${chalk.dim(b.binary)}`, value: b.browserType })),
      { name: `None ${chalk.dim('— this box uses the fleet hub (agents config set browser.device <host>)')}`, value: SKIP },
    ],
  };
  // The prompt is the only non-testable boundary here, so it is injectable —
  // everything after (createProfile, setConfigValue) runs for real.
  let picked: string;
  if (deps.select) {
    picked = await deps.select(config);
  } else {
    const { select } = await import('@inquirer/prompts');
    picked = await select<string>(config);
  }
  if (picked === SKIP) return false;

  const chosen = installed.find((b) => b.browserType === picked) ?? installed[0];
  const freePort = await findFreeProfilePort();
  const profile: BrowserProfile = {
    name: DEFAULT_BROWSER_PROFILE_NAME,
    description: `${chosen.browserType} profile (chosen during setup)`,
    browser: chosen.browserType,
    binary: chosen.binary,
    endpoints: [`cdp://127.0.0.1:${freePort}`],
    viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
  };
  await createProfile(profile);
  // The same key `agents browser use` writes (device-local).
  setConfigValue('browser.profile', profile.name);
  console.log(
    chalk.green(`Browser: '${chosen.browserType}'`) +
      chalk.dim(` — profile "${profile.name}" is this machine's default (agents browser use to change).`),
  );
  return true;
}

/**
 * The bare-`agents setup` preferences step: interactive host, then browser.
 * Runs AFTER the capability hub so it never delays the bootstrap. Never
 * throws — a prompt cancel or a failed pick ends the step quietly and lets
 * setup complete (the same semantics as the capability hub).
 */
export async function runPreferencesStep(): Promise<void> {
  if (!isInteractiveTerminal()) return;
  try {
    const pickedHost = await maybePickInteractiveHost();
    const pickedBrowser = await maybePickBrowserProfile();
    if (pickedHost || pickedBrowser) console.log();
  } catch {
    // Cancel (ctrl-c) or a picker failure — the step is optional; end it.
  }
}
