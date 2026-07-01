import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  addShimsToPath,
  generateShimScript,
  generateVersionedAliasScript,
  hasAliasShadowingShim,
  removeLegacyUserShim,
  SHIM_SCHEMA_VERSION,
  VERSIONED_ALIAS_SCHEMA_VERSION,
} from '../shims.js';

const originalHome = process.env.HOME;
const originalShell = process.env.SHELL;
const SHIMS_FIXTURES_DIR = path.join(import.meta.dirname, 'testdata', 'shims');

interface ShimFixtureCase {
  shell: string;
  alreadyPresent?: boolean;
}

// The shim PATH-block rewrite (addShimsToPath) is POSIX shell-rc logic and
// operates on LF-delimited lines. Git can check these text fixtures out with
// CRLF on Windows, so fold to LF on read — otherwise the comparison fails on a
// pure line-ending difference that never occurs in a real POSIX rc file.
const toLF = (s: string): string => s.replace(/\r\n/g, '\n');

function readShimFixture(name: string): { meta: ShimFixtureCase; before: string; after: string } {
  const meta = JSON.parse(fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.json`), 'utf8')) as ShimFixtureCase;
  const before = toLF(fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.before`), 'utf8'));
  const after = toLF(fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.after`), 'utf8'));
  return { meta, before, after };
}

describe('addShimsToPath', () => {
  let home: string;
  let shimsDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shims-test-'));
    shimsDir = path.join(home, '.agents-system', 'shims');
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cases = [
    'zsh-reorder-before-nvm',
    'zsh-idempotent',
    'bash-insert-before-node-path',
    'fish-replace-legacy-path',
    'zsh-ignore-lookalike-paths',
    'zsh-append-after-installer-blocks',
  ] as const;

  for (const fixtureName of cases) {
    it(`rewrites rc files correctly for ${fixtureName}`, () => {
      const fixture = readShimFixture(fixtureName);
      process.env.SHELL = fixture.meta.shell;
      const rcFile = path.basename(fixture.meta.shell) === 'fish' ? '.config/fish/config.fish' : path.basename(fixture.meta.shell) === 'zsh' ? '.zshrc' : '.bashrc';
      const rcPath = path.join(home, rcFile);

      fs.mkdirSync(path.dirname(rcPath), { recursive: true });
      fs.writeFileSync(rcPath, fixture.before.replaceAll('__SHIMS_DIR__', shimsDir), 'utf8');

      const result = addShimsToPath({ homeDir: home, shell: fixture.meta.shell, shimsDir });
      expect(result).toEqual({
        success: true,
        ...(fixture.meta.alreadyPresent ? { alreadyPresent: true } : {}),
        rcFile,
        location: `~/${rcFile}`,
        reloadHint: `Restart your shell or run: source ~/${rcFile}`,
      });

      const content = toLF(fs.readFileSync(rcPath, 'utf8'));
      const expected = fixture.after.replaceAll('__SHIMS_DIR__', shimsDir).trimEnd();
      expect(content.trimEnd()).toBe(expected);
    });
  }
});

describe('SHIM_SCHEMA_VERSION', () => {
  it('is 19 (droid binary resolution branch in dispatcher)', () => {
    expect(SHIM_SCHEMA_VERSION).toBe(19);
  });
});

describe('generateShimScript — configDirName derivation', () => {
  it('produces the unchanged ".claude" subdir for claude (regression guard)', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('home/.claude');
    expect(script).not.toContain('home/./.claude');
  });

  it('produces the nested ".gemini/antigravity-cli" path for antigravity', () => {
    // antigravity's configDir nests inside gemini's parent. The version-home
    // path must carry the full subpath so per-version sync lands correctly.
    const script = generateVersionedAliasScript('antigravity', '1.0.1');
    expect(script).toContain('versions/antigravity/1.0.1');
  });
});

describe('generateShimScript — config-dir env vars', () => {
  it('exports CLAUDE_CONFIG_DIR for claude', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('export CLAUDE_CONFIG_DIR=');
    expect(script).not.toContain('export CODEX_HOME=');
  });

  it('exports CODEX_HOME for codex so the versioned config/rules are read', () => {
    const script = generateShimScript('codex');
    expect(script).toContain('export CODEX_HOME=');
    expect(script).toContain('"$VERSION_DIR/home/.codex"');
    expect(script).not.toContain('export CLAUDE_CONFIG_DIR=');
  });

  it('exports KIMI_CODE_HOME for kimi so config/sessions/skills are versioned', () => {
    const script = generateShimScript('kimi');
    expect(script).toContain('export KIMI_CODE_HOME=');
    expect(script).toContain('"$VERSION_DIR/home/.kimi-code"');
  });

  it('does not export a managed config-dir var for other agents', () => {
    const script = generateShimScript('opencode');
    expect(script).not.toContain('export CLAUDE_CONFIG_DIR=');
    expect(script).not.toContain('export CODEX_HOME=');
  });
});

describe('generateVersionedAliasScript', () => {
  it('uses ~/.agents/.history for direct alias binary and config paths', () => {
    const script = generateVersionedAliasScript('codex', '0.125.0');
    expect(VERSIONED_ALIAS_SCHEMA_VERSION).toBe(8);
    expect(script).toContain('$HOME/.agents/.history/versions/codex/0.125.0');
    expect(script).not.toContain('$HOME/.agents-system/versions/codex/0.125.0');
  });

  // Regression: node_modules/.bin is correct for npm-packaged agents, but Grok,
  // Kimi, and Droid ship their binaries elsewhere. Hardcoding node_modules made
  // every versioned alias for these three (the path `agents teams` takes once it
  // pins a teammate) fail with "<agent>@<version> not installed".
  it('resolves npm-packaged agents from node_modules/.bin', () => {
    const script = generateVersionedAliasScript('codex', '0.125.0');
    expect(script).toContain('node_modules/.bin/codex');
  });

  it('resolves droid from ~/.local/bin/droid, not node_modules', () => {
    const script = generateVersionedAliasScript('droid', '0.159.1');
    expect(script).toContain('DROID_BINARY="$HOME/.local/bin/droid"');
    expect(script).not.toContain('node_modules/.bin/droid');
  });

  it('resolves grok from ~/.grok/downloads and exports GROK_HOME', () => {
    const script = generateVersionedAliasScript('grok', '0.2.33');
    expect(script).toContain('GROK_DOWNLOADS="$HOME/.grok/downloads"');
    expect(script).not.toContain('node_modules/.bin/grok');
    expect(script).toContain('export GROK_HOME=');
  });

  it('resolves kimi from ~/.kimi-code/bin, not node_modules', () => {
    const script = generateVersionedAliasScript('kimi', '0.12.1');
    expect(script).toContain('KIMI_BINARY="$HOME/.kimi-code/bin/kimi"');
    expect(script).not.toContain('node_modules/.bin/kimi');
    expect(script).toContain('export KIMI_CODE_HOME=');
  });
});

describe('removeLegacyUserShim', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-legacy-shim-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('removes ~/.agents/shims/<cli> when it exists and returns true', () => {
    const legacyShimsDir = path.join(home, '.agents', 'shims');
    const legacyShim = path.join(legacyShimsDir, 'claude');
    fs.mkdirSync(legacyShimsDir, { recursive: true });
    fs.writeFileSync(legacyShim, '#!/bin/sh\necho legacy\n');

    expect(removeLegacyUserShim('claude', { homeDir: home })).toBe(true);
    expect(fs.existsSync(legacyShim)).toBe(false);
    // Empty dir cleanup is best-effort — verify it was removed too.
    expect(fs.existsSync(legacyShimsDir)).toBe(false);
  });

  it('returns false when no legacy shim exists', () => {
    expect(removeLegacyUserShim('claude', { homeDir: home })).toBe(false);
  });

  it('does not touch sibling files in ~/.agents/shims/', () => {
    const legacyShimsDir = path.join(home, '.agents', 'shims');
    fs.mkdirSync(legacyShimsDir, { recursive: true });
    fs.writeFileSync(path.join(legacyShimsDir, 'claude'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(legacyShimsDir, 'something-else'), 'do not touch');

    expect(removeLegacyUserShim('claude', { homeDir: home })).toBe(true);
    expect(fs.existsSync(path.join(legacyShimsDir, 'something-else'))).toBe(true);
  });
});

describe('generateShimScript', () => {
  it('contains no reference to .agents-version', () => {
    const script = generateShimScript('claude');
    expect(script).not.toContain('.agents-version');
  });

  it('embeds the shim schema version marker matching SHIM_SCHEMA_VERSION', () => {
    const script = generateShimScript('claude');
    expect(script).toContain(`agents-shim-version: ${SHIM_SCHEMA_VERSION}`);
  });

  it('walks up looking for agents.yaml (not .agents-version)', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('agents.yaml');
  });

  it('skips $HOME/.agents/agents.yaml when walking up', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('user_agents_yaml');
    expect(script).toContain('$HOME/.agents/agents.yaml');
    expect(script).toContain('"$candidate" != "$user_agents_yaml"');
  });

  it('error message references agents.yaml not .agents-version', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('required by agents.yaml but not installed');
    expect(script).not.toContain('required by .agents-version');
  });

  it('does not run foreground project resource sync on the launch hot path', () => {
    const script = generateShimScript('claude');
    expect(script).not.toContain('find_project_agents_dir');
    // sync IS allowed on the hot path, but only with --launch (filesystem-only,
    // sub-50ms, non-blocking). A foreground sync without --launch is forbidden.
    expect(script).not.toMatch(/\bsync --agent "\$AGENT"(?![^\n]*--launch)/);
    expect(script).not.toContain('refresh-rules --agent "$AGENT"');
  });

  it('includes find_latest_installed that handles semver and date-based versions', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('find_latest_installed()');
    expect(script).toContain('split(cur, a, /[^0-9]+/)');
  });

  it('proposes latest installed when no default is configured', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('no default set for $AGENT');
    expect(script).toContain('Set as default and continue?');
    expect(script).toContain('"$AGENTS_BIN" use "$AGENT" "$LATEST"');
  });

  it('proposes switching to latest installed when configured version is missing', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('not installed — found $AGENT@$LATEST installed');
    expect(script).toContain('Switch default to $AGENT@$LATEST and continue?');
  });

  it('falls back gracefully when no versions are installed at all', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('no version of $AGENT configured');
    expect(script).toContain('Run: agents add $AGENT@<version>');
  });

  it('reads answer from /dev/tty not stdin so piped input does not trigger prompt', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('read -r _ans </dev/tty');
  });

  it('uses an absolute agents-cli entrypoint for cold-path helper calls only', () => {
    const script = generateShimScript('codex');
    const match = script.match(/^AGENTS_BIN='([^']+)'$/m);

    expect(match).not.toBeNull();
    expect(path.isAbsolute(match![1])).toBe(true);
    expect(script).toContain('"$AGENTS_BIN" use "$AGENT" "$LATEST"');
    expect(script).toContain('"$AGENTS_BIN" add "$AGENT@$VERSION" --yes');
    expect(script).not.toMatch(/^\s*agents (refresh-rules|use|add|sync)\b/m);
    expect(script).not.toContain('"$AGENTS_BIN" refresh-rules');
    // sync IS called on the hot path, but only with --launch (filesystem-only,
    // sub-50ms, non-blocking). A foreground sync without --launch is forbidden.
    expect(script).not.toMatch(/"\$AGENTS_BIN" sync\b(?![^\n]*--launch)/);
  });

  it('fails clearly when the embedded agents-cli entrypoint is not executable', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('if [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then');
    expect(script).toContain('agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN');
    expect(script).toContain('exit 127');
  });
});

describe('hasAliasShadowingShim', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-alias-test-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns true when an alias is defined without a later unalias', () => {
    fs.writeFileSync(
      path.join(home, '.zshrc'),
      'alias codex="codex --sandbox workspace-write"\n',
      'utf8',
    );
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(true);
  });

  it('returns false when a later unalias removes the alias', () => {
    fs.writeFileSync(
      path.join(home, '.zshrc'),
      [
        'alias codex="codex --sandbox workspace-write"',
        'unalias claude codex gemini 2>/dev/null || true',
      ].join('\n'),
      'utf8',
    );
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(false);
  });
});

// Regression: two agents-cli installs with different SHIM_SCHEMA_VERSION sharing
// ~/.agents/.cache/shims/ used to ping-pong — each regenerated every shim whose
// embedded marker !== its own constant, so they took turns rewriting all shims
// on every launch. ensureShimCurrent is now upgrade-only: it never downgrades a
// shim stamped by a newer install. (SHIMS_DIR is derived from HOME at module
// load, so re-import under a temp HOME to keep the real shims dir untouched.)
describe('ensureShimCurrent — upgrade-only / newest-wins', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-current-'));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.resetModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeShim(shimPath: string, marker: string): void {
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, `#!/bin/bash\n# ${marker}\nexec true\n`, { mode: 0o755 });
  }

  it('does NOT downgrade a shim stamped by a newer install', async () => {
    const mod = await import('../shims.js');
    const shimPath = mod.getShimPath('claude');
    const newer = mod.SHIM_SCHEMA_VERSION + 1;
    writeShim(shimPath, `agents-shim-version: ${newer}`);
    const before = fs.readFileSync(shimPath, 'utf8');

    expect(mod.ensureShimCurrent('claude')).toBe('current');
    expect(fs.readFileSync(shimPath, 'utf8')).toBe(before); // left untouched
  });

  it('regenerates a shim from an older install (upgrade)', async () => {
    const mod = await import('../shims.js');
    const shimPath = mod.getShimPath('claude');
    writeShim(shimPath, 'agents-shim-version: 1');

    expect(mod.ensureShimCurrent('claude')).toBe('updated');
    expect(fs.readFileSync(shimPath, 'utf8')).toContain(
      `agents-shim-version: ${mod.SHIM_SCHEMA_VERSION}`,
    );
  });

  it('regenerates an unversioned (pre-marker) shim', async () => {
    const mod = await import('../shims.js');
    const shimPath = mod.getShimPath('claude');
    writeShim(shimPath, 'no marker here');

    expect(mod.ensureShimCurrent('claude')).toBe('updated');
  });

  it('leaves a current shim untouched', async () => {
    const mod = await import('../shims.js');
    mod.createShim('claude');
    expect(mod.ensureShimCurrent('claude')).toBe('current');
  });
});
