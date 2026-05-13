/**
 * Tests for the lib/import helpers backing the `agents import` command.
 *
 * Scope: pure-function coverage only.
 *
 * - resolvePackageDirFromBinary is pure (filesystem reads only, no state),
 *   so it's straightforward to exercise.
 *
 * - importAgentBinary is intentionally NOT tested here. It depends on
 *   getVersionDir() from versions.js, which routes through state.js's
 *   module-cached HISTORY_DIR. Mocking those modules under bun (the project's
 *   test runner) leaks across files because vi.mock isn't file-scoped in bun.
 *   Setting $HOME in beforeEach has no effect because the path constants
 *   are already cached. Integration coverage for importAgentBinary should
 *   land in a follow-up that either (a) injects versionDir via a parameter or
 *   (b) runs the test under vitest where vi.mock isolation works as designed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { resolvePackageDirFromBinary } from '../import.js';

function makeFakeNpmPkg(root: string, name: string, version: string, cliCommand: string): {
  pkgDir: string;
  binDir: string;
  binarySource: string;
} {
  const pkgDir = path.join(root, 'fake-global', 'node_modules', name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, bin: { [cliCommand]: 'dist/index.js' } }, null, 2)
  );
  const distDir = path.join(pkgDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const binarySource = path.join(distDir, 'index.js');
  fs.writeFileSync(binarySource, '#!/usr/bin/env node\nconsole.log("fake");\n');
  fs.chmodSync(binarySource, 0o755);

  // Mirror the homebrew layout: /opt/homebrew/bin/<cmd> -> ../lib/node_modules/<pkg>/dist/index.js
  const binDir = path.join(root, 'fake-global', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(binarySource, path.join(binDir, cliCommand));

  return { pkgDir, binDir, binarySource };
}

describe('resolvePackageDirFromBinary', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-import-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves a homebrew-style symlinked binary to its package dir', () => {
    const { pkgDir, binDir } = makeFakeNpmPkg(tmp, 'openclaw', '2026.3.8', 'openclaw');
    const binaryPath = path.join(binDir, 'openclaw');

    const resolved = resolvePackageDirFromBinary(binaryPath);
    // resolvePackageDirFromBinary uses realpathSync internally — match on
    // both sides so macOS /var → /private/var doesn't trip the assertion.
    expect(resolved).toBe(fs.realpathSync(pkgDir));
  });

  it('returns null for a binary that has no package.json on the walk-up', () => {
    const bareDir = path.join(tmp, 'bare');
    fs.mkdirSync(bareDir, { recursive: true });
    const binaryPath = path.join(bareDir, 'standalone');
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(binaryPath, 0o755);

    const resolved = resolvePackageDirFromBinary(binaryPath);
    expect(resolved).toBeNull();
  });

  it('returns null when the binary path itself does not exist', () => {
    const resolved = resolvePackageDirFromBinary(path.join(tmp, 'does-not-exist'));
    expect(resolved).toBeNull();
  });
});
