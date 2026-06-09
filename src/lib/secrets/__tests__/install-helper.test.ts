/**
 * Behavioral tests for the keychain helper installer.
 *
 * These run against the real signed bundle at <repo>/bin/Agents CLI.app and
 * the real `codesign` binary, redirecting the install destination via $HOME
 * (os.homedir() reads it per call). They are skipped on non-darwin and on
 * checkouts without the locally built helper bundle (bin/ is gitignored), so
 * they execute on dev and release machines, not on Linux CI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ensureKeychainHelperInstalled, getKeychainHelperPath, setInstallRootForTest } from '../install-helper.js';

const SOURCE_APP = path.join(process.cwd(), 'bin', 'Agents CLI.app');
const SOURCE_EXEC = path.join(SOURCE_APP, 'Contents', 'MacOS', 'Agents CLI');
const skip = process.platform !== 'darwin' || !fs.existsSync(SOURCE_EXEC);

const sha256 = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

describe.skipIf(skip)('keychain helper staleness reinstall', () => {
  let tmpHome: string;
  let installedExec: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-helper-test-'));
    setInstallRootForTest(tmpHome);
    installedExec = path.join(
      tmpHome, 'Library', 'Application Support', 'agents-cli', 'Agents CLI.app', 'Contents', 'MacOS', 'Agents CLI'
    );
  });

  afterEach(() => {
    setInstallRootForTest(null);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('installs the bundled helper on first use', () => {
    ensureKeychainHelperInstalled();
    expect(fs.existsSync(installedExec)).toBe(true);
    expect(sha256(installedExec)).toBe(sha256(SOURCE_EXEC));
  });

  it('replaces a stale helper even when its signature still verifies', () => {
    // Reproduce the 1.20.4 incident shape: the installed helper differs from
    // the bundled one but passes `codesign --verify`. Re-signing ad-hoc
    // rewrites the executable's embedded signature blob, so the binary's
    // bytes diverge from the bundled source while the bundle still verifies
    // — exactly like an old validly-signed helper left behind by a previous
    // CLI version. Before the staleness check, the installer's "exists and
    // verifies" early-return kept such a helper forever.
    ensureKeychainHelperInstalled();
    const installedApp = path.dirname(path.dirname(path.dirname(installedExec)));
    const resign = spawnSync('codesign', ['--sign', '-', '--force', '--deep', installedApp], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
    });
    expect(resign.status).toBe(0);
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', installedApp], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
    });
    expect(verify.status).toBe(0);
    expect(sha256(installedExec)).not.toBe(sha256(SOURCE_EXEC));

    const helperPath = getKeychainHelperPath();

    expect(helperPath).toBe(installedExec);
    expect(sha256(installedExec)).toBe(sha256(SOURCE_EXEC));
  });

  it('leaves a healthy install untouched', () => {
    ensureKeychainHelperInstalled();
    const before = fs.statSync(installedExec).mtimeMs;
    ensureKeychainHelperInstalled();
    getKeychainHelperPath();
    expect(fs.statSync(installedExec).mtimeMs).toBe(before);
  });
});
