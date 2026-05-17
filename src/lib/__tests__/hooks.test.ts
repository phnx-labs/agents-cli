import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { registerHooksToSettings } from '../hooks.js';
import { CODEX_HOOKS_MIN_VERSION } from '../agents.js';
import { compareVersions } from '../versions.js';
import type { ManifestHook } from '../types.js';

let agentsDir: string;
let tmpDir: string;

function makeScript(name: string): string {
  const scriptPath = path.join(agentsDir, 'hooks', name);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', 'utf-8');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeVersionHome(): string {
  const home = path.join(tmpDir, 'version-home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

describe('registerHooksToSettings - Codex', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes hooks.json with correct nested schema for UserPromptSubmit', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit'],
        timeout: 30,
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> UserPromptSubmit');

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );

    // Top-level "hooks" wrapper must exist
    expect(hooksJson).toHaveProperty('hooks');

    // Event array holds matcher-group objects
    const groups = hooksJson.hooks.UserPromptSubmit;
    expect(groups).toHaveLength(1);

    // UserPromptSubmit groups must NOT have a matcher field
    expect(groups[0]).not.toHaveProperty('matcher');

    // Nested hooks array holds the actual command entry
    expect(groups[0].hooks).toHaveLength(1);
    expect(groups[0].hooks[0].command).toBe(scriptPath);
    expect(groups[0].hooks[0].timeout).toBe(30);
    expect(groups[0].hooks[0].type).toBe('command');
  });

  it('writes PreToolUse hook with matcher field', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('bash-tool-hook.sh');

    const manifest: Record<string, ManifestHook> = {
      'bash-hook': {
        script: 'bash-tool-hook.sh',
        events: ['PreToolUse'],
        matcher: 'Bash',
        timeout: 600,
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );

    const groups = hooksJson.hooks.PreToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe('Bash');
    expect(groups[0].hooks[0].command).toBe(scriptPath);
  });

  it('writes [features] codex_hooks = true to config.toml', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const configPath = path.join(versionHome, '.codex', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('codex_hooks = true');
  });

  it('preserves existing config.toml entries when enabling feature flag', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const configPath = path.join(versionHome, '.codex', 'config.toml');
    fs.writeFileSync(configPath, 'approval_policy = "suggest"\n', 'utf-8');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('codex_hooks = true');
    expect(content).toContain('approval_policy');
  });

  it('does not duplicate managed hook entries on repeated calls', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(hooksJson.hooks.UserPromptSubmit[0].hooks).toHaveLength(1);
  });

  it('never touches user-authored entries (managed-prefix guard)', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    // Pre-seed hooks.json with a user-authored hook in the correct nested format
    const hooksPath = path.join(versionHome, '.codex', 'hooks.json');
    const userHook = { type: 'command', command: '/usr/local/bin/my-hook.sh', timeout: 10 };
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [userHook] }] } }, null, 2)
    );

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const hooksJson = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const group = hooksJson.hooks.UserPromptSubmit[0];
    // User hook and managed hook share the no-matcher group; user entry is untouched
    expect(group.hooks).toHaveLength(2);
    expect(group.hooks[0]).toEqual(userHook);
  });

  it('ignores the deprecated agents: field — capability table decides registration', () => {
    // The `agents:` field on a hook entry is deprecated. Registration is
    // driven by the agent capability table now. So a hook authored as
    // `agents: ['claude']` still registers on codex if codex supports the
    // declared event — the field is parsed for back-compat but ignored.
    const versionHome = makeVersionHome();
    makeScript('claude-only.sh');

    const manifest: Record<string, ManifestHook> = {
      'claude-only': {
        script: 'claude-only.sh',
        events: ['UserPromptSubmit'],
        agents: ['claude'],
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.registered).toHaveLength(1);
    expect(fs.existsSync(path.join(versionHome, '.codex', 'hooks.json'))).toBe(true);
  });

  it('UserPromptSubmit group has no matcher even when manifest defines one', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    // Manifest has a matcher — for UserPromptSubmit it must be dropped
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit'],
        matcher: 'some-pattern',
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> UserPromptSubmit');

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    // Group for UserPromptSubmit must not have matcher field
    expect(hooksJson.hooks.UserPromptSubmit[0]).not.toHaveProperty('matcher');
  });

  it('returns error when script file does not exist', () => {
    const versionHome = makeVersionHome();

    const manifest: Record<string, ManifestHook> = {
      'missing-hook': { script: 'does-not-exist.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('missing-hook');
  });

  it('rejects hook scripts that resolve outside the hooks directory', () => {
    const versionHome = makeVersionHome();
    fs.writeFileSync(path.join(agentsDir, 'outside.sh'), '#!/bin/sh\necho outside\n', 'utf-8');

    const manifest: Record<string, ManifestHook> = {
      traversal: { script: '../outside.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.registered).toHaveLength(0);
    expect(result.errors[0]).toContain('script not found');
    expect(fs.existsSync(path.join(versionHome, '.codex', 'hooks.json'))).toBe(false);
  });

  it('resolves benign relative hook script names inside the hooks directory', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('nested/on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      benign: { script: 'nested/on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('benign -> UserPromptSubmit');
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(hooksJson.hooks.UserPromptSubmit[0].hooks[0].command).toBe(scriptPath);
  });
});

describe('CODEX_HOOKS_MIN_VERSION constant', () => {
  it('is set to 0.116.0', () => {
    expect(CODEX_HOOKS_MIN_VERSION).toBe('0.116.0');
  });

  it('correctly gates versions below floor', () => {
    expect(compareVersions('0.113.0', CODEX_HOOKS_MIN_VERSION)).toBeLessThan(0);
    expect(compareVersions('0.115.9', CODEX_HOOKS_MIN_VERSION)).toBeLessThan(0);
  });

  it('correctly passes versions at or above floor', () => {
    expect(compareVersions('0.116.0', CODEX_HOOKS_MIN_VERSION)).toBe(0);
    expect(compareVersions('0.117.0', CODEX_HOOKS_MIN_VERSION)).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', CODEX_HOOKS_MIN_VERSION)).toBeGreaterThan(0);
  });
});

describe('registerHooksToSettings - returns empty for unsupported agents', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns no-op for agents other than claude/codex/gemini', () => {
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };
    const result = registerHooksToSettings('opencode', path.join(tmpDir, 'home'), manifest, agentsDir);
    expect(result.registered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
