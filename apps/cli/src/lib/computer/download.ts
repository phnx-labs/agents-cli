/**
 * On-demand download + verification of the macOS `agents computer` helper
 * ("ComputerHelper.app").
 *
 * The helper is a signed + notarized universal `.app` bundle published as a
 * GitHub release asset per tagged CLI version — the same distribution model as
 * the Windows helper (see `lib/ssh-tunnel.ts`). A fresh `npm i -g` machine has
 * no local build, so `agents computer setup` / `agents setup computer` fetch the
 * asset for the running CLI version, verify its sha256 against the published
 * `.sha256`, then verify the code signature (Developer ID Team + notarization)
 * before it is ever copied to /Applications.
 *
 * A `.app` is a directory, so the asset is a zip (`ditto -c -k --keepParent`);
 * we extract it with `ditto -x -k` after the checksum passes.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getCacheDir } from '../state.js';
import { getCliVersion } from '../version.js';
import { parseSha256Asset, sha256File } from '../ssh-tunnel.js';
import { resolveHelperApp } from '../computer-rpc.js';

/** GitHub repo whose `v<version>` releases carry the helper asset. */
export const HELPER_RELEASE_REPO = 'phnx-labs/agents-cli';
/** The zipped `.app` release asset name. */
export const MAC_HELPER_ASSET = 'ComputerHelper.app.zip';
/** The bundle directory name once extracted. */
export const MAC_HELPER_APP_NAME = 'ComputerHelper.app';
/** Apple Developer ID Team the helper must be signed by (defense in depth on top
 * of `spctl` notarization assessment). "Developer ID Application: Muqit Nawaz". */
export const EXPECTED_TEAM_ID = '2HTP252L87';

/** Cache dir for the downloaded helper, one subdir per release tag. */
export function macHelperCacheDir(version: string): string {
  return path.join(getCacheDir(), 'computer', 'mac-helper', `v${version}`);
}

/** Release-asset URLs for the helper zip + its checksum at one `v<version>` tag. */
export function macHelperAssetUrls(version: string): { zip: string; sha256: string } {
  const base = `https://github.com/${HELPER_RELEASE_REPO}/releases/download/v${version}`;
  return { zip: `${base}/${MAC_HELPER_ASSET}`, sha256: `${base}/${MAC_HELPER_ASSET}.sha256` };
}

/** Extract `TeamIdentifier=XXXX` from `codesign -dv --verbose=4` output (which is
 * emitted on stderr). Returns null when absent (ad-hoc / unsigned). */
export function parseTeamId(codesignInfo: string): string | null {
  return codesignInfo.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1] ?? null;
}

/**
 * Verify a helper `.app` bundle is intact, signed by the expected Developer ID
 * Team, and notarized (Gatekeeper-accepted). Throws with an actionable message
 * on any failure — a downloaded bundle is never trusted without this.
 */
export function verifyMacHelper(appPath: string): void {
  // 1. Structural + signature integrity.
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`code signature invalid for ${appPath}: ${(e as Error).message}`);
  }

  // 2. Team identity — must be our Developer ID, not some other valid signer.
  // `codesign -dv` writes its details to STDERR even on success (exit 0), so we
  // must read stderr, not stdout. spawnSync captures both streams regardless of
  // exit code; execFileSync would return only (empty) stdout and the Team check
  // would falsely reject every validly-signed helper.
  const dv = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const info = `${dv.stdout ?? ''}${dv.stderr ?? ''}`;
  const team = parseTeamId(info);
  if (team !== EXPECTED_TEAM_ID) {
    throw new Error(
      `helper signed by unexpected Team (${team ?? 'none'}), expected ${EXPECTED_TEAM_ID}. Refusing to install.`,
    );
  }

  // 3. Notarization / Gatekeeper — confirms Apple stapled a notarization ticket.
  try {
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', appPath], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      `helper is not notarized / rejected by Gatekeeper: ${(e as Error).message}. Refusing to install.`,
    );
  }
}

/**
 * Download the helper release asset for `version`, verify sha256, extract the
 * `.app`, and verify its signature. Returns the path to the extracted
 * `ComputerHelper.app`. A missing asset is a hard error naming the exact tag —
 * never a silent fallback to another release.
 */
export async function downloadMacHelperApp(version: string): Promise<string> {
  const dir = macHelperCacheDir(version);
  const cachedApp = path.join(dir, MAC_HELPER_APP_NAME);
  if (fs.existsSync(cachedApp)) {
    // Re-verify a cached bundle cheaply; a tampered cache must not be trusted.
    verifyMacHelper(cachedApp);
    return cachedApp;
  }

  const tag = `v${version}`;
  const { zip: zipUrl, sha256: shaUrl } = macHelperAssetUrls(version);
  const missing = (status: number, url: string) =>
    new Error(
      `no ${MAC_HELPER_ASSET} release asset for tag ${tag} (HTTP ${status} on ${url}). ` +
        `The macOS helper ships as a GitHub release asset per tagged CLI version; ` +
        `from a repo checkout you can build it locally instead: ` +
        `bash native/computer-mac/scripts/build.sh release`,
    );

  // Checksum first: it is tiny and 404s fast when the tag has no assets.
  const shaRes = await fetch(shaUrl, { signal: AbortSignal.timeout(30_000) });
  if (!shaRes.ok) throw missing(shaRes.status, shaUrl);
  const expected = parseSha256Asset(await shaRes.text());

  console.error(`Downloading ${MAC_HELPER_ASSET} ${tag} from GitHub releases...`);
  const zipRes = await fetch(zipUrl, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!zipRes.ok || !zipRes.body) throw missing(zipRes.status, zipUrl);

  fs.mkdirSync(dir, { recursive: true });
  const partial = path.join(dir, `${MAC_HELPER_ASSET}.download`);
  try {
    await pipeline(
      Readable.fromWeb(zipRes.body as unknown as import('stream/web').ReadableStream),
      fs.createWriteStream(partial),
    );
    const actual = await sha256File(partial);
    if (actual !== expected) {
      throw new Error(`sha256 mismatch for ${zipUrl}: expected ${expected}, got ${actual}`);
    }
    // Extract the zip (created with `ditto -c -k --keepParent`, so it contains
    // ComputerHelper.app/ at top level) into the version cache dir.
    fs.rmSync(cachedApp, { recursive: true, force: true });
    execFileSync('/usr/bin/ditto', ['-x', '-k', partial, dir], { stdio: 'pipe' });
    if (!fs.existsSync(cachedApp)) {
      throw new Error(`extracted asset did not contain ${MAC_HELPER_APP_NAME}`);
    }
    verifyMacHelper(cachedApp);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return cachedApp;
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
