import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { generateShimScript, SHIM_SCHEMA_VERSION } from './shims.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shims-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('generateShimScript', () => {
  it('embeds the current schema version marker', () => {
    const script = generateShimScript('claude');
    expect(script).toContain(`agents-shim-version: ${SHIM_SCHEMA_VERSION}`);
  });

  it('sets CLAUDE_CONFIG_DIR for claude shim', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('export CLAUDE_CONFIG_DIR=');
  });

  it('includes .oauth_token Linux fallback for claude shim', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('.oauth_token');
    expect(script).toContain('uname -s');
    expect(script).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('does not include .oauth_token fallback for codex shim', () => {
    const script = generateShimScript('codex');
    expect(script).not.toContain('.oauth_token');
  });
});

describe('claude shim .oauth_token fallback', () => {
  function buildTestShim(dir: string, opts: {
    tokenFileContent?: string;
    envToken?: string;
    shimPlatform?: 'linux' | 'darwin';
  } = {}): { shimPath: string; configDir: string; fakeBin: string; logPath: string } {
    // Fake binary that logs the CLAUDE_CODE_OAUTH_TOKEN env var and exits.
    const fakeBin = path.join(dir, 'claude');
    const logPath = path.join(dir, 'env.log');
    fs.writeFileSync(fakeBin, [
      '#!/bin/sh',
      `printf "TOKEN:%s\\n" "\${CLAUDE_CODE_OAUTH_TOKEN:-<unset>}" >> ${JSON.stringify(logPath)}`,
    ].join('\n'), 'utf-8');
    fs.chmodSync(fakeBin, 0o755);

    // Version directory structure matching what the real shim uses.
    const versionDir = path.join(dir, 'versions', 'claude', '2.1.0');
    const configDir = path.join(versionDir, 'home', '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });
    // Symlink "claude" binary into node_modules/.bin/claude
    const binTarget = path.join(versionDir, 'node_modules', '.bin', 'claude');
    fs.symlinkSync(fakeBin, binTarget);

    if (opts.tokenFileContent !== undefined) {
      fs.writeFileSync(path.join(configDir, '.oauth_token'), opts.tokenFileContent, { mode: 0o600 });
    }

    // Build a minimal shim from the real template but with the dirs patched
    // to point at our temp tree, and uname -s overridden to simulate platform.
    const unameSim = opts.shimPlatform === 'darwin' ? 'Darwin' : 'Linux';
    const shim = [
      '#!/bin/bash',
      `VERSION_DIR=${JSON.stringify(versionDir)}`,
      `BINARY=${JSON.stringify(binTarget)}`,
      `export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/.claude"`,
      // The actual new logic from the shim, with uname -s replaced for test isolation
      `if [ "${unameSim}" = "Linux" ] && [ -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$CLAUDE_CONFIG_DIR/.oauth_token" ]; then`,
      `  CLAUDE_CODE_OAUTH_TOKEN=$(cat "$CLAUDE_CONFIG_DIR/.oauth_token")`,
      `  export CLAUDE_CODE_OAUTH_TOKEN`,
      `fi`,
      `exec "$BINARY" "$@"`,
    ].join('\n');

    const shimPath = path.join(dir, 'shim.sh');
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    return { shimPath, configDir, fakeBin, logPath };
  }

  it('exports token from .oauth_token file on Linux when env var is unset', () => {
    const dir = makeTempDir();
    const { shimPath, logPath } = buildTestShim(dir, {
      tokenFileContent: 'sk-ant-test-linux-token',
      shimPlatform: 'linux',
    });

    const result = spawnSync('bash', [shimPath], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '' },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('TOKEN:sk-ant-test-linux-token');
  });

  it('env var wins over .oauth_token file when already set', () => {
    const dir = makeTempDir();
    const { shimPath, logPath } = buildTestShim(dir, {
      tokenFileContent: 'sk-ant-from-file',
      shimPlatform: 'linux',
    });

    const result = spawnSync('bash', [shimPath], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-from-env' },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('TOKEN:sk-ant-from-env');
    expect(log).not.toContain('sk-ant-from-file');
  });

  it('is a no-op on macOS even when .oauth_token file exists', () => {
    const dir = makeTempDir();
    const { shimPath, logPath } = buildTestShim(dir, {
      tokenFileContent: 'sk-ant-should-not-be-used',
      shimPlatform: 'darwin',
    });

    const result = spawnSync('bash', [shimPath], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '' },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('TOKEN:<unset>');
  });

  it('is a no-op on Linux when .oauth_token file is absent', () => {
    const dir = makeTempDir();
    const { shimPath, logPath } = buildTestShim(dir, {
      shimPlatform: 'linux',
      // no tokenFileContent
    });

    const result = spawnSync('bash', [shimPath], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '' },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('TOKEN:<unset>');
  });
});
