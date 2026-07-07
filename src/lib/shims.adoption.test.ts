import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptShadowingLauncher,
  releaseAdoptedLauncher,
  getAdoptedRecordPath,
  generateShimScript,
} from './shims.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-adopt-test-'));
}

// A realistic "harness installed its own launcher" layout: a real binary in the
// harness's home, symlinked into an early-PATH dir (~/.local/bin) — exactly the
// grok/claude/kimi shape that shadows our shim.
function fakeLauncher(root: string, cli: string): { link: string; realBin: string } {
  const harnessBinDir = path.join(root, `.${cli}`, 'bin');
  fs.mkdirSync(harnessBinDir, { recursive: true });
  const realBin = path.join(harnessBinDir, cli);
  fs.writeFileSync(realBin, '#!/bin/bash\necho native\n');
  fs.chmodSync(realBin, 0o755);

  const localBin = path.join(root, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const link = path.join(localBin, cli);
  fs.symlinkSync(realBin, link);
  return { link, realBin };
}

describe('adoptShadowingLauncher', () => {
  test('symlink launcher: repoints to shim, records real original, is idempotent', () => {
    const root = tmp();
    const shimsDir = path.join(root, '.agents', '.cache', 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    // Materialize a stand-in shim so realpath resolution has a concrete target.
    const shimPath = path.join(shimsDir, 'grok');
    fs.writeFileSync(shimPath, '#!/bin/bash\n');
    fs.chmodSync(shimPath, 0o755);

    const { link, realBin } = fakeLauncher(root, 'grok');

    const result = adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir });
    expect(result.adopted).toBe(true);

    // The launcher now points at our shim...
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(shimPath));
    // ...and the original real binary is recorded for fall-through / restore.
    const record = fs.readFileSync(getAdoptedRecordPath('grok', shimsDir), 'utf-8').trim();
    expect(record).toBe(fs.realpathSync(realBin));

    // Second call is a no-op (already adopted), never a double-rewrite.
    const again = adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir });
    expect(again.adopted).toBe(false);
    if (!again.adopted) expect(again.reason).toBe('already-adopted');
  });

  test('refuses to touch a REAL binary (only symlinks are adopted)', () => {
    const root = tmp();
    const shimsDir = path.join(root, '.agents', '.cache', 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    fs.writeFileSync(path.join(shimsDir, 'droid'), '#!/bin/bash\n');

    // droid ships a standalone native binary (not a symlink) at ~/.local/bin.
    const localBin = path.join(root, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    const realBin = path.join(localBin, 'droid');
    fs.writeFileSync(realBin, 'ELF-ish native binary');
    fs.chmodSync(realBin, 0o755);

    const result = adoptShadowingLauncher('droid', { shadowedBy: realBin, shimsDir });
    expect(result.adopted).toBe(false);
    if (!result.adopted) expect(result.reason).toBe('not-a-symlink');
    // The real binary is untouched.
    expect(fs.readFileSync(realBin, 'utf-8')).toBe('ELF-ish native binary');
    expect(fs.existsSync(getAdoptedRecordPath('droid', shimsDir))).toBe(false);
  });

  test('release restores the launcher to the recorded original and drops the record', () => {
    const root = tmp();
    const shimsDir = path.join(root, '.agents', '.cache', 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    fs.writeFileSync(path.join(shimsDir, 'grok'), '#!/bin/bash\n');

    const { link, realBin } = fakeLauncher(root, 'grok');
    adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir });

    const restored = releaseAdoptedLauncher('grok', { shadowedBy: link, shimsDir });
    expect(restored).toBe(fs.realpathSync(realBin));
    // Launcher points back at the native binary; record is gone.
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(realBin));
    expect(fs.existsSync(getAdoptedRecordPath('grok', shimsDir))).toBe(false);

    // Releasing again is a clean no-op.
    expect(releaseAdoptedLauncher('grok', { shadowedBy: link, shimsDir })).toBeNull();
  });
});

describe('generated shim fall-through', () => {
  test('is valid bash and reads the adopted-original record by absolute path', () => {
    const script = generateShimScript('grok');

    // Valid bash (catches template-literal escaping regressions).
    const f = path.join(tmp(), 'grok');
    fs.writeFileSync(f, script);
    execFileSync('bash', ['-n', f]); // throws on syntax error

    // The safety net exists and is wired into failure paths.
    expect(script).toContain('ADOPTED_ORIGINAL="$AGENTS_USER_DIR/.cache/shims/.adopted/$CLI_COMMAND"');
    expect(script).toContain('exec_adopted_original');
    // grok's last-resort binary resolution must prefer the recorded original
    // over `command -v grok` — otherwise the adopted symlink re-enters the shim.
    expect(script).toContain('adopted_original_bin');
  });

  test('droid shim prefers the adopted record before its fixed ~/.local/bin path', () => {
    const script = generateShimScript('droid');
    const droidBranch = script.slice(script.indexOf('AGENT" = "droid"'));
    // adopted_original_bin is consulted before the $HOME/.local/bin/droid path,
    // which after adoption points back at this dispatcher.
    expect(droidBranch.indexOf('adopted_original_bin')).toBeLessThan(
      droidBranch.indexOf('$HOME/.local/bin/droid'),
    );
  });
});
