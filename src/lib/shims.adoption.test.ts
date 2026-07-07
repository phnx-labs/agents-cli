import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptShadowingLauncher,
  releaseAdoptedLauncher,
  findAdoptableLauncher,
  getAdoptedRecordPath,
  generateShimScript,
} from './shims.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-adopt-test-'));
}

// Realistic layout: shims dir + a durable history dir (records live there now),
// plus a harness that installed a real binary symlinked into ~/.local/bin —
// exactly the grok/claude/kimi shape that shadows our shim.
function fixture(cli: string) {
  const root = tmp();
  const shimsDir = path.join(root, '.agents', '.cache', 'shims');
  const historyDir = path.join(root, '.agents', '.history');
  fs.mkdirSync(shimsDir, { recursive: true });
  const shimPath = path.join(shimsDir, cli);
  fs.writeFileSync(shimPath, '#!/bin/bash\n');
  fs.chmodSync(shimPath, 0o755);

  const harnessBinDir = path.join(root, `.${cli}`, 'bin');
  fs.mkdirSync(harnessBinDir, { recursive: true });
  const realBin = path.join(harnessBinDir, cli);
  fs.writeFileSync(realBin, '#!/bin/bash\necho native\n');
  fs.chmodSync(realBin, 0o755);

  const localBin = path.join(root, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const link = path.join(localBin, cli);
  fs.symlinkSync(realBin, link);

  return { root, shimsDir, historyDir, shimPath, realBin, link };
}

describe('adoptShadowingLauncher', () => {
  test('symlink launcher: repoints to shim, records original + launcher, idempotent', () => {
    const { shimsDir, historyDir, shimPath, realBin, link } = fixture('grok');

    const result = adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir, historyDir });
    expect(result.adopted).toBe(true);

    // Launcher now points at our shim.
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(shimPath));

    // Durable record: line 1 = original binary, line 2 = launcher path.
    const record = fs.readFileSync(getAdoptedRecordPath('grok', historyDir), 'utf-8').split('\n');
    expect(record[0]).toBe(fs.realpathSync(realBin));
    expect(record[1]).toBe(path.resolve(link));
    // ...and it lives under .history (durable), not .cache (regenerable).
    expect(getAdoptedRecordPath('grok', historyDir)).toContain(`${path.sep}.history${path.sep}`);

    // Second call is a no-op (already adopted), never a double-rewrite.
    const again = adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir, historyDir });
    expect(again.adopted).toBe(false);
    if (!again.adopted) expect(again.reason).toBe('already-adopted');
  });

  test('refuses to touch a REAL binary (only symlinks are adopted)', () => {
    const { shimsDir, historyDir, root } = fixture('droid');
    // droid ships a standalone native binary (not a symlink) at ~/.local/bin.
    const realBin = path.join(root, '.local', 'bin', 'droid');
    fs.rmSync(realBin);
    fs.writeFileSync(realBin, 'ELF-ish native binary');
    fs.chmodSync(realBin, 0o755);

    const result = adoptShadowingLauncher('droid', { shadowedBy: realBin, shimsDir, historyDir });
    expect(result.adopted).toBe(false);
    if (!result.adopted) expect(result.reason).toBe('not-a-symlink');
    expect(fs.readFileSync(realBin, 'utf-8')).toBe('ELF-ish native binary');
    expect(fs.existsSync(getAdoptedRecordPath('droid', historyDir))).toBe(false);
  });

  test('release restores the launcher from the record regardless of PATH (M3)', () => {
    const { shimsDir, historyDir, realBin, link } = fixture('grok');
    adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir, historyDir });

    // Release WITHOUT telling it the launcher — it must recover it from the
    // record's line 2, independent of any PATH scan.
    const restored = releaseAdoptedLauncher('grok', { shimsDir, historyDir });
    expect(restored).toBe(fs.realpathSync(realBin));
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(realBin));
    expect(fs.existsSync(getAdoptedRecordPath('grok', historyDir))).toBe(false);

    // Releasing again is a clean no-op.
    expect(releaseAdoptedLauncher('grok', { shimsDir, historyDir })).toBeNull();
  });

  test('the record survives a .cache wipe (M1 — durable reverse pointer)', () => {
    const { shimsDir, historyDir, realBin, link } = fixture('grok');
    adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir, historyDir });
    // Nuke the regenerable cache (shims dir). The record is elsewhere (.history).
    fs.rmSync(shimsDir, { recursive: true });
    // Reverse pointer to the native binary is still intact and restorable.
    const restored = releaseAdoptedLauncher('grok', { shimsDir, historyDir });
    expect(restored).toBe(fs.realpathSync(realBin));
  });
});

describe('findAdoptableLauncher', () => {
  test('finds a ~/.local/bin symlink resolving outside the shims dir', () => {
    const { root, shimsDir, link } = fixture('grok');
    const found = findAdoptableLauncher('grok', { homeDir: root, shimsDir });
    expect(found).toBe(link);
  });

  test('ignores a real binary and a broken symlink', () => {
    const { root, shimsDir } = fixture('grok');
    const localBin = path.join(root, '.local', 'bin');
    // Replace the symlink with a real binary.
    fs.rmSync(path.join(localBin, 'grok'));
    fs.writeFileSync(path.join(localBin, 'grok'), 'native');
    expect(findAdoptableLauncher('grok', { homeDir: root, shimsDir })).toBeNull();

    // A broken symlink (target missing) must not be offered.
    fs.rmSync(path.join(localBin, 'grok'));
    fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(localBin, 'grok'));
    expect(findAdoptableLauncher('grok', { homeDir: root, shimsDir })).toBeNull();
  });

  test('ignores a launcher already pointing into the shims dir', () => {
    const { root, shimsDir, shimPath } = fixture('grok');
    const local = path.join(root, '.local', 'bin', 'grok');
    fs.rmSync(local);
    fs.symlinkSync(shimPath, local); // already ours
    expect(findAdoptableLauncher('grok', { homeDir: root, shimsDir })).toBeNull();
  });
});

describe('generated shim fall-through', () => {
  test('is valid bash and reads the adopted-original record by absolute path', () => {
    const script = generateShimScript('grok');

    const f = path.join(tmp(), 'grok');
    fs.writeFileSync(f, script);
    execFileSync('bash', ['-n', f]); // throws on syntax error

    // Reads from the durable .history location, first line only.
    expect(script).toContain('ADOPTED_ORIGINAL="$AGENTS_USER_DIR/.history/adopted-launchers/$CLI_COMMAND"');
    expect(script).toContain('IFS= read -r orig < "$ADOPTED_ORIGINAL"');
    expect(script).toContain('exec_adopted_original');
    expect(script).toContain('adopted_original_bin');
  });

  test('droid shim prefers the adopted record before its fixed ~/.local/bin path', () => {
    const script = generateShimScript('droid');
    const droidBranch = script.slice(script.indexOf('AGENT" = "droid"'));
    expect(droidBranch.indexOf('adopted_original_bin')).toBeLessThan(
      droidBranch.indexOf('$HOME/.local/bin/droid'),
    );
  });
});
