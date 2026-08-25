/**
 * On-demand download + verification of the macOS keychain broker helper
 * ("Agents CLI.app").
 *
 * Mirrors the ComputerHelper / MenubarHelper download model
 * (`../helper-download.ts`): the helper ships as a signed + notarized `.app`
 * zipped as a GitHub release asset per tagged CLI version. A fresh `npm i -g`
 * machine whose tarball lacks a bundled copy fetches the asset for the running
 * CLI version, verifies its sha256 + code signature before install.
 *
 * Unlike the menu-bar helper, the keychain helper pins NO designated
 * requirement (no `expectedBundleId`). The menu-bar `expectedBundleId` exists
 * because macOS keys the Accessibility (TCC) grant to the bundle's designated
 * requirement, so a substituted bundle whose DR does not pin (id, team) would
 * silently revoke that upgrade-stable grant. The keychain helper has no such
 * DR-keyed grant to protect: its items are gated by the access-group
 * entitlement (`keychain-helper.swift` → `kSecAttrAccessGroup`, the
 * `keychain-access-groups` entitlement) plus a biometry `SecAccessControl`
 * (user presence) — NOT a `SecTrustedApplication` ACL keyed to a bundle-id/DR.
 * The release-time gate `scripts/verify-keychain-helper.sh` correspondingly
 * pins the executable's sha256, not a designated requirement. So Team +
 * notarization is the verification boundary here, exactly like ComputerHelper.
 */

import {
  EXPECTED_TEAM_ID,
  type HelperSpec,
  downloadHelperApp,
  helperAssetUrls,
  helperCacheDir,
  verifyHelperApp,
} from '../helper-download.js';

/** The zipped `.app` release asset name (the bundle name has a space). */
export const KEYCHAIN_HELPER_ASSET = 'Agents CLI.app.zip';
/** The bundle directory name once extracted. */
export const KEYCHAIN_HELPER_APP_NAME = 'Agents CLI.app';

/** Keychain-helper identity + verification policy — Team + notarization only,
 *  no DR pin (see docblock). */
export const KEYCHAIN_HELPER_SPEC: HelperSpec = {
  assetName: KEYCHAIN_HELPER_ASSET,
  appName: KEYCHAIN_HELPER_APP_NAME,
  cacheSubdir: ['secrets', 'mac-helper'],
  expectedTeamId: EXPECTED_TEAM_ID,
  localBuildHint: 'cli/scripts/build-keychain-helper.sh',
};

/** Release-asset URLs for the keychain helper zip + its checksum at `v<version>`. */
export function keychainHelperAssetUrls(version: string): { zip: string; sha256: string } {
  return helperAssetUrls(KEYCHAIN_HELPER_SPEC, version);
}

/** Cache dir for the downloaded keychain helper, one subdir per release tag. */
export function keychainHelperCacheDir(version: string): string {
  return helperCacheDir(KEYCHAIN_HELPER_SPEC, version);
}

/** Verify a keychain helper `.app`: codesign + Team + notarization (no DR pin). */
export function verifyKeychainHelper(appPath: string): void {
  verifyHelperApp(appPath, KEYCHAIN_HELPER_SPEC);
}

/**
 * Download the keychain helper release asset for `version`, verify sha256 +
 * signature, and return the path to the extracted `Agents CLI.app` in the
 * cache. A missing asset is a hard error naming the exact tag.
 */
export function downloadKeychainHelperApp(version: string): Promise<string> {
  return downloadHelperApp(KEYCHAIN_HELPER_SPEC, version);
}
