import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  KEYCHAIN_HELPER_ASSET,
  KEYCHAIN_HELPER_APP_NAME,
  KEYCHAIN_HELPER_SPEC,
  keychainHelperAssetUrls,
  keychainHelperCacheDir,
} from './download-keychain.js';
import {
  EXPECTED_TEAM_ID,
  HELPER_RELEASE_REPO,
  helperAssetUrls,
  helperCacheDir,
} from '../helper-download.js';
import { parseSha256Asset, sha256File } from '../sha256-asset.js';
import { getCacheDir } from '../state.js';

describe('keychain helper release-asset URLs', () => {
  it("builds asset URLs pinned to the HELPER's own tag, not the CLI's", () => {
    // The version here is a HELPER version. Keying these URLs to the CLI tag is
    // what forced every CLI release to re-stage every helper asset, and made a
    // helper fix unreachable without one — see lib/helper-versions.ts.
    const u = keychainHelperAssetUrls('1.0.0');
    expect(u.zip).toBe(
      'https://github.com/phnx-labs/agi-cli/releases/download/keychain/v1.0.0/Agents_CLI.app.zip',
    );
    expect(u.sha256).toBe(`${u.zip}.sha256`);
    // A bare `v<n>` tag here would be the old coupling coming back.
    expect(u.zip).not.toMatch(/download\/v\d/);
  });

  it('the asset name is underscored while the bundle keeps its space', () => {
    // This pair used to be asserted EQUAL (`ASSET === `${APP_NAME}.zip``), on the
    // premise that "GitHub encodes the space on the wire — fetch handles that".
    // That premise is false and it shipped a permanent 404: GitHub REWRITES a
    // space in an asset name to a dot at upload time, so `Agents CLI.app.zip`
    // was served as `Agents.CLI.app.zip` and no client ever found it.
    //
    // So they are deliberately DIFFERENT now, and that difference is the fix:
    //   - the ASSET is named to survive GitHub verbatim (underscore),
    //   - the BUNDLE keeps its space, because that is the on-disk name macOS and
    //     the TCC/keychain grant key on and renaming it is a different change.
    expect(KEYCHAIN_HELPER_ASSET).toBe('Agents_CLI.app.zip');
    expect(KEYCHAIN_HELPER_APP_NAME).toBe('Agents CLI.app');
    expect(KEYCHAIN_HELPER_ASSET).not.toContain(' ');
    expect(KEYCHAIN_HELPER_APP_NAME).toContain(' ');
  });

  it('caches under ~/.agents/.cache/secrets/mac-helper/v<version>', () => {
    expect(keychainHelperCacheDir('9.9.9')).toBe(
      path.join(getCacheDir(), 'secrets', 'mac-helper', 'v9.9.9'),
    );
  });

  it('shares the release repo + cache primitives with the generic spec', () => {
    expect(HELPER_RELEASE_REPO).toBe('phnx-labs/agi-cli');
    expect(helperAssetUrls(KEYCHAIN_HELPER_SPEC, '1.0.0').zip).toBe(keychainHelperAssetUrls('1.0.0').zip);
    expect(helperCacheDir(KEYCHAIN_HELPER_SPEC, '1.0.0')).toBe(keychainHelperCacheDir('1.0.0'));
  });
});

describe('keychain helper verification policy', () => {
  it('pins the Developer ID Team but NOT a designated requirement', () => {
    // The keychain helper's items are gated by the access-group entitlement +
    // biometry, not a bundle-id/DR-keyed grant (see keychain-helper.swift +
    // scripts/verify-keychain-helper.sh, which pins the executable sha256, not
    // a DR). So — unlike the menu-bar helper — the spec sets no expectedBundleId;
    // Team + notarization is the boundary, exactly like ComputerHelper.
    expect(KEYCHAIN_HELPER_SPEC.expectedTeamId).toBe('2HTP252L87');
    expect(KEYCHAIN_HELPER_SPEC.expectedTeamId).toBe(EXPECTED_TEAM_ID);
    expect(KEYCHAIN_HELPER_SPEC.expectedBundleId).toBeUndefined();
  });
});

describe('download sha256 gate (real hash + parse used in downloadHelperApp)', () => {
  it('a wrong published .sha256 does NOT equal the real bytes -> the download rejects', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-dl-'));
    const file = path.join(dir, 'Agents CLI.app.zip');
    fs.writeFileSync(file, 'not the signed bundle');
    try {
      const actual = await sha256File(file);
      // The exact comparison downloadHelperApp makes: expected (from the .sha256
      // asset) vs actual (streamed hash of the downloaded bytes).
      const bogusPublished = `${'0'.repeat(64)}  Agents CLI.app.zip`;
      const expected = parseSha256Asset(bogusPublished);
      expect(actual).not.toBe(expected); // -> "sha256 mismatch" throw, before extraction
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed .sha256 asset fails loud (never a silent accept)', () => {
    expect(() => parseSha256Asset('garbage, not a digest')).toThrow(/malformed .sha256/);
  });
});
