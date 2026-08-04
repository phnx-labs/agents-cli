/**
 * Install + lifecycle for the macOS menu-bar helper (`MenubarHelper.app`).
 *
 * Mirrors `src/lib/secrets/install-helper.ts` (stable Application Support path,
 * survives npm re-sign) and the secrets-agent launchd pattern in
 * `src/lib/secrets/agent.ts` (RunAtLoad + KeepAlive user service).
 *
 * The helper is a no-Dock `.accessory` status-bar app. It reads live agent
 * state directly from disk and shells `agents` only for actions, so the plist
 * bakes in the node interpreter + entry point + bin path so the GUI process can
 * find the CLI without a login PATH.
 *
 * Opt-out is sticky: `agents menubar disable` drops a sentinel that the upgrade
 * migration (`installMenubarLaunchAgent` in migrate.ts) honors, so a disabled
 * menu bar never silently comes back on the next release.
 */

import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sleepSync } from '../fs-atomic.js';
import { getRuntimeStateDir, getHelpersDir } from '../state.js';
import { getCliVersion, resolveAgentsBin, resolveInstalledLayout } from '../version.js';
import { copyAppBundle, withInstallLock } from '../app-bundle-install.js';

const APP_BUNDLE_NAME = 'MenubarHelper.app';
const INSTALL_DIR_NAME = 'agents-cli';
const SERVICE_LABEL = 'com.phnx-labs.agents-menubar';

/**
 * Minimum seconds between launchd restarts of the helper (`ThrottleInterval`).
 *
 * The helper can crash at startup on a loaded machine: `NSApplication.shared`
 * segfaults inside `SLSNewConnection` when WindowServer is too starved to hand
 * out a connection. With `KeepAlive` and no throttle, launchd relaunches on its
 * 10s default, and each attempt spawns a fresh `agents doctor --json` before
 * dying — so a starved box gets hit harder the worse it gets. 30s bounds that
 * respawn rate while staying well inside "the menu bar came back on its own".
 *
 * This only paces the restarts. What actually stops the pile-up is the helper
 * bounding and group-killing its own children (menubar/Sources/MenubarHelper/
 * ChildProcess.swift); the two are complementary, not alternatives.
 */
const MENUBAR_THROTTLE_SECONDS = 30;

function onDarwin(): boolean {
  return process.platform === 'darwin';
}

/** ~/Library/Application Support/agents-cli */
function installDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', INSTALL_DIR_NAME);
}

/** ~/Library/Application Support/agents-cli/MenubarHelper.app */
function installedAppPath(): string {
  return path.join(installDir(), APP_BUNDLE_NAME);
}

/**
 * Version stamp written next to the installed bundle. The upgrade self-heal
 * compares this against the running CLI's version to decide whether the App
 * Support copy + plist need to be rebuilt — without it, a `npm update` refreshes
 * dist/index.js but leaves the menu bar running the OLD helper binary and a
 * plist whose baked paths may have drifted.
 */
function installedVersionMarkerPath(): string {
  return path.join(installDir(), '.menubar-version');
}

function readInstalledMenubarVersion(): string | null {
  try {
    return fs.readFileSync(installedVersionMarkerPath(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/** Executable inside the installed bundle. */
function installedExecutablePath(): string {
  return path.join(installedAppPath(), 'Contents', 'MacOS', 'MenubarHelper');
}

/**
 * Absolute path to the installed MenubarHelper executable if it exists on disk,
 * else null. The desktop notifier (notify-desktop.ts) routes daemon
 * notifications through this one-shot (`MenubarHelper --notify ...`) so they
 * carry the agents-cli mark rather than the generic osascript icon. Null on
 * non-darwin or when the helper is not installed (menu bar disabled, a Linux
 * package, or a dev checkout without a built bundle).
 */
export function resolveInstalledMenubarExecutable(): string | null {
  if (!onDarwin()) return null;
  const exec = installedExecutablePath();
  return fs.existsSync(exec) ? exec : null;
}

/** ~/Library/LaunchAgents/com.phnx-labs.agents-menubar.plist */
function servicePlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

/** Sticky opt-out marker written by `agents menubar disable`. */
function disabledSentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'menubar.disabled');
}

/** True if the user explicitly disabled the menu bar (don't auto-enable on upgrade). */
export function menubarDisabledByUser(): boolean {
  return fs.existsSync(disabledSentinelPath());
}

/** True if the launchd plist for the menu-bar service is installed. */
export function menubarServiceInstalled(): boolean {
  return onDarwin() && fs.existsSync(servicePlistPath());
}

/**
 * Locate the source `.app` shipped alongside the compiled JS.
 *   1. dist/lib/menubar/MenubarHelper.app — npm install layout (sibling of this file)
 *   2. <repo>/bin/MenubarHelper.app       — raw working tree (tsx/dev)
 *   3. apps/cli/menubar/dist/MenubarHelper.app — fresh local build
 *   4. <on-disk install>/dist/lib/menubar/MenubarHelper.app — Bun single-file
 *      binary: `import.meta.url` is a virtual `/$bunfs/` path, so the sibling
 *      candidates above can't see the on-disk bundle; recover it via the
 *      `agents` launcher symlink.
 */
function sourceAppPath(): string | null {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, APP_BUNDLE_NAME));
    candidates.push(path.resolve(here, '..', '..', '..', 'bin', APP_BUNDLE_NAME));
    candidates.push(
      path.resolve(here, '..', '..', '..', 'menubar', 'dist', APP_BUNDLE_NAME)
    );
  } catch {
    /* import.meta.url unavailable */
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Candidate 4 — only reached when the sibling candidates miss (the Bun
  // single-file binary, whose `import.meta.url` is a virtual `/$bunfs/` path).
  // Resolve the launcher symlink lazily so the common Node path pays no extra
  // filesystem probe.
  const layout = resolveInstalledLayout();
  if (layout) {
    const p = path.join(layout.distDir, 'lib', 'menubar', APP_BUNDLE_NAME);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Resolve the compiled CLI entry (dist/index.js) so the helper can exec node directly. */
function resolveCliEntry(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/lib/menubar/install-menubar.js -> dist/index.js
    const entry = path.resolve(here, '..', '..', 'index.js');
    if (fs.existsSync(entry)) return entry;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Register the freshly-installed bundle with LaunchServices.
 *
 * The helper is copied to ~/Library/Application Support (not /Applications) and
 * launched only via launchd, so LaunchServices may never discover it on its own.
 * A daemon notification posted by the one-shot `MenubarHelper --notify` process is
 * attributed to this bundle, and macOS resolves the notification's LEFT-hand app
 * icon from the bundle's LaunchServices record — so a bundle LS doesn't know about
 * shows a blank app icon there (the right-hand contentImage is unaffected;
 * appIconImage reads the `.icns` directly). `lsregister -f` registers the bundle at
 * its current path so the OS can resolve its AppIcon for that slot. Best-effort:
 * LaunchServices is advisory, and a failure here must never block install.
 */
function refreshBundleIconRegistration(appPath: string): void {
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
  const bin = fs.existsSync(lsregister) ? lsregister : 'lsregister';
  const r = spawnSync(bin, ['-f', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (r.error) {
    /* lsregister missing / moved — advisory only, ignore. */
  }
}

/** True when the bundle carries a signature the kernel will accept at launch. */
export function codesignVerifies(appPath: string): boolean {
  const r = spawnSync('codesign', ['--verify', '--strict', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

/**
 * True when Gatekeeper will let the bundle execute on this machine.
 * A Developer-ID-signed but un-notarized app is rejected by `spctl --assess`,
 * which macOS surfaces as "the app is damaged" and can crash AppKit during
 * launch. This is separate from `codesign --verify`: a signature can be valid
 * while Gatekeeper still refuses to run it. The release notarizes + staples the
 * helper (menubar/scripts/build.sh, gated by verify-menubar-helper.sh), so a
 * shipped bundle passes this; the launch guards use it to fail loud rather than
 * bootstrap a helper macOS would reject.
 */
export function gatekeeperAssesses(appPath: string): boolean {
  const r = spawnSync('spctl', ['--assess', '--type', 'exec', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

/** True when the bundle carries a Developer ID TeamIdentifier (not ad-hoc). */
export function hasDeveloperIdSignature(appPath: string): boolean {
  const r = spawnSync('codesign', ['-dv', '--verbose=4', appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const out = `${r.stderr || ''}${r.stdout || ''}`;
  const team = out.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1];
  return Boolean(team && team !== 'not set');
}

/**
 * Copy the bundled `.app` to the stable user path (idempotent unless forced).
 * Returns the installed executable path, or null if no source bundle ships
 * with this install (e.g. Linux package, or a build without the helper).
 *
 * Also heals an older install that was ad-hoc re-signed over a Developer ID
 * source: that unstable identity made Accessibility re-prompt on every upgrade.
 * When the shipped source is Developer ID and the installed copy is only
 * ad-hoc, replace it — even without forceReinstall.
 */
export function ensureMenubarAppInstalled(opts: { forceReinstall?: boolean } = {}): string | null {
  if (!onDarwin()) return null;
  const src = sourceAppPath();
  if (!src) return null;
  const dest = installedAppPath();
  // Heal an older install that was ad-hoc re-signed over a Developer ID source:
  // that unstable identity made Accessibility re-prompt on every upgrade.
  const needsInstall = (): boolean => {
    if (opts.forceReinstall) return true;
    if (!fs.existsSync(dest)) return true;
    return hasDeveloperIdSignature(src) && !hasDeveloperIdSignature(dest);
  };
  // Fast path: nothing to do.
  if (!needsInstall()) return installedExecutablePath();
  // Serialize the atomic install so concurrent `agents` invocations (this runs
  // on the darwin startup path) don't race the swap or each re-copy — the
  // stampede that transiently corrupted MenubarHelper.app and tripped the
  // "damaged" dialog.
  withInstallLock(dest, () => {
    if (!needsInstall()) return;
    copyAppBundle(src, dest);
    // A fresh copy is exactly when the bundle's icon can be new (first install) or
    // superseded (upgrade) — register it so LaunchServices knows the bundle and can
    // resolve its AppIcon for the left-hand slot of daemon notifications.
    refreshBundleIconRegistration(dest);
  });
  return installedExecutablePath();
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generateServicePlist(execPath: string): string {
  const home = os.homedir();
  const logPath = path.join(getHelpersDir(), 'menubar', 'menubar.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  // Bake interpreter + entry + bin so the GUI helper can reach the CLI with no
  // login PATH. AgentsCLI.swift prefers [AGENTS_NODE, AGENTS_ENTRY] when both
  // exist, else falls back to AGENTS_BIN, else probes well-known paths.
  const env: Record<string, string> = {
    PATH: `/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${path.dirname(process.execPath)}:${home}/.local/bin`,
  };
  const node = process.execPath;
  const entry = resolveCliEntry();
  const bin = resolveAgentsBin();
  if (node && entry) {
    env.AGENTS_NODE = node;
    env.AGENTS_ENTRY = entry;
  }
  if (bin) env.AGENTS_BIN = bin;

  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(execPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${MENUBAR_THROTTLE_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>`;
}

/**
 * Restart the menu-bar launchd agent from a clean state.
 *
 * Always `bootout` first: on modern macOS `bootstrap` fails when the job is
 * already bootstrapped, and the deprecated `load -w` fallback is unreliable.
 * A prior WindowServer disconnect can leave the job throttled so that a plain
 * `kickstart -k` does not bring it back; booting it out and bootstrapping fresh
 * is the only sequence that reliably re-attaches the status item.
 */
export function restartMenubarLaunchAgent(
  uid: number,
  plist: string,
  exec: (cmd: string, args: readonly string[], opts: { stdio: ['ignore', 'ignore', 'ignore'] }) => Buffer = execFileSync,
): void {
  const serviceTarget = `gui/${uid}/${SERVICE_LABEL}`;
  const opts: { stdio: ['ignore', 'ignore', 'ignore'] } = { stdio: ['ignore', 'ignore', 'ignore'] };
  try { exec('launchctl', ['bootout', serviceTarget], opts); } catch { /* may not be loaded */ }
  try { exec('launchctl', ['bootstrap', `gui/${uid}`, plist], opts); } catch { /* best effort */ }
  try { exec('launchctl', ['kickstart', serviceTarget], opts); } catch { /* best effort */ }
}

/**
 * Install + start the menu-bar helper as a launchd user service (idempotent).
 * Clears the sticky opt-out, installs the .app, writes the plist, and
 * bootstraps it into the GUI domain. Returns false on non-darwin or when no
 * helper bundle ships with this install.
 */
export function enableMenubarService(opts: { clearOptOut?: boolean } = { clearOptOut: true }): boolean {
  if (!onDarwin()) return false;
  const exec = ensureMenubarAppInstalled({ forceReinstall: true });
  if (!exec) return false;

  // Never bootstrap a helper macOS will reject at launch: an invalid signature
  // under launchd KeepAlive crash-loops forever, and an un-notarized bundle is
  // rejected by Gatekeeper as "damaged". A shipped helper is Developer-ID signed
  // AND notarized (release build + the verify-menubar-helper.sh prepack gate), so
  // this passes; if it ever doesn't, skip the service and point at the upgrade
  // rather than re-signing over it (an ad-hoc re-sign never satisfies Gatekeeper).
  if (!(codesignVerifies(installedAppPath()) && gatekeeperAssesses(installedAppPath()))) {
    process.stderr.write(
      'agents: AGI Menu is not notarized/valid on this machine; skipping launch. ' +
      'Upgrade to a notarized build (npm i -g @phnx-labs/agents-cli), then `agents menubar setup`.\n'
    );
    return false;
  }

  if (opts.clearOptOut) clearMenubarOptOut();
  installAndStartService(exec);
  return true;
}

/** Drop the sticky `agents menubar disable` sentinel. */
function clearMenubarOptOut(): void {
  try { fs.rmSync(disabledSentinelPath(), { force: true }); } catch { /* already gone */ }
}

/**
 * Write the launchd plist for `exec`, restart the job, and stamp the installed
 * version. Shared by `enableMenubarService` and `runMenubarSetup` so the two
 * cannot drift on what "installed and started" means — the version stamp in
 * particular is what the upgrade self-heal reads to decide staleness, and a
 * path that skipped it would make every later `agents` invocation reinstall.
 */
function installAndStartService(exec: string): void {
  const plist = servicePlistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, generateServicePlist(exec));
  restartMenubarLaunchAgent(process.getuid?.() ?? 0, plist);
  try { fs.writeFileSync(installedVersionMarkerPath(), getCliVersion()); } catch { /* best effort */ }
}

/**
 * Pure staleness decision (no I/O) so the truth table is unit-testable. The
 * installed service is stale when the helper binary is gone, or when it was
 * installed by a different CLI version than the one now running — a version
 * change is the signal that the plist's baked interpreter/entry/bundle paths
 * and the helper binary itself may have drifted. A null installedVersion
 * (pre-stamp install) counts as stale so old installs get re-stamped once.
 */
export function isMenubarStale(opts: {
  installedVersion: string | null;
  currentVersion: string;
  execExists: boolean;
}): boolean {
  if (!opts.execExists) return true;
  return opts.installedVersion !== opts.currentVersion;
}

function menubarSetupStale(): boolean {
  return isMenubarStale({
    installedVersion: readInstalledMenubarVersion(),
    currentVersion: getCliVersion(),
    execExists: fs.existsSync(installedExecutablePath()),
  });
}

/**
 * Pure re-point decision (no I/O): the plist's baked interpreter/entry no longer
 * match the install that is now running `agents`. This catches DUAL-INSTALL skew
 * that a version bump can't — e.g. the plist was baked by an nvm copy but the
 * user's `agents` now resolves to a bun copy (same or different version), so the
 * helper keeps shelling the stale install for its menu data AND the quick-issue
 * dispatch. A null active entry (a dev/tsx run where the compiled entry can't be
 * resolved) never triggers a re-point, so it can't churn the plist onto a
 * transient path.
 */
export function menubarPlistNeedsRepoint(opts: {
  plistEntry: string | null;
  plistNode: string | null;
  activeEntry: string | null;
  activeNode: string | null;
}): boolean {
  if (!opts.activeEntry) return false; // can't resolve the running install — don't churn
  if (opts.plistEntry !== opts.activeEntry) return true;
  if (opts.activeNode && opts.plistNode !== opts.activeNode) return true;
  return false;
}

/** Read one EnvironmentVariables value from the installed service plist. */
function readPlistEnvValue(key: string): string | null {
  try {
    const xml = fs.readFileSync(servicePlistPath(), 'utf-8');
    const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** True when the installed plist points at a different install than the active one. */
function menubarSetupNeedsRepoint(): boolean {
  return menubarPlistNeedsRepoint({
    plistEntry: readPlistEnvValue('AGENTS_ENTRY'),
    plistNode: readPlistEnvValue('AGENTS_NODE'),
    activeEntry: resolveCliEntry(),
    activeNode: process.execPath,
  });
}

/**
 * Stop + remove the menu-bar service and write the sticky opt-out so the
 * upgrade migration won't re-enable it.
 */
export function disableMenubarService(): void {
  if (!onDarwin()) return;
  const plist = servicePlistPath();
  const uid = process.getuid?.() ?? 0;
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: ['ignore', 'ignore', 'ignore'] }); }
  catch { try { execFileSync('launchctl', ['unload', '-w', plist], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* not loaded */ } }
  try { fs.unlinkSync(plist); } catch { /* already gone */ }
  try {
    fs.mkdirSync(path.dirname(disabledSentinelPath()), { recursive: true });
    fs.writeFileSync(disabledSentinelPath(), `disabled ${new Date().toISOString()}\n`);
  } catch { /* best effort */ }
}

/**
 * Startup self-heal, run on every darwin CLI invocation (see src/index.ts).
 * No-ops cheaply (a couple of existsSync + a tiny file read) unless work is
 * needed:
 *   - fresh install (no service yet)      -> enable
 *   - upgrade (version stamp changed) or  -> re-enable: recopy the new helper
 *     the App Support helper went missing     binary + rewrite the plist + kick
 *
 * Without the staleness re-enable, `npm update` refreshed the CLI but left the
 * menu bar running the previous release's helper binary on a possibly-stale
 * plist. No-ops if: not darwin, the user opted out, or no helper bundle ships.
 * Best-effort — never throws into startup.
 */
export function installMenubarLaunchAgentOnUpgrade(): void {
  try {
    if (!onDarwin()) return;
    if (menubarDisabledByUser()) return;
    if (!sourceAppPath()) return;
    if (!menubarServiceInstalled()) {
      enableMenubarService({ clearOptOut: false });
      return;
    }
    // Re-enable (recopy helper + rewrite plist) when the version drifted OR the
    // plist's baked interpreter/entry no longer point at the install now running
    // `agents` — the dual-install skew a version bump alone can't catch — OR the
    // installed copy is still ad-hoc while the shipped source is Developer ID
    // (older heal path; Accessibility re-prompts until the identity is restored).
    if (menubarSetupStale() || menubarSetupNeedsRepoint() || installedNeedsDevIdHeal()) {
      enableMenubarService({ clearOptOut: false });
    }
  } catch {
    /* never block startup on the menu bar */
  }
}

/** True when App Support still has an ad-hoc copy but the npm bundle is Developer ID. */
function installedNeedsDevIdHeal(): boolean {
  const src = sourceAppPath();
  if (!src || !fs.existsSync(installedAppPath())) return false;
  if (hasDeveloperIdSignature(installedAppPath())) return false;
  return hasDeveloperIdSignature(src);
}

/** One step of `agents menubar setup`, and how it came out. */
export interface SetupStep {
  /** What was configured. */
  name: string;
  /** `ok` — already correct or now correct; `changed` — this run fixed it;
   *  `failed` — could not be configured (setup reports and exits nonzero). */
  outcome: 'ok' | 'changed' | 'failed';
  detail: string;
}

export interface SetupResult {
  steps: SetupStep[];
  /** Every step landed on `ok`/`changed` and exactly one helper is running. */
  configured: boolean;
  status: MenubarStatus;
}

/**
 * Decide which live helper processes must be ended so exactly one status item
 * survives. Pure so the choice is unit-testable without a live menu bar.
 *
 * EVERY current process is ended, including the wanted one: the caller
 * re-kickstarts the launchd service straight after, so the survivor is the one
 * launchd owns (RunAtLoad + KeepAlive), not whichever copy happened to win a
 * race. Picking a survivor from a `ps` listing cannot do this — the list says
 * nothing about which pid launchd will keep alive, so leaving one alive risks
 * keeping the un-managed copy and re-creating the duplicate on next login.
 */
export function processesToEnd(status: Pick<MenubarStatus, 'instances' | 'foreignInstances'>): MenubarProcess[] {
  return [...status.instances, ...status.foreignInstances];
}

function endProcess(pid: number): void {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * `agents menubar setup` — configure the menu bar end-to-end, idempotently.
 *
 * The one command that gets a machine to the intended state: exactly one status
 * item, owned by a launchd service that starts it at login and restarts it if it
 * dies. Each concern is a reported step, so a partial failure names itself
 * instead of hiding behind "enabled".
 *
 *   1. bundle      — install/refresh the .app at the stable App Support path
 *   2. signature   — a valid code identity (macOS 26+ SIGKILLs an invalid one)
 *   3. duplicates  — end every live helper, so the only survivor is launchd's
 *   4. login item  — write the plist (RunAtLoad + KeepAlive) and bootstrap it
 *   5. single      — verify exactly one helper came back up
 */
export function runMenubarSetup(): SetupResult {
  const steps: SetupStep[] = [];
  const step = (name: string, outcome: SetupStep['outcome'], detail: string) => {
    steps.push({ name, outcome, detail });
  };

  if (!onDarwin()) {
    step('platform', 'failed', `AGI Menu is macOS only (this is ${process.platform})`);
    return { steps, configured: false, status: getMenubarStatus() };
  }

  const before = getMenubarStatus();

  if (!sourceAppPath()) {
    step('bundle', 'failed', 'no AGI Menu bundle ships with this install');
    return { steps, configured: false, status: before };
  }

  // 3 before 1: end the running copies BEFORE swapping the bundle underneath
  // them, so no helper keeps a status item alive on a binary that no longer
  // exists on disk.
  const doomed = processesToEnd(before);
  for (const p of doomed) endProcess(p.pid);
  if (doomed.length > 1) {
    step('duplicates', 'changed',
      `ended ${doomed.length} running helpers (${doomed.map((p) => p.pid).join(', ')}) — launchd restarts exactly one`);
  } else if (doomed.length === 1) {
    step('duplicates', 'ok', 'one helper was running; restarting it under launchd');
  } else {
    step('duplicates', 'ok', 'no helper was running');
  }

  const exec = ensureMenubarAppInstalled({ forceReinstall: true });
  if (!exec) {
    step('bundle', 'failed', 'could not install the helper bundle');
    return { steps, configured: false, status: getMenubarStatus() };
  }
  step('bundle', before.installedVersion === getCliVersion() ? 'ok' : 'changed',
    `${installedAppPath()} (${getCliVersion()})`);

  if (!(codesignVerifies(installedAppPath()) && gatekeeperAssesses(installedAppPath()))) {
    step('signature', 'failed',
      'not notarized/valid on this machine — refusing to start it (Gatekeeper rejects an ' +
      'un-notarized helper as "damaged"). Upgrade to a notarized build of agents-cli.');
    return { steps, configured: false, status: getMenubarStatus() };
  }
  step('signature', 'ok', 'valid + notarized');

  // Clear the sticky opt-out: running `setup` is an explicit request for the
  // menu bar, so a stale `menubar disable` must not silently win.
  clearMenubarOptOut();

  installAndStartService(exec);
  step('login item', before.serviceInstalled ? 'ok' : 'changed',
    `${SERVICE_LABEL} — starts at login, restarts if it dies`);

  // launchd's bootstrap+kickstart is asynchronous; give the status item a beat
  // to claim the lock before counting instances, or `setup` reports zero on a
  // machine that is in fact coming up correctly.
  const after = waitForSingleInstance();
  if (after.instances.length === 1 && after.foreignInstances.length === 0) {
    step('single instance', 'ok', `pid ${after.instances[0].pid}`);
  } else if (after.instances.length === 0) {
    step('single instance', 'failed', 'the helper did not come back up — see `agents menubar status`');
  } else {
    const extra = [...after.instances.slice(1), ...after.foreignInstances];
    step('single instance', 'failed',
      `${after.instances.length + after.foreignInstances.length} helpers running (${extra.map((p) => p.pid).join(', ')} are extra)`);
  }

  return {
    steps,
    configured: steps.every((s) => s.outcome !== 'failed'),
    status: after,
  };
}

/**
 * Poll (up to ~3s) for launchd to bring the single helper back. Returns the
 * last status read either way — the caller decides what a miss means.
 */
function waitForSingleInstance(): MenubarStatus {
  let status = getMenubarStatus();
  for (let i = 0; i < 15 && status.instances.length !== 1; i++) {
    sleepSync(200);
    status = getMenubarStatus();
  }
  return status;
}

/** A live MenubarHelper process: its pid and the executable it is running. */
export interface MenubarProcess {
  pid: number;
  executable: string;
}

/** Parse `ps -axo pid=,<field>=` into pid -> field. The field is the rest of the
 *  line, so a path containing spaces (App Support does) survives intact. */
function parsePsLines(psOutput: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

/**
 * Split the live MenubarHelper processes into the installed bundle's own
 * (`own`) and every other copy (`foreign`).
 *
 * `pgrep -f MenubarHelper` conflated the two, so a stray dev build could hold
 * the global Cmd-Shift-V chord (RegisterEventHotKey is first-come) while status
 * still reported a healthy `running: yes` — the paste was dead and nothing said
 * so. A foreign copy is the thing to look for, so name it.
 *
 * `own` is a LIST, not a boolean: two copies of the INSTALLED bundle can run at
 * once (launchd's KeepAlive service plus a LaunchServices/`open` launch of the
 * same .app), which is the duplicate the user actually sees — two agents marks
 * in the menu bar. Collapsing them to `running: true` reported that state as
 * healthy. The helper now refuses to be the second (SingleInstance.swift), and
 * `agents menubar setup` ends any duplicate a pre-fix helper left behind.
 *
 * Identity comes from `comm` (the resolved executable), never from a substring
 * of the command line: matching the latter flags any shell that merely mentions
 * MenubarHelper. `command` is consulted only to drop `--notify` one-shots.
 */
export function classifyMenubarProcesses(
  commOutput: string,
  commandOutput: string,
  installedExec: string,
): { own: MenubarProcess[]; foreign: MenubarProcess[] } {
  const commands = parsePsLines(commandOutput);
  const own: MenubarProcess[] = [];
  const foreign: MenubarProcess[] = [];
  for (const [pid, executable] of parsePsLines(commOutput)) {
    if (path.basename(executable) !== 'MenubarHelper') continue;
    // `--notify` is a one-shot that posts a notification and exits; it runs the
    // installed binary but never claims the status item or the chords.
    if ((commands.get(pid) || '').includes('--notify')) continue;
    if (executable === installedExec) own.push({ pid, executable });
    else foreign.push({ pid, executable });
  }
  return { own, foreign };
}

export interface MenubarStatus {
  platform: string;
  source: string | null;
  installedApp: string | null;
  installedVersion: string | null;
  currentVersion: string;
  stale: boolean;
  serviceInstalled: boolean;
  running: boolean;
  /** Live processes of the INSTALLED bundle. More than one is the duplicate. */
  instances: MenubarProcess[];
  /** Live MenubarHelper processes that are NOT the installed bundle. */
  foreignInstances: MenubarProcess[];
  disabledByUser: boolean;
}

/** Live MenubarHelper processes, split by whether they are the installed bundle. */
function liveMenubarProcesses(): { own: MenubarProcess[]; foreign: MenubarProcess[] } {
  if (!onDarwin()) return { own: [], foreign: [] };
  const ps = (format: string) =>
    spawnSync('ps', ['-axo', format], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
  const comm = ps('pid=,comm=');
  const command = ps('pid=,command=');
  if (comm.status !== 0 || command.status !== 0) return { own: [], foreign: [] };
  return classifyMenubarProcesses(comm.stdout || '', command.stdout || '', installedExecutablePath());
}

export function getMenubarStatus(): MenubarStatus {
  const dest = installedAppPath();
  const { own, foreign } = liveMenubarProcesses();
  const serviceInstalled = menubarServiceInstalled();
  return {
    platform: process.platform,
    source: sourceAppPath(),
    installedApp: fs.existsSync(dest) ? dest : null,
    installedVersion: readInstalledMenubarVersion(),
    currentVersion: getCliVersion(),
    stale: onDarwin() && serviceInstalled && menubarSetupStale(),
    serviceInstalled,
    running: own.length > 0,
    instances: own,
    foreignInstances: foreign,
    disabledByUser: menubarDisabledByUser(),
  };
}
