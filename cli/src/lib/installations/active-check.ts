/**
 * Real-process-state "is this installation busy right now?" check (PHNX-3940).
 *
 * A leaf module deliberately kept free of `update.js`/`update-runtime.js`
 * imports so both can depend on it without an import cycle: `update.ts` needs
 * it for the pre-commit re-check (narrowing the launch/update race), and
 * `update-runtime.ts` (which itself calls into `update.ts`) needs it for the
 * plan-time deferral decision.
 *
 * Two independent signals, either one is enough to defer:
 *   - A live OS process whose command line names this installation's own
 *     version-dir path — a real process-table scan, not this box's session
 *     registry, so a harness launched by a bare generated shim with no
 *     session bookkeeping still defers correctly.
 *   - A live launch lease (`shims.ts`) — catches a launch that started after
 *     the process-table scan ran but hasn't hit the process table yet, e.g.
 *     mid-staging of a long npm install. See `shims.ts`'s docblock for what
 *     this does and does not close (it narrows the race, not eliminates it).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { getVersionDir } from './store.js';
import { hasLiveLaunchLease } from './shims.js';
import type { Installation } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Raw process-table snapshot, one command line per entry. Injectable so tests
 * can drive real string matching without shelling out or requiring a live
 * agent process on the test box.
 */
export interface ProcessSnapshot {
  listCommandLines(): Promise<string[]>;
}

async function listCommandLinesPosix(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'args'], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split('\n');
  } catch {
    // A ps failure must not silently mean "nothing is running" — that would let
    // an update proceed against a harness this pass simply failed to observe.
    // Callers treat a thrown scan as "assume active", the safe default.
    throw new Error('could not read the process table (ps failed)');
  }
}

async function listCommandLinesWindows(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"],
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    return stdout.split(/\r?\n/);
  } catch {
    throw new Error('could not read the process table (PowerShell CIM query failed)');
  }
}

export const realProcessSnapshot: ProcessSnapshot = {
  listCommandLines: () => (process.platform === 'win32' ? listCommandLinesWindows() : listCommandLinesPosix()),
};

/**
 * Does any live process reference this installation's own directory? Matches
 * on the absolute version-dir path rather than the bare CLI command name, so
 * it distinguishes between installations of the same agent (two Claude
 * installs are two different directories) and catches every way the binary
 * ends up running under that path: an `agents run` session, a bare generated
 * PATH/`.cmd` shim exec'd directly with no session bookkeeping at all, or a
 * routine/teammate process — all of them carry the resolved absolute binary
 * path in their command line, since none of the launch surfaces exec a bare
 * relative name.
 */
export function installationLooksActive(installation: Installation, commandLines: string[]): boolean {
  const versionDir = getVersionDir(installation.agent, installation.label);
  return commandLines.some((line) => line.includes(versionDir));
}

/**
 * Whether this installation appears to be busy right now: a live launch
 * lease, or a live process naming its directory per a fresh OS process-table
 * scan. On a scan failure, defers (returns true) rather than risking an
 * update to a harness this check simply failed to observe.
 */
export async function isInstallationLikelyActive(
  installation: Installation,
  snapshot: ProcessSnapshot = realProcessSnapshot,
): Promise<boolean> {
  if (hasLiveLaunchLease(installation.agent, installation.label)) return true;
  try {
    const lines = await snapshot.listCommandLines();
    return installationLooksActive(installation, lines);
  } catch {
    return true;
  }
}
