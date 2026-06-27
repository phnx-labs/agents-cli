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
import { getRuntimeStateDir, getHelpersDir } from '../state.js';

const APP_BUNDLE_NAME = 'MenubarHelper.app';
const INSTALL_DIR_NAME = 'agents-cli';
const SERVICE_LABEL = 'com.phnx-labs.agents-menubar';

function onDarwin(): boolean {
  return process.platform === 'darwin';
}

/** ~/Library/Application Support/agents-cli/MenubarHelper.app */
function installedAppPath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', INSTALL_DIR_NAME, APP_BUNDLE_NAME);
}

/** Executable inside the installed bundle. */
function installedExecutablePath(): string {
  return path.join(installedAppPath(), 'Contents', 'MacOS', 'MenubarHelper');
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
 *   3. <repo>/packages/menubar-helper/dist/MenubarHelper.app — fresh local build
 */
function sourceAppPath(): string | null {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, APP_BUNDLE_NAME));
    candidates.push(path.resolve(here, '..', '..', '..', 'bin', APP_BUNDLE_NAME));
    candidates.push(
      path.resolve(here, '..', '..', '..', 'packages', 'menubar-helper', 'dist', APP_BUNDLE_NAME)
    );
  } catch {
    /* import.meta.url unavailable */
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Resolve the `agents` launcher binary on PATH-less GUI processes. */
function resolveAgentsBin(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'agents'),
    '/opt/homebrew/bin/agents',
    '/usr/local/bin/agents',
    path.join(home, '.npm-global', 'bin', 'agents'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try next */
    }
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

function copyAppBundle(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  // `cp -R` preserves the bundle's signature and resource forks (see install-helper.ts).
  const r = spawnSync('cp', ['-R', src, dest], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').toString().trim();
    throw new Error(`Failed to copy ${src} -> ${dest}: ${msg || 'unknown error'}`);
  }
}

/**
 * Copy the bundled `.app` to the stable user path (idempotent unless forced).
 * Returns the installed executable path, or null if no source bundle ships
 * with this install (e.g. Linux package, or a build without the helper).
 */
export function ensureMenubarAppInstalled(opts: { forceReinstall?: boolean } = {}): string | null {
  if (!onDarwin()) return null;
  const src = sourceAppPath();
  if (!src) return null;
  const dest = installedAppPath();
  if (!opts.forceReinstall && fs.existsSync(dest)) return installedExecutablePath();
  copyAppBundle(src, dest);
  return installedExecutablePath();
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateServicePlist(execPath: string): string {
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
 * Install + start the menu-bar helper as a launchd user service (idempotent).
 * Clears the sticky opt-out, installs the .app, writes the plist, and
 * bootstraps it into the GUI domain. Returns false on non-darwin or when no
 * helper bundle ships with this install.
 */
export function enableMenubarService(opts: { clearOptOut?: boolean } = { clearOptOut: true }): boolean {
  if (!onDarwin()) return false;
  const exec = ensureMenubarAppInstalled({ forceReinstall: true });
  if (!exec) return false;

  if (opts.clearOptOut) {
    try { fs.rmSync(disabledSentinelPath(), { force: true }); } catch { /* already gone */ }
  }

  const plist = servicePlistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, generateServicePlist(exec));

  const uid = process.getuid?.() ?? 0;
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    try { execFileSync('launchctl', ['load', '-w', plist], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* may already be loaded */ }
  }
  try { execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE_LABEL}`], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* best effort */ }
  return true;
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
 * Upgrade-time auto-enable. Runs from runMigration() once per sentinel bump.
 * No-ops if: not darwin, the user opted out, no helper bundle ships, or the
 * service is already installed. Best-effort — never throws into migration.
 */
export function installMenubarLaunchAgentOnUpgrade(): void {
  try {
    if (!onDarwin()) return;
    if (menubarDisabledByUser()) return;
    if (menubarServiceInstalled()) return;
    if (!sourceAppPath()) return;
    enableMenubarService({ clearOptOut: false });
  } catch {
    /* never block migration on the menu bar */
  }
}

export interface MenubarStatus {
  platform: string;
  source: string | null;
  installedApp: string | null;
  serviceInstalled: boolean;
  running: boolean;
  disabledByUser: boolean;
}

export function getMenubarStatus(): MenubarStatus {
  const dest = installedAppPath();
  let running = false;
  if (onDarwin()) {
    const r = spawnSync('pgrep', ['-f', 'MenubarHelper'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
    running = r.status === 0 && (r.stdout || '').trim().length > 0;
  }
  return {
    platform: process.platform,
    source: sourceAppPath(),
    installedApp: fs.existsSync(dest) ? dest : null,
    serviceInstalled: menubarServiceInstalled(),
    running,
    disabledByUser: menubarDisabledByUser(),
  };
}
