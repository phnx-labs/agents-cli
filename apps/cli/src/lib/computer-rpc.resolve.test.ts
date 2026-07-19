import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate HOME before importing modules that capture path constants at import.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resolve-test-'));
process.env.HOME = TEST_HOME;

const { resolveHelperApp, resolveHelperExec } = await import('./computer-rpc.js');
const { getCacheDir } = await import('./state.js');
const { getCliVersion } = await import('./version.js');

describe('computer helper resolver — cache is NOT a trusted source (M1 regression)', () => {
  it('does not resolve a bundle planted in the user-writable download cache', () => {
    // A same-user process could drop a differently-signed .app here. It must only
    // ever be read through downloadMacHelperApp(), which re-verifies signature +
    // Team ID + notarization — never treated as a trusted resolver candidate.
    const cachedExec = path.join(
      getCacheDir(),
      'computer',
      'mac-helper',
      `v${getCliVersion()}`,
      'ComputerHelper.app',
      'Contents',
      'MacOS',
      'ComputerHelper',
    );
    fs.mkdirSync(path.dirname(cachedExec), { recursive: true });
    fs.writeFileSync(cachedExec, '#!/bin/sh\n'); // stand-in for an unverified binary

    // No local checkout build / bundled copy exists in the test env, so if the
    // cache were (wrongly) a candidate, these would return the planted path.
    expect(resolveHelperExec()).toBeNull();
    expect(resolveHelperApp()).toBeNull();
  });
});
