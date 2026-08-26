import { describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  EXPECTED_TEAM_ID,
  MAC_HELPER_ASSET,
  MAC_HELPER_APP_NAME,
  macHelperAssetUrls,
  macHelperCacheDir,
  parseTeamId,
} from './download.js';
import { getCacheDir } from '../state.js';

describe('parseTeamId (verifyMacHelper Team-ID extraction)', () => {
  // `codesign -dv --verbose=4` writes this block to STDERR even on success — the
  // verifier must read stderr, or every validly-signed helper is falsely rejected.
  const realOutput = [
    'Executable=/x/ComputerHelper.app/Contents/MacOS/ComputerHelper',
    'Identifier=com.phnx-labs.computer-helper',
    'CodeDirectory v=20500 size=969 flags=0x10000(runtime)',
    'Authority=Developer ID Application: Muqit Nawaz (2HTP252L87)',
    'TeamIdentifier=2HTP252L87',
  ].join('\n');

  it('extracts the Team ID from real codesign -dv output', () => {
    expect(parseTeamId(realOutput)).toBe('2HTP252L87');
  });

  it('returns null for ad-hoc / unsigned output (no TeamIdentifier) and for empty input', () => {
    expect(parseTeamId('Identifier=x\nTeamIdentifier=not set\n')).toBeNull();
    expect(parseTeamId('')).toBeNull(); // the old bug: reading empty stdout -> null -> false reject
  });
});

describe('mac helper release-asset download', () => {
  it("builds asset URLs pinned to the HELPER's own tag, not the CLI's", () => {
    // The version here is a HELPER version. Keying these URLs to the CLI tag is
    // what forced every CLI release to re-stage every helper asset, and made a
    // helper fix unreachable without one — see lib/helper-versions.ts.
    const u = macHelperAssetUrls('1.0.0');
    expect(u.zip).toBe(
      'https://github.com/phnx-labs/agi-cli/releases/download/computer-mac/v1.0.0/ComputerHelper.app.zip',
    );
    expect(u.sha256).toBe(`${u.zip}.sha256`);
    // A bare `v<n>` tag here would be the old coupling coming back.
    expect(u.zip).not.toMatch(/download\/v\d/);
  });

  it('names the asset + bundle exactly what build.sh emits (drift guard)', () => {
    // build.sh produces dist/ComputerHelper.app.zip from ComputerHelper.app;
    // the client URL and extracted dir must match those names byte-for-byte.
    expect(MAC_HELPER_ASSET).toBe('ComputerHelper.app.zip');
    expect(MAC_HELPER_APP_NAME).toBe('ComputerHelper.app');
    expect(MAC_HELPER_ASSET).toBe(`${MAC_HELPER_APP_NAME}.zip`);
  });

  it('caches under ~/.agents/.cache/computer/mac-helper/v<version>', () => {
    const version = '9.9.9';
    expect(macHelperCacheDir(version)).toBe(
      path.join(getCacheDir(), 'computer', 'mac-helper', `v${version}`),
    );
  });

  it('pins the expected Developer ID Team the client will assert', () => {
    // A wrong Team here would either reject our own notarized helper or (worse)
    // accept a differently-signed one — keep it locked to our Team.
    expect(EXPECTED_TEAM_ID).toBe('2HTP252L87');
  });
});
