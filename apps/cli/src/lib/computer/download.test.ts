import { describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  EXPECTED_TEAM_ID,
  MAC_HELPER_ASSET,
  MAC_HELPER_APP_NAME,
  macHelperAssetUrls,
  macHelperCacheDir,
} from './download.js';
import { getCacheDir } from '../state.js';

describe('mac helper release-asset download', () => {
  it('builds asset URLs pinned to the exact v<version> tag', () => {
    const u = macHelperAssetUrls('1.20.50');
    expect(u.zip).toBe(
      'https://github.com/phnx-labs/agents-cli/releases/download/v1.20.50/ComputerHelper.app.zip',
    );
    expect(u.sha256).toBe(`${u.zip}.sha256`);
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
