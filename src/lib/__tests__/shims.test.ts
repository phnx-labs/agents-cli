import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  addShimsToPath,
  generateShimScript,
  generateVersionedAliasScript,
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

function readShimFixture(name: string): { meta: ShimFixtureCase; before: string; after: string } {
  const meta = JSON.parse(fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.json`), 'utf8')) as ShimFixtureCase;
  const before = fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.before`), 'utf8');
  const after = fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.after`), 'utf8');
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
      });

      const content = fs.readFileSync(rcPath, 'utf8');
      expect(content).toBe(fixture.after.replaceAll('__SHIMS_DIR__', shimsDir));
    });
  }
});

describe('SHIM_SCHEMA_VERSION', () => {
  it('is 15 (launch shims do not run foreground resource sync)', () => {
    expect(SHIM_SCHEMA_VERSION).toBe(15);
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

  it('does not export a managed config-dir var for other agents', () => {
    const script = generateShimScript('opencode');
    expect(script).not.toContain('export CLAUDE_CONFIG_DIR=');
    expect(script).not.toContain('export CODEX_HOME=');
  });
});

describe('generateVersionedAliasScript', () => {
  it('uses ~/.agents/.history for direct alias binary and config paths', () => {
    const script = generateVersionedAliasScript('codex', '0.125.0');
    expect(VERSIONED_ALIAS_SCHEMA_VERSION).toBe(7);
    expect(script).toContain('$HOME/.agents/.history/versions/codex/0.125.0');
    expect(script).not.toContain('$HOME/.agents-system/versions/codex/0.125.0');
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

  it('skips $HOME/.agents-system/agents.yaml when walking up', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('user_agents_yaml');
    expect(script).toContain('$HOME/.agents-system/agents.yaml');
    expect(script).toContain('"$candidate" != "$user_agents_yaml"');
  });

  it('error message references agents.yaml not .agents-version', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('required by agents.yaml but not installed');
    expect(script).not.toContain('required by .agents-version');
  });

  it('does not run project resource sync on the launch hot path', () => {
    const script = generateShimScript('claude');
    expect(script).not.toContain('find_project_agents_dir');
    expect(script).not.toContain('sync --agent "$AGENT"');
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
    expect(script).not.toContain('"$AGENTS_BIN" sync');
  });

  it('fails clearly when the embedded agents-cli entrypoint is not executable', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('if [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then');
    expect(script).toContain('agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN');
    expect(script).toContain('exit 127');
  });
});
