import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SH = fs.readFileSync(path.join(CLI_ROOT, 'menubar', 'scripts', 'build.sh'), 'utf-8');

/**
 * Pins the notarization gate as TEXT, the same idiom `scripts/release.test.ts`
 * uses for `release.sh`.
 *
 * The behavior itself — a real Developer ID signature triggering a real
 * notarytool submission — cannot be tested here: both sides are Apple services
 * keyed to credentials no CI runner holds, and this repo forbids mocking. But
 * the *shape of the decision* is a shell conditional, and that is exactly what
 * regressed: gating on `MODE` produced a Developer-ID-signed, un-notarized
 * bundle that exits 0 and that Gatekeeper rejects as "damaged" (RUSH-2134).
 * These assertions cost nothing and would have caught it.
 */
describe('menubar build.sh — a Developer-ID signature always implies notarization', () => {
  it('gates notarization on the SIGNATURE, never on the mode', () => {
    // The regression: `[ "$MODE" = "release" ] && [ "$SIGN_ID" != "-" ]` let any
    // non-release invocation emit a signed-but-unnotarized bundle.
    expect(BUILD_SH).toContain('if [ "$SIGN_ID" != "-" ]; then');
    expect(BUILD_SH).not.toContain('if [ "$MODE" = "release" ] && [ "$SIGN_ID" != "-" ]');
  });

  it('keeps the credential guards INSIDE the signature-gated branch', () => {
    // They used to sit inside the mode-gated branch, making the very check that
    // fails loud on missing Apple creds unreachable in the case it exists for.
    const gate = BUILD_SH.slice(BUILD_SH.indexOf('if [ "$SIGN_ID" != "-" ]; then'));
    for (const v of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
      expect(gate).toContain(`\${${v}:?`);
    }
  });

  it('downgrades a credential-less debug build to ad-hoc BEFORE Info.plist is written', () => {
    // Ordering is load-bearing, not stylistic. A downgrade after the plist emits
    // an ad-hoc bundle still carrying the PRODUCTION bundle id, which poisons the
    // user's Accessibility grant — strictly worse than the build failure it
    // replaces. Assert the real line order, not merely that both exist.
    const downgrade = BUILD_SH.indexOf('no apple.com notary creds');
    const plist = BUILD_SH.indexOf('$APP/Contents/Info.plist');
    const notarize = BUILD_SH.indexOf('${APPLE_ID:?');
    expect(downgrade).toBeGreaterThan(-1);
    expect(plist).toBeGreaterThan(downgrade);
    expect(notarize).toBeGreaterThan(plist);
  });

  it('never emits a Developer-ID signature it cannot notarize', () => {
    // The invariant, stated once: the only way to skip notarization is to also
    // drop to ad-hoc (SIGN_ID="-"), which carries the .dev bundle id.
    const downgrade = BUILD_SH.slice(BUILD_SH.indexOf('no apple.com notary creds'));
    expect(downgrade).toContain('SIGN_ID="-"');
    expect(BUILD_SH).toContain('com.phnx-labs.agents-menubar.dev');
  });

  it('documents the escape hatch for a signing box that wants a fast local build', () => {
    // MENUBAR_HELPER_SIGN_ID=- skips the Developer ID entirely. It existed but was
    // undocumented in the gate's own comment block, so a developer hitting a slow
    // notarize round-trip had no way to know.
    expect(BUILD_SH).toContain('MENUBAR_HELPER_SIGN_ID=-');
  });
});
