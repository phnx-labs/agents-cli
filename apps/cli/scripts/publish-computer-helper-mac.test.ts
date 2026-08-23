/**
 * The macOS computer-helper publisher, run against the REAL script.
 *
 * The case that matters is RUSH-2970 trap 3: the script's own documented
 * invocation -- `agents secrets exec apple.com -- publish-computer-helper-mac.sh`
 * -- injects the NOTARY creds but never unlocks the Developer ID SIGNING
 * keychain, so a headless run died in codesign with errSecInternalComponent. The
 * operator had to know to source headless-sign-context.sh first, which nothing in
 * the script or its help said. The script now sources that context itself.
 *
 * A green signing run needs a provisioned Mac (a Developer ID identity in a
 * headless-unlockable keychain) -- the next helper publish exercises that. On any
 * box we can still assert the two things that make the fix safe and durable: the
 * context is established before the build that signs, and sourcing it is a clean
 * no-op on a machine WITHOUT the release-box pass files, so adding it cannot
 * break a contributor's Mac.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PUBLISH = path.resolve(__dirname, 'publish-computer-helper-mac.sh');
const CONTEXT = path.resolve(__dirname, 'headless-sign-context.sh');

describe('publish-computer-helper-mac.sh', () => {
  it('establishes the signing context before the build that signs (RUSH-2970 trap 3)', () => {
    const src = fs.readFileSync(PUBLISH, 'utf-8');

    const sourcedAt = src.indexOf('headless-sign-context.sh"');
    const buildsAt = src.indexOf('scripts/build.sh release');

    // Absent entirely => trap 3 is back: the documented invocation cannot sign.
    expect(sourcedAt, 'script must source headless-sign-context.sh itself').toBeGreaterThan(-1);
    // After the build => the keychain is still locked when codesign runs.
    expect(sourcedAt).toBeLessThan(buildsAt);
  });

  it('refuses a non-macOS host loudly rather than half-running', () => {
    // Force the platform gate to see a NON-macOS host by shadowing `uname` on
    // PATH, so this exercises the refusal path deterministically on ANY host.
    // Running the real script unshadowed on a Mac would get PAST the gate and
    // start the actual build+sign+notarize -- a 60s+ side-effecting operation
    // that timed the test out on the one machine that signs releases (the
    // attestation producer runs the full suite there), which is exactly the
    // half-run this guard exists to prevent, now reproduced by the test itself.
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'uname-stub-'));
    fs.writeFileSync(path.join(stub, 'uname'), '#!/bin/sh\necho Linux\n');
    fs.chmodSync(path.join(stub, 'uname'), 0o755);

    const r = spawnSync('bash', [PUBLISH], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${stub}:${process.env.PATH ?? ''}` },
    });
    const out = `${r.stdout}${r.stderr}`;

    // The gate must fire first and loud, before any real work: non-zero exit and
    // the "macOS only" refusal, never a half-run.
    expect(r.status, `expected a loud refusal, got: ${out}`).not.toBe(0);
    expect(out).toContain('macOS only');
  });

  it('sourcing the signing context is a no-op without the release-box pass files', () => {
    // A HOME with no ~/Library/Application Support/rush => the guards must skip
    // every `security` call. This is what keeps the new source line safe on a Mac
    // that is not the release home base.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'no-signing-home-'));

    // Strip the passphrase the context is supposed to set. Inheriting it from the
    // developer's own shell would make the assertion below pass on a value this
    // run never produced -- the same reason tests/secrets-transport-passphrase.test.ts
    // deletes it before driving the CLI.
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
    delete env.AGENTS_SECRETS_PASSPHRASE;

    const r = spawnSync(
      'bash',
      ['-c', `set -euo pipefail; . "${CONTEXT}"; echo "rc=$?"; echo "pass=\${AGENTS_SECRETS_PASSPHRASE:-unset}"`],
      { encoding: 'utf-8', env },
    );
    const out = `${r.stdout}${r.stderr}`;

    expect(r.status, `sourcing must not fail: ${out}`).toBe(0);
    expect(out).toContain('rc=0');
    expect(out).toContain('pass=unset');
    expect(out).not.toMatch(/security:|SecKeychain|errSec/);

    fs.rmSync(home, { recursive: true, force: true });
  });
});
