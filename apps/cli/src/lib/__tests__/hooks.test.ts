import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { registerHooksToSettings, unmanagedHookNames, computeCodexHookTrustHash, toPortableCommand, pruneVersionHomeHookEntriesFromSettings } from '../hooks.js';
import * as TOML from 'smol-toml';
import { CODEX_HOOKS_MIN_VERSION } from '../agents.js';
import { compareVersions } from '../versions.js';
import { toPosix } from '../platform/index.js';
import type { ManifestHook } from '../types.js';

let agentsDir: string;
let tmpDir: string;

// The registrar stores the portable command form (~/ + forward slashes) so the
// path expands in bash on every OS. Expand the tilde and posix-fold both sides
// so the assertion is separator-agnostic and survives Windows' backslashes.
function resolvedCommand(command: string): string {
  const expanded = command.startsWith('~/')
    ? path.join(os.homedir(), command.slice(2))
    : command;
  return toPosix(expanded);
}

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
    expect(resolvedCommand(groups[0].hooks[0].command)).toBe(toPosix(scriptPath));
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
    expect(resolvedCommand(groups[0].hooks[0].command)).toBe(toPosix(scriptPath));
  });

  it('writes [features] hooks = true to config.toml', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const configPath = path.join(versionHome, '.codex', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, 'utf-8');
    // Codex 0.116+ feature flag is `hooks`; the legacy `codex_hooks` name is
    // an unrecognized key that Codex ignores with a deprecation error.
    expect(content).toContain('hooks = true');
    expect(content).not.toContain('codex_hooks');
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
    expect(content).toContain('hooks = true');
    expect(content).toContain('approval_policy');
  });

  it('migrates a stale [features] codex_hooks flag to hooks', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    // Simulate a config written by an older agents-cli build.
    const configPath = path.join(versionHome, '.codex', 'config.toml');
    fs.writeFileSync(configPath, '[features]\ncodex_hooks = true\n', 'utf-8');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('hooks = true');
    expect(content).not.toContain('codex_hooks');
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
    expect(resolvedCommand(hooksJson.hooks.UserPromptSubmit[0].hooks[0].command)).toBe(toPosix(scriptPath));
  });

  // Codex only runs a non-managed hook when it is enabled AND its trusted_hash
  // in [hooks.state] matches the hash Codex recomputes. In `codex exec` mode
  // there is no TUI prompt, so an untrusted hook is silently dropped — which is
  // why agents-cli must pre-compute and persist the hash.
  it('writes a [hooks.state] trusted_hash for each registered hook', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('bash-tool-hook.sh');

    const manifest: Record<string, ManifestHook> = {
      'bash-hook': {
        script: 'bash-tool-hook.sh',
        events: ['PreToolUse'],
        matcher: 'Bash',
        timeout: 5,
      },
    };

    registerHooksToSettings('codex', versionHome, manifest, agentsDir);

    const hooksJsonPath = path.join(versionHome, '.codex', 'hooks.json');
    const configPath = path.join(versionHome, '.codex', 'config.toml');
    const config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const state = (config.hooks as Record<string, unknown>).state as Record<
      string,
      { trusted_hash?: string; enabled?: boolean }
    >;

    const key = `${hooksJsonPath}:pre_tool_use:0:0`;
    expect(state[key]).toBeDefined();
    // The persisted hash must equal what Codex recomputes for this exact hook.
    // The registrar hashes the portable command it wrote into hooks.json, so
    // re-hash that exact string (not the raw native scriptPath, which diverges
    // on Windows where tmpdir lives under home and folds to a ~/-relative path).
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
    const registeredCommand = hooksJson.hooks.PreToolUse[0].hooks[0].command;
    expect(state[key].trusted_hash).toBe(
      computeCodexHookTrustHash('pre_tool_use', registeredCommand, 5, 'Bash')
    );
    // Default-enabled: we must NOT write enabled = true (absence == enabled).
    expect(state[key].enabled).toBeUndefined();
  });

  it('preserves a user-set enabled = false when rewriting the trust hash', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    // First pass writes the trust hash.
    registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    const configPath = path.join(versionHome, '.codex', 'config.toml');
    const hooksJsonPath = path.join(versionHome, '.codex', 'hooks.json');
    const key = `${hooksJsonPath}:user_prompt_submit:0:0`;

    // User disables the hook from their side.
    const config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const state = (config.hooks as Record<string, unknown>).state as Record<
      string,
      { trusted_hash?: string; enabled?: boolean }
    >;
    state[key].enabled = false;
    fs.writeFileSync(configPath, TOML.stringify(config as Parameters<typeof TOML.stringify>[0]), 'utf-8');

    // Re-register; enabled = false must survive.
    registerHooksToSettings('codex', versionHome, manifest, agentsDir);
    const after = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const afterState = (after.hooks as Record<string, unknown>).state as Record<
      string,
      { trusted_hash?: string; enabled?: boolean }
    >;
    expect(afterState[key].enabled).toBe(false);
    // Hash the portable command the registrar wrote, not the native scriptPath
    // (separator/tilde divergence on Windows — see the PreToolUse test above).
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
    const registeredCommand = hooksJson.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(afterState[key].trusted_hash).toBe(
      computeCodexHookTrustHash('user_prompt_submit', registeredCommand, 600, undefined)
    );
  });

  // Ground-truth fixtures: these hashes were written into a real config.toml by
  // the Codex 0.134.0 binary's own trust flow for these exact hook definitions.
  // If canonicalization (key ordering, field omission, always-present
  // `async:false`, TOML null-drop of an absent matcher) regresses, they break.
  describe('computeCodexHookTrustHash — Codex 0.134.0 ground truth', () => {
    const HOOK_DIR = '~/.agents/.history/versions/codex/0.134.0/home/.codex/hooks';

    it('SessionStart metadata hook, no matcher', () => {
      expect(
        computeCodexHookTrustHash('session_start', `${HOOK_DIR}/04-capture-session-start-metadata.sh`, 5, undefined)
      ).toBe('sha256:03b77fe0c51d19ec5438fd556ea783c70843f7ae24c1c640a190d3bfce70ea56');
    });

    it('PreToolUse git-guard, matcher "Bash"', () => {
      expect(computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/git-guard.sh`, 5, 'Bash')).toBe(
        'sha256:a5996ca377f7bd87d23d062ab6b7a8aef4745b9400c8da6a475009ec8096c6f1'
      );
    });

    it('PreToolUse rm-guard, matcher "Bash"', () => {
      expect(computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/rm-guard.sh`, 5, 'Bash')).toBe(
        'sha256:f840a97db8c64eb46d0eef3d37ebc98a409c12e6bdbf73f19442d02543223d34'
      );
    });

    it('PreToolUse large-file-add-guard, matcher "Bash"', () => {
      expect(
        computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/large-file-add-guard.sh`, 5, 'Bash')
      ).toBe('sha256:a5c51bb0d1ad496a102de8ea2b88a9a4f5fed80ddab8f388691e9f45529d38d0');
    });

    it('treats an empty-string matcher the same as no matcher (TOML null-drop)', () => {
      expect(computeCodexHookTrustHash('session_start', `${HOOK_DIR}/x.sh`, 5, '')).toBe(
        computeCodexHookTrustHash('session_start', `${HOOK_DIR}/x.sh`, 5, undefined)
      );
    });

    it('is matcher-sensitive', () => {
      expect(computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/git-guard.sh`, 5, 'Bash')).not.toBe(
        computeCodexHookTrustHash('pre_tool_use', `${HOOK_DIR}/git-guard.sh`, 5, 'Read')
      );
    });

    it('normalizes a sub-1 timeout to 1 (Codex: unwrap_or(600).max(1))', () => {
      expect(computeCodexHookTrustHash('session_start', `${HOOK_DIR}/x.sh`, 0, undefined)).toBe(
        computeCodexHookTrustHash('session_start', `${HOOK_DIR}/x.sh`, 1, undefined)
      );
    });
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

  function grokHooksDir(versionHome: string): string {
    return path.join(versionHome, '.grok', 'hooks');
  }

  function readGrokHooks(versionHome: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(path.join(grokHooksDir(versionHome), 'hooks.json'), 'utf-8'));
  }

  it('emits the matcher on PreToolUse', () => {
    makeScript('gate.sh');
    const manifest: Record<string, ManifestHook> = {
      gate: { script: 'gate.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const parsed = readGrokHooks(versionHome);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(
      resolvedCommand(parsed.hooks.PreToolUse[0].hooks[0].command)
    );
  });

  it('omits the matcher on SessionStart / Stop / UserPromptSubmit (lifecycle events reject it)', () => {
    makeScript('life.sh');
    const manifest: Record<string, ManifestHook> = {
      // A matcher on the manifest must NOT leak onto lifecycle events.
      life: {
        script: 'life.sh',
        events: ['SessionStart', 'Stop', 'UserPromptSubmit'],
        matcher: 'Bash',
      },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const parsed = readGrokHooks(versionHome);
    for (const ev of ['SessionStart', 'Stop', 'UserPromptSubmit']) {
      expect(parsed.hooks[ev]).toHaveLength(1);
      expect(parsed.hooks[ev][0]).not.toHaveProperty('matcher');
    }
  });

  it('translates the ExitPlanMode matcher to also match Grok exit_plan_mode', () => {
    makeScript('plan.sh');
    const manifest: Record<string, ManifestHook> = {
      plan: { script: 'plan.sh', events: ['PreToolUse'], matcher: 'ExitPlanMode' },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const parsed = readGrokHooks(versionHome);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('ExitPlanMode|exit_plan_mode');
  });

  it('groups multiple hooks with the same matcher into one group', () => {
    makeScript('a.sh');
    makeScript('b.sh');
    const manifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'], matcher: 'Bash' },
      b: { script: 'b.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const versionHome = path.join(tmpDir, 'home');
    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const parsed = readGrokHooks(versionHome);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(parsed.hooks.PreToolUse[0].hooks).toHaveLength(2);
  });

  it('writes a single file — no per-event files alongside hooks.json', () => {
    makeScript('gate.sh');
    const manifest: Record<string, ManifestHook> = {
      gate: { script: 'gate.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const versionHome = path.join(tmpDir, 'home');
    registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    const files = fs.readdirSync(grokHooksDir(versionHome)).filter((f) => f.endsWith('.json'));
    expect(files).toEqual(['hooks.json']);
  });

  it('prunes stale managed per-event files left by an older build on re-sync', () => {
    const scriptPath = makeScript('gate.sh');
    const manifest: Record<string, ManifestHook> = {
      gate: { script: 'gate.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const versionHome = path.join(tmpDir, 'home');
    const dir = grokHooksDir(versionHome);
    fs.mkdirSync(dir, { recursive: true });

    // Simulate the old double-registration output: a per-event file whose
    // command is a managed path (under agentsDir/hooks).
    const stale = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: scriptPath, timeout: 30 }] }] } };
    fs.writeFileSync(path.join(dir, 'pretooluse.json'), JSON.stringify(stale));
    // A user's own hand-authored file with an unmanaged command must survive.
    const userFile = { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: '/usr/local/bin/mine.sh', timeout: 5 }] }] } };
    fs.writeFileSync(path.join(dir, 'user-custom.json'), JSON.stringify(userFile));

    const result = registerHooksToSettings('grok', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(['hooks.json', 'user-custom.json']);
    expect(fs.existsSync(path.join(dir, 'pretooluse.json'))).toBe(false);
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
    expect(Object.keys(settings.hooks.before_tool_call[0])).toEqual(['command']);
    expect(resolvedCommand(settings.hooks.before_tool_call[0].command)).toBe(toPosix(scriptPath));
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
    expect(resolvedCommand(settings.hooks.before_tool_call[0].command)).toBe(toPosix(scriptPath));
    expect(resolvedCommand(settings.hooks.after_model_call[0].command)).toBe(toPosix(scriptPath));
    expect(resolvedCommand(settings.hooks.on_loop_stop[0].command)).toBe(toPosix(scriptPath));
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

  it('prunes managed entries when the hooks root is reached through a symlink (GC realpath invariant)', () => {
    // Deterministic, cross-platform repro of the macOS bug where the managed
    // prefix points through a symlink: isManagedHookCommand realpath-resolves
    // the command dir, so the raw prefix must be realpath-resolved too or GC
    // silently no-ops. Build an explicit symlinked hooks root so this fails on
    // Linux CI too (not just where TMPDIR is /var -> /private/var).
    const realRoot = path.join(tmpDir, 'real-agents');
    fs.mkdirSync(path.join(realRoot, 'hooks'), { recursive: true });
    for (const n of ['a.sh', 'b.sh']) {
      const p = path.join(realRoot, 'hooks', n);
      fs.writeFileSync(p, '#!/bin/sh\necho hi\n', 'utf-8');
      fs.chmodSync(p, 0o755);
    }
    const linkRoot = path.join(tmpDir, 'link-agents');
    fs.symlinkSync(realRoot, linkRoot);

    const versionHome = makeAgyVersionHome();
    const firstManifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
      b: { script: 'b.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, firstManifest, linkRoot);
    let settings = readAgySettings(versionHome);
    expect(settings.hooks.before_tool_call).toHaveLength(2);

    // 'b' removed upstream — must be pruned despite the symlinked managed root.
    const secondManifest: Record<string, ManifestHook> = {
      a: { script: 'a.sh', events: ['PreToolUse'] },
    };
    registerHooksToSettings('antigravity', versionHome, secondManifest, linkRoot);
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
    expect(resolvedCommand(settings.hooks.PreToolUse[0].hooks[0].command)).toBe(toPosix(scriptPath));
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
    expect(resolvedCommand(settings.hooks.UserPromptSubmit[0].hooks[0].command)).toBe(toPosix(scriptPath));
  });

  it('does not rewrite settings.json when registration is already current', () => {
    const versionHome = makeClaudeVersionHome();
    makeScript('stable.sh');
    const manifest: Record<string, ManifestHook> = {
      stable: { script: 'stable.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };

    expect(registerHooksToSettings('claude', versionHome, manifest, agentsDir).errors).toHaveLength(0);
    const settingsPath = path.join(versionHome, '.claude', 'settings.json');
    const fixedTime = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(settingsPath, fixedTime, fixedTime);

    expect(registerHooksToSettings('claude', versionHome, manifest, agentsDir).errors).toHaveLength(0);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(fixedTime.getTime());
  });
});

describe('registerHooksToSettings - Droid', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDroidVersionHome(): string {
    const home = path.join(tmpDir, 'droid-home');
    fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
    return home;
  }

  function readDroidSettings(home: string): Record<string, any> {
    return JSON.parse(
      fs.readFileSync(path.join(home, '.factory', 'settings.json'), 'utf-8')
    );
  }

  it('writes Claude-shaped matcher groups into .factory/settings.json', () => {
    const versionHome = makeDroidVersionHome();
    const scriptPath = makeScript('pre-tool.sh');

    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'], matcher: 'Bash', timeout: 45 },
    };

    const result = registerHooksToSettings('droid', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('pre-tool -> PreToolUse');

    const settings = readDroidSettings(versionHome);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(45);
    expect(resolvedCommand(settings.hooks.PreToolUse[0].hooks[0].command)).toBe(toPosix(scriptPath));
  });

  it('registers the events droid supports natively (SessionStart, UserPromptSubmit, Stop)', () => {
    const versionHome = makeDroidVersionHome();
    makeScript('start.sh');
    makeScript('prompt.sh');
    makeScript('stop.sh');

    const manifest: Record<string, ManifestHook> = {
      start: { script: 'start.sh', events: ['SessionStart'] },
      prompt: { script: 'prompt.sh', events: ['UserPromptSubmit'] },
      stop: { script: 'stop.sh', events: ['Stop'] },
    };

    const result = registerHooksToSettings('droid', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readDroidSettings(versionHome);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('preserves pre-existing non-hooks settings.json content', () => {
    const versionHome = makeDroidVersionHome();
    const settingsPath = path.join(versionHome, '.factory', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ logoAnimation: 'off' }, null, 2));

    makeScript('pre-tool.sh');
    const manifest: Record<string, ManifestHook> = {
      'pre-tool': { script: 'pre-tool.sh', events: ['PreToolUse'] },
    };

    const result = registerHooksToSettings('droid', versionHome, manifest, agentsDir);
    expect(result.errors).toHaveLength(0);

    const settings = readDroidSettings(versionHome);
    expect(settings.logoAnimation).toBe('off');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });
});

// Regression for the Windows hook-path bug: hook commands stored as absolute
// Windows paths with backslashes ("C:\\Users\\...\\06-attention-sentinel.sh")
// break at exec time because Claude runs hooks via bash, which strips the
// backslashes -> "No such file or directory". The registrar must store the
// portable "~/..." form. `sep` is injected so the Windows case is exercised on
// a POSIX CI host (where path.sep is '/'), which is the only way the required
// Linux `test` gate can catch a Windows-only path regression.
describe('toPortableCommand — portable hook commands (Windows path regression)', () => {
  const WIN_SEP = '\\';
  const winHome = 'C:\\Users\\me';
  const winHook =
    'C:\\Users\\me\\.agents\\.history\\versions\\claude\\2.1.201\\home\\.claude\\hooks\\06-attention-sentinel.sh';

  it('folds a Windows abs path under HOME to ~/ with forward slashes', () => {
    const out = toPortableCommand(winHook, winHome, WIN_SEP);
    expect(out).toBe(
      '~/.agents/.history/versions/claude/2.1.201/home/.claude/hooks/06-attention-sentinel.sh'
    );
  });

  it('never emits a backslash or drive-letter for a Windows path under HOME', () => {
    const out = toPortableCommand(winHook, winHome, WIN_SEP);
    expect(out).not.toContain('\\');
    expect(out).not.toMatch(/^[a-zA-Z]:/);
    expect(out.startsWith('~/')).toBe(true);
  });

  it('forward-slashes a Windows path OUTSIDE HOME (no verbatim backslashes)', () => {
    const out = toPortableCommand('D:\\tools\\hooks\\g.sh', winHome, WIN_SEP);
    // Not under HOME, so no ~/ fold — but it must still be backslash-free so
    // bash does not mangle it.
    expect(out).toBe('D:/tools/hooks/g.sh');
    expect(out).not.toContain('\\');
  });

  it('folds a POSIX abs path under HOME to ~/ (macOS/Linux behavior unchanged)', () => {
    const out = toPortableCommand('/home/me/.agents/hooks/g.sh', '/home/me', '/');
    expect(out).toBe('~/.agents/hooks/g.sh');
  });
});

// Regression for the per-version hook accumulation bug: because sync registers
// each guard hook by a version-scoped path
// (~/.agents/.history/versions/claude/<version>/home/.claude/hooks/git-guard.sh),
// entries for every version installed over time piled up in one settings.json —
// string-level dedup can't collapse them (paths differ), and `agents remove`
// deleted a version's files without ever cleaning its settings entries, leaving
// dead hooks that error on every tool call.
describe('per-version hook entry pruning (settings accumulation regression)', () => {
  // Portable version-home guard-hook command for a given version (the form sync
  // actually writes — see toPortableCommand).
  function guardCmd(version: string): string {
    return `~/.agents/.history/versions/claude/${version}/home/.claude/hooks/git-guard.sh`;
  }
  const SYSTEM_HOOK = '~/.agents/.system/hooks/00-agent-verify-work-complete.sh';
  const CUSTOM_HOOK = '~/dotfiles/hooks/my-personal-guard.sh';

  function preToolUseGroup(commands: string[]) {
    return {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: commands.map((command) => ({ type: 'command', command, timeout: 600 })),
        },
      ],
    };
  }

  function collectCommands(settings: Record<string, any>): string[] {
    const out: string[] = [];
    for (const groups of Object.values(settings.hooks ?? {})) {
      for (const group of groups as Array<{ hooks?: Array<{ command: string }> }>) {
        for (const h of group.hooks ?? []) out.push(h.command);
      }
    }
    return out;
  }

  describe('sync (registerHooksToSettings)', () => {
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-prune-test-'));
      agentsDir = path.join(tmpDir, '.agents');
      fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('drops sibling-version entries, keeps the current version + .system + custom hooks', () => {
      // A version-home-shaped path so registrar knows which version it is syncing.
      const versionHome = path.join(
        tmpDir, '.agents', '.history', 'versions', 'claude', '2.1.201', 'home'
      );
      const settingsPath = path.join(versionHome, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

      // Seed: three version homes (two stale, one current) + a system hook + a
      // user's own custom hook, all in one PreToolUse/Bash matcher group.
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([
          guardCmd('2.1.186'),   // stale sibling -> prune
          guardCmd('2.1.191'),   // stale sibling -> prune
          guardCmd('2.1.201'),   // current version -> keep
          SYSTEM_HOOK,           // .system path -> keep (never a prune target)
          CUSTOM_HOOK,           // user's own hook -> keep (never a prune target)
        ]),
      }, null, 2));

      makeScript('git-guard.sh');
      const manifest: Record<string, ManifestHook> = {
        'git-guard': { script: 'git-guard.sh', events: ['PreToolUse'], matcher: 'Bash' },
      };

      const result = registerHooksToSettings('claude', versionHome, manifest, agentsDir);
      expect(result.errors).toHaveLength(0);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const commands = collectCommands(settings);

      // Both sibling versions gone.
      expect(commands).not.toContain(guardCmd('2.1.186'));
      expect(commands).not.toContain(guardCmd('2.1.191'));
      // Exactly one version-home guard entry survives, and it is the current one.
      const versionHomeCmds = commands.filter((c) => c.includes('.history/versions/claude/'));
      expect(versionHomeCmds).toEqual([guardCmd('2.1.201')]);
      // System + custom hooks untouched.
      expect(commands).toContain(SYSTEM_HOOK);
      expect(commands).toContain(CUSTOM_HOOK);
    });
  });

  describe('remove (pruneVersionHomeHookEntriesFromSettings)', () => {
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-remove-test-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('removes only the removed version’s entries, keeping siblings + .system + custom', () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([
          guardCmd('2.1.186'),
          guardCmd('2.1.191'),   // removed version -> prune
          guardCmd('2.1.201'),
          SYSTEM_HOOK,
          CUSTOM_HOOK,
        ]),
      }, null, 2));

      const removed = pruneVersionHomeHookEntriesFromSettings(settingsPath, 'claude', '2.1.191');
      expect(removed).toBe(1);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const commands = collectCommands(settings);
      expect(commands).not.toContain(guardCmd('2.1.191'));
      expect(commands).toContain(guardCmd('2.1.186'));
      expect(commands).toContain(guardCmd('2.1.201'));
      expect(commands).toContain(SYSTEM_HOOK);
      expect(commands).toContain(CUSTOM_HOOK);
    });

    it('never touches another agent’s version or non-version-home hooks', () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([
          // Same version number but a DIFFERENT agent — must not be pruned.
          '~/.agents/.history/versions/droid/2.1.191/home/.factory/hooks/git-guard.sh',
          SYSTEM_HOOK,
          CUSTOM_HOOK,
        ]),
      }, null, 2));

      const removed = pruneVersionHomeHookEntriesFromSettings(settingsPath, 'claude', '2.1.191');
      expect(removed).toBe(0);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const commands = collectCommands(settings);
      expect(commands).toHaveLength(3);
      expect(commands).toContain(SYSTEM_HOOK);
      expect(commands).toContain(CUSTOM_HOOK);
    });

    it('collapses a matcher group left empty after the prune', () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: preToolUseGroup([guardCmd('2.1.191')]),
      }, null, 2));

      const removed = pruneVersionHomeHookEntriesFromSettings(settingsPath, 'claude', '2.1.191');
      expect(removed).toBe(1);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse).toEqual([]);
    });
  });
});
