/**
 * verify-menubar-helper.sh — the prepack gate for the menu-bar helper.
 *
 * The regression this pins: 1.22.44 was packed on a Linux box (no codesign, no
 * xcrun), where every signature check silently no-op'd, so an un-stapled dev
 * bundle shipped and Gatekeeper rejected it on every Mac ("not notarized/valid;
 * skipping launch") — the menu bar died fleet-wide. Off-Mac the gate must still
 * fail closed on a bundle with no stapled ticket (`Contents/CodeResources` is a
 * plain file `stapler staple` writes, so its absence is provable anywhere).
 *
 * Runs the REAL script against real fixture bundles; xcrun/codesign absence is
 * the genuine environment on the Linux boxes that pack (no mocking).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const VERIFY = path.resolve(__dirname, 'verify-menubar-helper.sh');

/** Stage the script + a fixture bundle in an isolated root and run the gate. */
function runGate(bundle: 'ticketed' | 'unticketed' | 'absent'): { status: number | null; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-gate-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(VERIFY, path.join(root, 'scripts/verify-menubar-helper.sh'));
  if (bundle !== 'absent') {
    const contents = path.join(root, 'bin/MenubarHelper.app/Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'MacOS/MenubarHelper'), 'binary-bytes\n');
    fs.writeFileSync(path.join(contents, 'Info.plist'), '<plist/>\n');
    if (bundle === 'ticketed') {
      // The stapled notarization ticket `stapler staple` writes.
      fs.writeFileSync(path.join(contents, 'CodeResources'), 'ticket-bytes\n');
    }
  }
  // PATH without codesign/xcrun = the Linux producer environment. bash/core
  // resolve via an explicit minimal PATH that genuinely lacks Apple tools.
  const r = spawnSync('bash', [path.join(root, 'scripts/verify-menubar-helper.sh')], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('verify-menubar-helper.sh off-Mac (no codesign/xcrun)', () => {
  it('fails closed on a bundle with NO stapled ticket — the 1.22.44 regression', () => {
    const { status, out } = runGate('unticketed');
    expect(status).not.toBe(0);
    expect(out).toContain('NO stapled notarization ticket');
    expect(out).toContain('1.22.44'); // names the incident so the operator knows the stakes
  });

  it('passes a bundle carrying the stapled ticket file', () => {
    const { status, out } = runGate('ticketed');
    expect(status).toBe(0);
    expect(out).toContain('present, signed, and notarized');
  });

  it('still fails closed when the bundle is absent entirely (the 1.20.22 gate)', () => {
    const { status, out } = runGate('absent');
    expect(status).not.toBe(0);
    expect(out).toContain('menubar helper missing');
  });
});
