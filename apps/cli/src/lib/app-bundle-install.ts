/**
 * Atomic, serialized install of a macOS `.app` bundle to a stable user path.
 *
 * Shared by the two helpers agents-cli installs on darwin — the secrets keychain
 * helper (`lib/secrets/install-helper.ts`) and the menu-bar helper
 * (`lib/menubar/install-menubar.ts`) — both of which are (re)installed on the hot
 * path of ordinary `agents` invocations. Both previously did a non-atomic
 * `rm -rf dest` + `cp -R src dest` straight onto the live bundle. That copy takes
 * long enough that a concurrent reader (Gatekeeper, or an exec of the bundle) sees
 * a half-written `.app` — a truncated Mach-O / mismatched `_CodeSignature` hash —
 * which macOS reports as **"is damaged and can't be opened."** On a busy box dozens
 * of concurrent invocations raced the same path, so the dialog fired intermittently.
 *
 * {@link copyAppBundle} stages the copy in a sibling directory and swaps it into
 * place with renames, so `dest` is only ever a complete, signed bundle (and a
 * failed copy never touches it). {@link withInstallLock} serializes concurrent
 * installers (via the shared `withFileLock`) so a burst of invocations installs
 * once instead of stampeding.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { withFileLock, ensureLockTarget } from './fs-atomic.js';

// A helper `cp -R` under load can take a few seconds; the lock must outlast it so
// a peer never treats a live installer as crashed and interleaves a second swap.
// (fs-atomic's 5s default is tuned for sub-second read-modify-writes.)
const INSTALL_LOCK_STALE_MS = 60_000;
const INSTALL_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;

/**
 * Copy an `.app` bundle to `dest` atomically. Stages into a sibling dir, then
 * swaps with renames — the window where `dest` is absent shrinks from the
 * seconds-long `cp` to a single microsecond rename, and a failed copy leaves the
 * existing bundle untouched. Serialize concurrent callers with {@link withInstallLock}
 * so the two-step swap never races another swap.
 */
export function copyAppBundle(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const staging = `${dest}.installing.${process.pid}`;
  const backup = `${dest}.replaced.${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  // `cp -R` preserves the bundle's signature, symlinks, and resource forks;
  // `fs.cpSync({recursive:true})` has historically mishandled xattrs on `.app`
  // bundles, breaking codesign.
  const r = spawnSync('cp', ['-R', src, staging], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    const msg = (r.stderr || r.stdout || '').toString().trim();
    throw new Error(`Failed to copy ${src} -> ${staging}: ${msg || 'unknown error'}`);
  }
  // rename(2) cannot replace a non-empty directory, so move the current bundle
  // aside, then move staging into place. If the second rename fails, restore the
  // backup so `dest` is never left missing.
  try {
    if (fs.existsSync(dest)) fs.renameSync(dest, backup);
    fs.renameSync(staging, dest);
  } catch (err) {
    if (!fs.existsSync(dest) && fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, dest);
      } catch {
        /* best-effort restore */
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`Failed to install ${src} -> ${dest}: ${(err as Error).message}`);
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

/**
 * Serialize installs across the many concurrent `agents` invocations that pass
 * through the helper-install path, so a burst copies once instead of stampeding
 * the atomic swap. Locks a sentinel file beside the bundle (the bundle itself may
 * not exist yet on first install) via the shared {@link withFileLock}.
 */
export function withInstallLock(dest: string, fn: () => void): void {
  const lockTarget = `${dest}.install-lock`;
  ensureLockTarget(lockTarget);
  withFileLock(
    lockTarget,
    () => {
      fn();
    },
    { staleMs: INSTALL_LOCK_STALE_MS, acquireTimeoutMs: INSTALL_LOCK_ACQUIRE_TIMEOUT_MS },
  );
}
