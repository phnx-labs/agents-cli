#!/usr/bin/env node
/**
 * Copy the bundled `Agents CLI.app` to a stable user-scoped path so its
 * keychain ACLs survive future npm installs/updates.
 *
 * Source:      dist/lib/secrets/Agents CLI.app   (in the installed npm package)
 *              bin/Agents CLI.app                 (in a raw working tree)
 * Destination: ~/Library/Application Support/agents-cli/Agents CLI.app
 *
 * Invoked by scripts/postinstall.js on global install, and by
 * scripts/install.sh for dev installs. Pure Node, no agents-cli imports,
 * so it runs before the package's TS is wired up.
 *
 * macOS only — silently no-ops on other platforms so postinstall stays clean.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const APP_BUNDLE_NAME = 'Agents CLI.app';
const INSTALL_DIR_NAME = 'agents-cli';

function destAppPath() {
  return path.join(os.homedir(), 'Library', 'Application Support', INSTALL_DIR_NAME, APP_BUNDLE_NAME);
}

function findSourceApp() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // From scripts/install-helper.js, look in the installed npm layout first
  // (../dist/lib/secrets/...) then a raw repo layout (../bin/...).
  const candidates = [
    path.resolve(here, '..', 'dist', 'lib', 'secrets', APP_BUNDLE_NAME),
    path.resolve(here, '..', 'bin', APP_BUNDLE_NAME),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function codesignVerify(appPath) {
  const r = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return { ok: r.status === 0, output: (r.stderr || r.stdout || '').toString().trim() };
}

function copyAppBundle(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  const r = spawnSync('cp', ['-R', src, dest], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').toString().trim();
    throw new Error(`Failed to copy ${src} -> ${dest}: ${msg || 'unknown error'}`);
  }
}

function main() {
  if (process.platform !== 'darwin') return;
  const force = process.argv.includes('--force');
  const dest = destAppPath();

  if (!force && fs.existsSync(dest) && codesignVerify(dest).ok) {
    return;
  }

  const src = findSourceApp();
  if (!src) {
    // No source bundle to install. Stay silent during postinstall so we don't
    // create noise on Linux/Windows or on builds that intentionally omit the
    // helper. `agents helper install` surfaces a clearer error if a user
    // actually needs the helper.
    return;
  }

  try {
    copyAppBundle(src, dest);
  } catch (err) {
    process.stderr.write(`agents-cli: failed to install Keychain helper: ${err.message}\n`);
    return;
  }

  const verify = codesignVerify(dest);
  if (!verify.ok) {
    process.stderr.write(
      `agents-cli: installed helper failed codesign verification at ${dest}\n${verify.output}\n`
    );
    return;
  }
  process.stdout.write(`  Installed Keychain helper: ${dest}\n`);
}

main();
