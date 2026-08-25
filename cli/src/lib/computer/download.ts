/**
 * On-demand download + verification of the macOS `agents computer` helper
 * ("ComputerHelper.app").
 *
 * The helper is a signed + notarized universal `.app` bundle published as a
 * GitHub release asset per tagged CLI version — the same distribution model as
 * the Windows helper (see `lib/computer/ssh-tunnel.ts`). A fresh `npm i -g` machine has
 * no local build, so `agents computer setup` / `agents setup computer` fetch the
 * asset for the running CLI version, verify its sha256 against the published
 * `.sha256`, then verify the code signature (Developer ID Team + notarization)
 * before it is ever copied to /Applications.
 *
 * The download + verify machinery is shared with the menu-bar helper in
 * `../helper-download.ts`; this file is the ComputerHelper spec + its wrappers,
 * keeping the historical export surface (`verifyMacHelper`, `downloadMacHelperApp`,
 * `ensureMacHelperApp`, …) stable for existing callers. ComputerHelper does NOT
 * pin a designated requirement (no `expectedBundleId`), matching its verification
 * strength before the shared primitive existed.
 */

import * as os from 'node:os';
import { getCliVersion } from '../version.js';
import { resolveHelperApp } from './computer-rpc.js';
import {
  EXPECTED_TEAM_ID,
  HELPER_RELEASE_REPO,
  type HelperSpec,
  downloadHelperApp,
  helperAssetUrls,
  helperCacheDir,
  parseTeamId,
  verifyHelperApp,
} from '../helper-download.js';

// Re-exported so existing importers (and download.test.ts) keep resolving these
// names from './download.js'.
export { EXPECTED_TEAM_ID, HELPER_RELEASE_REPO, parseTeamId };

/** The zipped `.app` release asset name. */
export const MAC_HELPER_ASSET = 'ComputerHelper.app.zip';
/** The bundle directory name once extracted. */
export const MAC_HELPER_APP_NAME = 'ComputerHelper.app';

/** ComputerHelper identity + verification policy. No `expectedBundleId`: this
 *  helper has no upgrade-stable Accessibility grant to protect, so its
 *  verification is codesign + Team + notarization exactly as before. */
const COMPUTER_HELPER_SPEC: HelperSpec = {
  assetName: MAC_HELPER_ASSET,
  appName: MAC_HELPER_APP_NAME,
  cacheSubdir: ['computer', 'mac-helper'],
  expectedTeamId: EXPECTED_TEAM_ID,
  localBuildHint: 'bash native/computer-mac/scripts/build.sh release',
};

/** Cache dir for the downloaded helper, one subdir per release tag. */
export function macHelperCacheDir(version: string): string {
  return helperCacheDir(COMPUTER_HELPER_SPEC, version);
}

/** Release-asset URLs for the helper zip + its checksum at one `v<version>` tag. */
export function macHelperAssetUrls(version: string): { zip: string; sha256: string } {
  return helperAssetUrls(COMPUTER_HELPER_SPEC, version);
}

/**
 * Verify a helper `.app` bundle is intact, signed by the expected Developer ID
 * Team, and notarized (Gatekeeper-accepted). Throws with an actionable message
 * on any failure — a downloaded bundle is never trusted without this.
 */
export function verifyMacHelper(appPath: string): void {
  verifyHelperApp(appPath, COMPUTER_HELPER_SPEC);
}

/**
 * Download the helper release asset for `version`, verify sha256, extract the
 * `.app`, and verify its signature. Returns the path to the extracted
 * `ComputerHelper.app`. A missing asset is a hard error naming the exact tag —
 * never a silent fallback to another release.
 */
export function downloadMacHelperApp(version: string): Promise<string> {
  return downloadHelperApp(COMPUTER_HELPER_SPEC, version);
}

/**
 * Resolve the helper `.app` to install from: a local build / bundled copy first
 * (repo checkout), else the checksum + signature-verified release-asset download
 * for the running CLI version. Throws with the tag it checked when neither
 * exists. macOS only.
 */
export async function ensureMacHelperApp(version = getCliVersion()): Promise<string> {
  if (os.platform() !== 'darwin') {
    throw new Error('The macOS computer helper is only available on macOS.');
  }
  const local = resolveHelperApp();
  if (local) return local;
  return downloadMacHelperApp(version);
}
