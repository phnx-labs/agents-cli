/**
 * Stable install location for the signed macOS Keychain helper.
 *
 * Why a stable path: every npm publish re-signs `Agents CLI.app` with a fresh
 * timestamp, producing a new code signature. macOS Keychain trusted-app ACLs
 * are pinned to the exact signature, so the ACL invalidates on every release
 * when the helper lives inside the npm package directory. Copying the .app
 * once to `~/Library/Application Support/agents-cli/` gives it a path that
 * survives `npm i -g`, `scripts/install.sh`, version bumps, etc.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the helper path. Other
 * modules in `src/lib/secrets/` must import `getKeychainHelperPath()` rather
 * than recomputing it.
 */

import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const APP_BUNDLE_NAME = 'Agents CLI.app';
const INSTALL_DIR_NAME = 'agents-cli';

/** Absolute path to the installed `.app` bundle directory (not the executable). */
function installedAppPath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', INSTALL_DIR_NAME, APP_BUNDLE_NAME);
}

/** Absolute path to the executable inside the installed `.app` bundle. */
function installedExecutablePath(): string {
  return path.join(installedAppPath(), 'Contents', 'MacOS', 'Agents CLI');
}

/**
 * Locate the source `.app` bundle shipped alongside the compiled JS.
 *
 * Resolution order:
 *   1. dist/lib/secrets/Agents CLI.app — sibling of this compiled file (npm install layout)
 *   2. <repo>/bin/Agents CLI.app       — raw working tree (`bun run dev`, tsx from src/)
 *
 * Throws if neither exists.
 */
function sourceAppPath(): string {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, APP_BUNDLE_NAME));
    // tsx/src case: src/lib/secrets/install-helper.ts -> ../../../bin/Agents CLI.app
    candidates.push(path.resolve(here, '..', '..', '..', 'bin', APP_BUNDLE_NAME));
  } catch { /* import.meta.url unavailable */ }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Source ${APP_BUNDLE_NAME} not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
    'The npm package may have been built without the signed helper bundle. Reinstall agents-cli.'
  );
}

function assertDarwin(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain helper is macOS only.');
  }
}

function codesignVerify(appPath: string): { ok: boolean; output: string } {
  const r = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return { ok: r.status === 0, output: (r.stderr || r.stdout || '').toString().trim() };
}

function spctlAssess(appPath: string): { ok: boolean; output: string } {
  const r = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return { ok: r.status === 0, output: (r.stderr || r.stdout || '').toString().trim() };
}

function copyAppBundle(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  // `cp -R` preserves the bundle's signature, symlinks, and resource forks.
  // `fs.cpSync({recursive: true})` works on simple trees but has historically
  // mishandled extended attributes on `.app` bundles, breaking codesign.
  const r = spawnSync('cp', ['-R', src, dest], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').toString().trim();
    throw new Error(`Failed to copy ${src} -> ${dest}: ${msg || 'unknown error'}`);
  }
}

/**
 * Idempotent install. Copies the bundled `.app` to the stable user path. Skips
 * if the destination already exists and `codesign --verify` passes, unless
 * `forceReinstall=true`.
 *
 * Notarization is checked via `spctl --assess` after install — a failure is
 * logged as a warning but does NOT throw. Notarization checks require network
 * access (Gatekeeper ticket lookup) and are not load-bearing for the helper's
 * keychain ACL semantics.
 */
export function ensureKeychainHelperInstalled(opts: { forceReinstall?: boolean } = {}): void {
  assertDarwin();
  const dest = installedAppPath();
  if (!opts.forceReinstall && fs.existsSync(dest)) {
    const { ok } = codesignVerify(dest);
    if (ok) return;
  }
  const src = sourceAppPath();
  copyAppBundle(src, dest);
  const verify = codesignVerify(dest);
  if (!verify.ok) {
    throw new Error(
      `Installed helper failed codesign verification at ${dest}.\n${verify.output}\n` +
      'The bundle may be corrupted. Try `agents helper install` to reinstall, or reinstall agents-cli.'
    );
  }
  const assess = spctlAssess(dest);
  if (!assess.ok) {
    // Warn, do not fail. Gatekeeper ticket lookup needs network; offline
    // installs and CI runners commonly fail this check. The ACL semantics
    // we care about depend on codesign, not spctl.
    process.stderr.write(
      `agents-cli: notarization check (spctl) did not pass for ${dest}: ${assess.output}\n`
    );
  }
}

/**
 * Return the absolute path to the helper executable. If the installed bundle
 * is missing, performs a lazy install first.
 *
 * Throws on non-darwin.
 */
export function getKeychainHelperPath(): string {
  assertDarwin();
  const exec = installedExecutablePath();
  if (!fs.existsSync(exec)) {
    ensureKeychainHelperInstalled();
  }
  return exec;
}

/** Diagnostic snapshot used by `agents helper status`. */
export interface KeychainHelperStatus {
  source: string | null;
  destination: string;
  installed: boolean;
  codesignOk: boolean;
  codesignOutput: string;
  spctlOk: boolean;
  spctlOutput: string;
}

export function getKeychainHelperStatus(): KeychainHelperStatus {
  assertDarwin();
  const destApp = installedAppPath();
  let src: string | null = null;
  try { src = sourceAppPath(); } catch { /* missing source is reported as null */ }
  const installed = fs.existsSync(destApp);
  if (!installed) {
    return {
      source: src,
      destination: destApp,
      installed: false,
      codesignOk: false,
      codesignOutput: 'not installed',
      spctlOk: false,
      spctlOutput: 'not installed',
    };
  }
  const cs = codesignVerify(destApp);
  const sp = spctlAssess(destApp);
  return {
    source: src,
    destination: destApp,
    installed: true,
    codesignOk: cs.ok,
    codesignOutput: cs.output || 'ok',
    spctlOk: sp.ok,
    spctlOutput: sp.output || 'ok',
  };
}
