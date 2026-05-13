/**
 * Tests for the lib/import helpers backing the `agents import` command.
 *
 * - resolvePackageDirFromBinary is pure (filesystem reads only, no state).
 * - importAgentBinary is exercised with the optional versionDirOverride
 *   parameter pointing at a temp dir, so we never touch the real
 *   ~/.agents/.history/versions/. This avoids needing vi.mock on
 *   state.ts / versions.ts — bun's vi.mock isn't file-scoped and would
 *   leak failures into hooks/versions tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { resolvePackageDirFromBinary, importAgentBinary } from '../import.js';

const OPENCLAW_SPEC = { agentId: 'openclaw', npmPackage: 'openclaw', cliCommand: 'openclaw' };

interface FakePkg {
  pkgDir: string;
  binDir: string;
  binarySource: string;
}

function makeFakeNpmPkg(
  root: string,
  name: string,
  version: string,
  cliCommand: string,
  opts: { binEntry?: string | Record<string, string> | null } = {}
): FakePkg {
  const pkgDir = path.join(root, 'fake-global', 'node_modules', name);
  fs.mkdirSync(pkgDir, { recursive: true });

  const binEntry = opts.binEntry === undefined ? { [cliCommand]: 'dist/index.js' } : opts.binEntry;
  const pkgJson: Record<string, unknown> = { name, version };
  if (binEntry !== null) pkgJson.bin = binEntry;
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

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

describe('importAgentBinary', () => {
  let tmp: string;
  let versionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-import-binary-'));
    // Point the import at a tmp version dir instead of ~/.agents/.history/versions/...
    versionDir = path.join(tmp, '.agents', '.history', 'versions', 'openclaw', '2026.3.8');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a non-destructive symlink farm under the managed version dir', () => {
    const { pkgDir, binarySource } = makeFakeNpmPkg(tmp, 'openclaw', '2026.3.8', 'openclaw');

    const result = importAgentBinary(OPENCLAW_SPEC, '2026.3.8', pkgDir, versionDir);
    expect(result.success).toBe(true);
    expect(result.resolvedFromPath).toBe(pkgDir);

    const managedBinary = path.join(versionDir, 'node_modules', '.bin', 'openclaw');
    const managedPkg = path.join(versionDir, 'node_modules', 'openclaw');
    const marker = path.join(versionDir, 'package.json');

    // All targets are symlinks pointing at the original install — nothing copied.
    expect(fs.lstatSync(managedBinary).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(managedBinary)).toBe(fs.realpathSync(binarySource));
    expect(fs.lstatSync(managedPkg).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(managedPkg)).toBe(fs.realpathSync(pkgDir));

    // Marker package.json records provenance and is marked private.
    const markerJson = JSON.parse(fs.readFileSync(marker, 'utf8'));
    expect(markerJson.imported).toBe(true);
    expect(markerJson.from).toBe(pkgDir);
    expect(markerJson.private).toBe(true);

    // Empty home dir is created for the isolated $HOME.
    expect(fs.existsSync(path.join(versionDir, 'home'))).toBe(true);
  });

  it('returns skipped=true on a second import of the same version', () => {
    const { pkgDir } = makeFakeNpmPkg(tmp, 'openclaw', '2026.3.8', 'openclaw');
    const first = importAgentBinary(OPENCLAW_SPEC, '2026.3.8', pkgDir, versionDir);
    expect(first.success).toBe(true);

    const second = importAgentBinary(OPENCLAW_SPEC, '2026.3.8', pkgDir, versionDir);
    expect(second.success).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.error).toMatch(/already installed/);
  });

  it('fails cleanly when the path is not an npm package', () => {
    const notAPkg = path.join(tmp, 'not-a-package');
    fs.mkdirSync(notAPkg, { recursive: true });

    const result = importAgentBinary(OPENCLAW_SPEC, '2026.3.8', notAPkg, versionDir);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no package\.json/);
  });

  it('fails cleanly when the package has no bin entry for the cli command', () => {
    const { pkgDir } = makeFakeNpmPkg(tmp, 'openclaw', '2026.3.8', 'openclaw', { binEntry: null });

    const result = importAgentBinary(OPENCLAW_SPEC, '2026.3.8', pkgDir, versionDir);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no bin entry/);
  });

  it('fails strictly when bin object is missing the cliCommand key (no fallback)', () => {
    // Multi-bin packages must NOT silently get a wrong bin chosen by
    // Object.values()[0] ordering. Require an exact match on cliCommand.
    const { pkgDir } = makeFakeNpmPkg(tmp, 'openclaw', '2026.3.8', 'openclaw', {
      binEntry: { 'something-else': 'dist/other.js', 'helper': 'dist/helper.js' },
    });

    const result = importAgentBinary(OPENCLAW_SPEC, '2026.3.8', pkgDir, versionDir);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no bin entry for "openclaw"/);
  });

  it('fails when --from-path does not exist', () => {
    const result = importAgentBinary(OPENCLAW_SPEC, '2026.3.8', path.join(tmp, 'does-not-exist'), versionDir);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Path does not exist/);
  });

  it('honors a string-form bin entry (bin: "dist/index.js")', () => {
    const { pkgDir, binarySource } = makeFakeNpmPkg(tmp, 'openclaw', '2026.3.8', 'openclaw', {
      binEntry: 'dist/index.js',
    });

    const result = importAgentBinary(OPENCLAW_SPEC, '2026.3.8', pkgDir, versionDir);
    expect(result.success).toBe(true);

    const managedBinary = path.join(versionDir, 'node_modules', '.bin', 'openclaw');
    expect(fs.realpathSync(managedBinary)).toBe(fs.realpathSync(binarySource));
  });
});
