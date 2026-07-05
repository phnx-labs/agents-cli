import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { generateShimScript, generateVersionedAliasScript, hasAliasShadowingShim, shimTargetsFor, onDiskShimFile, SHIM_SCHEMA_VERSION } from './shims.js';
import { getProjectVersion } from './versions.js';

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

  it('disables the Claude Code auto-updater in the claude shim, honoring an explicit value', () => {
    // Pinned per-version installs must not self-mutate. The `:-1` default lets a
    // user-set DISABLE_AUTOUPDATER win while defaulting to disabled otherwise.
    const script = generateShimScript('claude');
    expect(script).toContain('export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"');
  });

  it('does not touch DISABLE_AUTOUPDATER for the codex shim (codex path unchanged)', () => {
    const script = generateShimScript('codex');
    expect(script).not.toContain('DISABLE_AUTOUPDATER');
    // codex keeps its own suppression flag, injected at exec.
    expect(script).toContain('-c check_for_update_on_startup=false');
  });
});

describe('generateVersionedAliasScript', () => {
  it('disables the Claude Code auto-updater in a claude@version alias, honoring an explicit value', () => {
    const script = generateVersionedAliasScript('claude', '2.1.196');
    expect(script).toContain('export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"');
  });

  it('does not touch DISABLE_AUTOUPDATER for a codex@version alias (codex path unchanged)', () => {
    const script = generateVersionedAliasScript('codex', '0.20.0');
    expect(script).not.toContain('DISABLE_AUTOUPDATER');
    expect(script).toContain('-c check_for_update_on_startup=false');
  });

  it('execs normally for a valid project agents.yaml version', () => {
    const dir = makeTempDir();
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    const fakeAgents = path.join(dir, 'agents');
    const versionDir = path.join(home, '.agents', '.history', 'versions', 'claude', '2.0.65');
    const binary = path.join(versionDir, 'node_modules', '.bin', 'claude');
    const logPath = path.join(dir, 'exec.log');

    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(path.join(project, 'agents.yaml'), 'agents:\n  claude: "2.0.65"\n', 'utf-8');
    fs.writeFileSync(fakeAgents, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(binary, `#!/bin/sh\nprintf "ran:%s\\n" "$1" >> ${JSON.stringify(logPath)}\n`, { mode: 0o755 });

    const shimPath = path.join(dir, 'claude-shim');
    const shim = generateShimScript('claude').replace(/^AGENTS_BIN=.*$/m, `AGENTS_BIN=${JSON.stringify(fakeAgents)}`);
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    const result = spawnSync('bash', [shimPath, 'ok'], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('ran:ok');
  });

  it('rejects a project agents.yaml traversal version before exec', () => {
    const dir = makeTempDir();
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    const fakeAgents = path.join(dir, 'agents');
    const logPath = path.join(dir, 'exec.log');

    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'agents.yaml'), 'agents:\n  claude: "../../../tmp/pwn"\n', 'utf-8');
    fs.writeFileSync(fakeAgents, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const shimPath = path.join(dir, 'claude-shim');
    const shim = generateShimScript('claude').replace(/^AGENTS_BIN=.*$/m, `AGENTS_BIN=${JSON.stringify(fakeAgents)}`);
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    const result = spawnSync('bash', [shimPath], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid version in agents.yaml for claude: ../../../tmp/pwn');
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('rejects traversal versions in getProjectVersion', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'agents.yaml'), 'agents:\n  claude: "../../../tmp/pwn"\n', 'utf-8');

    expect(() => getProjectVersion('claude', dir)).toThrow(
      'Invalid version in agents.yaml for claude: ../../../tmp/pwn. Allowed: latest or [A-Za-z0-9._+-]{1,64}'
    );
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

describe('hasAliasShadowingShim', () => {
  function makeFakeHome(rc: string): string {
    const home = makeTempDir();
    fs.writeFileSync(path.join(home, '.zshrc'), rc);
    return home;
  }

  it('returns true for a plain `alias codex=...`', () => {
    const home = makeFakeHome(`alias codex='codex --foo'\n`);
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(true);
  });

  it('returns false when a later `unalias codex` cancels an earlier alias', () => {
    // Real-world: rc declares an alias near the top, then a cleanup block
    // unalias's a list of names later. Static regex on whole-file content
    // (the previous implementation) reported true here.
    const home = makeFakeHome(
      `alias codex="codex --sandbox workspace-write"\n# ... more rc ...\nunalias claude codex gemini 2>/dev/null || true\n`,
    );
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(false);
  });

  it('returns true when alias appears AFTER a prior unalias for the same name', () => {
    const home = makeFakeHome(`unalias codex 2>/dev/null || true\nalias codex='codex --foo'\n`);
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(true);
  });

  it('returns false when only an unalias is present', () => {
    const home = makeFakeHome(`unalias codex 2>/dev/null || true\n`);
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(false);
  });

  it('returns false when the rc file mentions a different command', () => {
    const home = makeFakeHome(`alias claude='claude --foo'\n`);
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(false);
  });
});

describe('shimTargetsFor (drop the vestigial bash shim on Windows)', () => {
  it('POSIX writes only the extensionless bash shim', () => {
    expect(shimTargetsFor('linux')).toEqual({ bash: true, cmd: false });
    expect(shimTargetsFor('darwin')).toEqual({ bash: true, cmd: false });
  });

  it('win32 writes only the .cmd companion — the bash file is never executed there', () => {
    expect(shimTargetsFor('win32')).toEqual({ bash: false, cmd: true });
  });
});

describe('onDiskShimFile (exists/remove must match what createShim writes)', () => {
  // Regression guard: createShim writes only `<cmd>.cmd` on Windows, so
  // shimExists/removeShim/readShimSchemaVersion must stat the SAME file. Deriving
  // this from shimTargetsFor makes the two sides impossible to drift apart — the
  // bug where the write side skipped the bare file but the check side still
  // looked for it (orphaned .cmd on remove, regenerate-every-launch).
  it('returns the .cmd companion on Windows', () => {
    expect(onDiskShimFile('claude', 'win32')).toBe('claude.cmd');
  });

  it('returns the bare script on POSIX', () => {
    expect(onDiskShimFile('claude', 'linux')).toBe('claude');
    expect(onDiskShimFile('codex', 'darwin')).toBe('codex');
  });

  it('agrees with shimTargetsFor for every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const expectsCmd = shimTargetsFor(platform).cmd;
      expect(onDiskShimFile('claude', platform).endsWith('.cmd')).toBe(expectsCmd);
    }
  });
});
