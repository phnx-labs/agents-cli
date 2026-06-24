import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { registerHooksToSettings, unmanagedHookNames } from '../hooks.js';
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

describe('unmanagedHookNames', () => {
  it('flags installed hooks whose name matches no manifest script basename', () => {
    const installed = [
      '00-agent-verify-work-complete', // system script, no manifest entry → dead
      '02-expand-prompt-bang-commands', // dead
      '03-linear-inject-tasks-context', // manifest-declared → registered
      'git-guard', // manifest-declared → registered
    ];
    const manifestScripts = ['03-linear-inject-tasks-context.sh', 'git-guard.sh', 'rm-guard.sh'];
    expect(unmanagedHookNames(installed, manifestScripts)).toEqual([
      '00-agent-verify-work-complete',
      '02-expand-prompt-bang-commands',
    ]);
  });

  it('matches on script basename regardless of extension (.sh, .py)', () => {
    // Manifest scripts can carry any extension; the installed name is ext-stripped.
    expect(unmanagedHookNames(['guard'], ['guard.py'])).toEqual([]);
    expect(unmanagedHookNames(['guard'], ['guard.sh'])).toEqual([]);
  });

  it('returns nothing when every installed hook is declared', () => {
    expect(unmanagedHookNames(['a', 'b'], ['a.sh', 'b.sh'])).toEqual([]);
  });

  it('returns all installed hooks when the manifest is empty', () => {
    expect(unmanagedHookNames(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

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

  it('returns no-op for agents other than claude/codex/gemini/antigravity', () => {
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };
    const result = registerHooksToSettings('opencode', path.join(tmpDir, 'home'), manifest, agentsDir);
    expect(result.registered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('writes grok hook JSON files for PreToolUse events', () => {
    fs.writeFileSync(path.join(agentsDir, 'hooks', 'on-prompt.sh'), '#!/bin/sh\necho hi\n');
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['PreToolUse'] },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> PreToolUse');
    const mainPath = path.join(versionHome, '.grok', 'hooks', 'hooks.json');
    expect(fs.existsSync(mainPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(parsed.hooks.PreToolUse[0].hooks[0].type).toBe('command');
  });
});

describe('registerHooksToSettings - Antigravity', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAgyVersionHome(): string {
    const home = path.join(tmpDir, 'agy-home');
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    return home;
  }

  function readAgySettings(home: string): Record<string, any> {
    return JSON.parse(
      fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf-8')
    );
  }

  it('writes settings.json at ~/.gemini/antigravity-cli/ with flat hooks arrays', () => {
    const versionHome = makeAgyVersionHome();
    const scriptPath = makeScript('pre-tool.sh');

    const manifest: Record<string, ManifestHook> = {
      'pre-tool': {
        script: 'pre-tool.sh',
        events: ['PreToolUse'],
      },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);

    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('pre-tool -> before_tool_call');

    const settings = readAgySettings(versionHome);
    expect(settings.hooks).toBeDefined();
    expect(Array.isArray(settings.hooks.before_tool_call)).toBe(true);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(settings.hooks.before_tool_call[0]).toEqual({ command: scriptPath });
  });

  it('maps all four supported events: PreToolUse, PostToolUse, Stop, OnError', () => {
    const versionHome = makeAgyVersionHome();
    makeScript('a.sh');
    makeScript('b.sh');
    makeScript('c.sh');
    makeScript('d.sh');

    const manifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
      b: { script: 'b.sh', events: ['PostToolUse'] },
      c: { script: 'c.sh', events: ['Stop'] },
      d: { script: 'd.sh', events: ['OnError'] },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(settings.hooks.after_model_call).toHaveLength(1);
    expect(settings.hooks.on_loop_stop).toHaveLength(1);
    expect(settings.hooks.on_error).toHaveLength(1);
  });

  it('expands a hook with multiple events into one entry per agy event', () => {
    const versionHome = makeAgyVersionHome();
    const scriptPath = makeScript('multi.sh');

    const manifest: Record<string, ManifestHook> = {
      multi: { script: 'multi.sh', events: ['PreToolUse', 'PostToolUse', 'Stop'] },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toHaveLength(3);

    const settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call[0].command).toBe(scriptPath);
    expect(settings.hooks.after_model_call[0].command).toBe(scriptPath);
    expect(settings.hooks.on_loop_stop[0].command).toBe(scriptPath);
  });

  it('silently skips unmapped events (e.g. UserPromptSubmit)', () => {
    const versionHome = makeAgyVersionHome();
    makeScript('prompt.sh');
    makeScript('tool.sh');

    const manifest: Record<string, ManifestHook> = {
      // UserPromptSubmit has no agy equivalent — must not error, must not register
      prompt: { script: 'prompt.sh', events: ['UserPromptSubmit'] },
      tool: { script: 'tool.sh', events: ['PreToolUse'] },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toEqual(['tool -> before_tool_call']);

    const settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
  });

  it('preserves existing non-hooks settings.json content', () => {
    const versionHome = makeAgyVersionHome();
    const settingsPath = path.join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        permissions: { allow: ['Bash(ls:*)'] },
      }, null, 2)
    );

    makeScript('pre-tool.sh');
    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'] },
    };

    registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);

    const settings = readAgySettings(versionHome);
    expect(settings.theme).toBe('dark');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.hooks.before_tool_call).toHaveLength(1);
  });

  it('prunes removed managed entries on subsequent sync (GC invariant)', () => {
    const versionHome = makeAgyVersionHome();
    makeScript('a.sh');
    makeScript('b.sh');

    const firstManifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
      b: { script: 'b.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, firstManifest, agentsDir);

    let settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(2);

    // Smaller manifest — 'b' was deleted upstream
    const secondManifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, secondManifest, agentsDir);

    settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
    expect(settings.hooks.before_tool_call[0].command).toContain('a.sh');
  });

  it('never touches user-authored entries outside managedPrefixes', () => {
    const versionHome = makeAgyVersionHome();
    const settingsPath = path.join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');

    // Pre-seed with a user-authored hook outside the managed hooks dir
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          before_tool_call: [{ command: '/usr/local/bin/my-user-hook.sh' }],
        },
      }, null, 2)
    );

    makeScript('managed.sh');
    const manifest: Record<string, ManifestHook> = {
      managed: { script: 'managed.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);

    const settings = readAgySettings(versionHome);
    // Both entries should coexist — user hook untouched, managed hook added
    expect(settings.hooks.before_tool_call).toHaveLength(2);
    expect(settings.hooks.before_tool_call[0].command).toBe('/usr/local/bin/my-user-hook.sh');
  });

  it('does not duplicate entries on repeated calls', () => {
    const versionHome = makeAgyVersionHome();
    makeScript('pre-tool.sh');

    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'] },
    };

    registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);

    const settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(1);
  });

  it('returns error when script file does not exist', () => {
    const versionHome = makeAgyVersionHome();
    const manifest: Record<string, ManifestHook> = {
      missing: { script: 'does-not-exist.sh', events: ['PreToolUse'] },
    };

    const result = registerHooksToSettings('antigravity', versionHome, manifest, agentsDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('missing');
  });
});

describe('registerHooksToSettings - Claude', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeClaudeVersionHome(): string {
    const home = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    return home;
  }

  function readClaudeSettings(home: string): Record<string, any> {
    return JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8')
    );
  }

  it('preserves env, mcpServers, permissions, and custom top-level keys (regression #137)', () => {
    const versionHome = makeClaudeVersionHome();
    const settingsPath = path.join(versionHome, '.claude', 'settings.json');

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { FOO: 'bar', DEBUG: 'true' },
        mcpServers: {
          fooServer: { command: '/bin/foo', args: ['--bar'] },
        },
        permissions: { allow: ['Bash(ls:*)'], deny: [] },
        customKey: { nested: 'preserved' },
      }, null, 2)
    );

    const scriptPath = makeScript('pre-tool.sh');
    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };

    const result = registerHooksToSettings('claude', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('pre-tool -> PreToolUse');

    const settings = readClaudeSettings(versionHome);

    expect(settings.env).toEqual({ FOO: 'bar', DEBUG: 'true' });
    expect(settings.mcpServers).toEqual({
      fooServer: { command: '/bin/foo', args: ['--bar'] },
    });
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'], deny: [] });
    expect(settings.customKey).toEqual({ nested: 'preserved' });

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(scriptPath);
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');
  });

  it('writes hooks alongside an empty pre-existing settings.json', () => {
    const versionHome = makeClaudeVersionHome();
    const scriptPath = makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('claude', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readClaudeSettings(versionHome);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(scriptPath);
  });
});
