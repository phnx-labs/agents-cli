import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SUN_LEN,
  CODEX_CONTROL_SOCKET_SUFFIX,
  codexHomeOverflowsSunLen,
  shortCodexHome,
  resolveCodexHome,
  codexHomeShimBash,
} from '../codex-home.js';

describe('codex-home SUN_LEN helpers', () => {
  it('models the macOS socket-path constants', () => {
    expect(SUN_LEN).toBe(104);
    // The measured suffix codex appends to CODEX_HOME.
    expect(CODEX_CONTROL_SOCKET_SUFFIX).toBe('/app-server-control/app-server-control.sock');
    expect(CODEX_CONTROL_SOCKET_SUFFIX.length).toBe(43);
  });

  it('flags a home only when its derived socket path exceeds SUN_LEN', () => {
    // 61-char home -> socket 104 (fits); 62-char home -> socket 105 (overflows).
    const fits = 'x'.repeat(SUN_LEN - CODEX_CONTROL_SOCKET_SUFFIX.length);
    expect(fits.length).toBe(61);
    expect(codexHomeOverflowsSunLen(fits)).toBe(false);
    expect(codexHomeOverflowsSunLen(fits + 'x')).toBe(true);
  });

  it('reproduces the real mac-mini overflow (65-char versioned home)', () => {
    const real = '/Users/muqsit/.agents/.history/versions/codex/0.143.0/home/.codex';
    expect(real.length).toBe(65);
    expect(codexHomeOverflowsSunLen(real)).toBe(true);
  });

  it('derives a short, per-version home under ~/.agents/.codex-homes', () => {
    const short = shortCodexHome('/Users/muqsit/.agents', '0.143.0');
    // path.join is platform-native (backslashes on Windows), so compare against
    // the same join rather than a hardcoded POSIX literal.
    expect(short).toBe(path.join('/Users/muqsit/.agents', '.codex-homes', '0.143.0', '.codex'));
    expect(codexHomeOverflowsSunLen(short)).toBe(false);
  });
});

describe('resolveCodexHome', () => {
  let root: string;
  let agentsUserDir: string;
  let versionedHome: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    agentsUserDir = path.join(root, '.agents');
    // Build a versioned home long enough to overflow SUN_LEN regardless of the
    // tmp prefix, so the darwin branch actually triggers.
    versionedHome = path.join(
      agentsUserDir,
      '.history/versions/codex/0.143.0',
      'p'.repeat(80),
      'home/.codex',
    );
    fs.mkdirSync(versionedHome, { recursive: true });
    fs.writeFileSync(path.join(versionedHome, 'auth.json'), '{"token":"real"}');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves the home untouched on non-darwin platforms', () => {
    const out = resolveCodexHome(versionedHome, agentsUserDir, '0.143.0', 'linux');
    expect(out).toBe(versionedHome);
    expect(fs.lstatSync(versionedHome).isSymbolicLink()).toBe(false);
  });

  it('leaves a short-enough home untouched even on darwin', () => {
    // Deliberately NOT derived from os.tmpdir(): macOS hands out a ~66-char
    // `/var/folders/<hash>/T/...` prefix that overflows SUN_LEN on its own, so a
    // tmp-based "short" home isn't short. resolveCodexHome returns before it
    // touches the filesystem when the home fits, so a synthetic path exercises
    // the same branch without needing to exist on disk.
    const shortHome = path.join(path.sep, 'tmp', 'c', '.codex');
    expect(codexHomeOverflowsSunLen(shortHome)).toBe(false);
    const out = resolveCodexHome(shortHome, agentsUserDir, '0.143.0', 'darwin');
    expect(out).toBe(shortHome);
  });

  // Skipped on Windows: the migration leaves a symlink behind, which needs
  // elevated privileges (or developer mode) on Windows runners. SUN_LEN is a
  // macOS-only Unix-socket constraint and resolveCodexHome no-ops off darwin, so
  // there is nothing Windows-specific to cover here.
  it.skipIf(process.platform === 'win32')('migrates an overflowing home to a short real dir and symlinks the old path', () => {
    const out = resolveCodexHome(versionedHome, agentsUserDir, '0.143.0', 'darwin');
    const expectedShort = shortCodexHome(agentsUserDir, '0.143.0');

    expect(out).toBe(expectedShort);
    // That the derived short home fits under SUN_LEN is asserted against a real
    // ~/.agents dir in the helper suite above; it cannot hold under a long
    // /var/folders tmp base, so don't re-assert it here.
    expect(fs.lstatSync(expectedShort).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(expectedShort, 'auth.json'))).toBe(true);
    expect(fs.readFileSync(path.join(expectedShort, 'auth.json'), 'utf8')).toContain('real');
    // The versioned path is now a symlink to the short real home.
    expect(fs.lstatSync(versionedHome).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(versionedHome)).toBe(fs.realpathSync(expectedShort));
  });

  it('is idempotent: a second call returns the short home without error', () => {
    const first = resolveCodexHome(versionedHome, agentsUserDir, '0.143.0', 'darwin');
    const second = resolveCodexHome(versionedHome, agentsUserDir, '0.143.0', 'darwin');
    expect(second).toBe(first);
    expect(fs.existsSync(path.join(first, 'auth.json'))).toBe(true);
  });
});

describe('codexHomeShimBash', () => {
  const bash = codexHomeShimBash('$VERSION_DIR/home/.codex', '$AGENTS_USER_DIR/.codex-homes/$VERSION');

  it('honors a caller-set CODEX_HOME and defaults to the versioned home', () => {
    expect(bash).toContain('if [ -z "${CODEX_HOME:-}" ]; then');
    expect(bash).toContain('CODEX_HOME="$VERSION_DIR/home/.codex"');
    expect(bash).toContain('export CODEX_HOME');
  });

  it('guards the SUN_LEN limit on darwin and relocates to the short home', () => {
    expect(bash).toContain('"$(uname -s)" = "Darwin"');
    expect(bash).toContain('$(( ${#CODEX_HOME} + 43 ))" -gt 104');
    expect(bash).toContain('_codex_short="$AGENTS_USER_DIR/.codex-homes/$VERSION/.codex"');
    expect(bash).toContain('mv "$CODEX_HOME" "$_codex_short"');
    expect(bash).toContain('ln -snf "$_codex_short" "$CODEX_HOME"');
  });
});
