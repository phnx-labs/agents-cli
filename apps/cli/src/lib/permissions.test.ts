import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import {
  COMPUTER_APP_GATED_VERBS,
  applyPermissionsToVersion,
  buildPermissionsFromGroups,
  containsBroadGrants,
  convertDenyToCodexRules,
  convertToKimiFormat,
  convertToDroidFormat,
  convertToGooseFormat,
  convertToKiroFormat,
  formatComputerPermissionGrantHint,
} from './permissions.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-perms-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Droid permissions', () => {
  it('maps canonical Bash rules into command allow and deny arrays', () => {
    expect(convertToDroidFormat({
      name: 'droid',
      allow: ['Bash(git:*)', 'Bash(pwd)', 'Read(**)'],
      deny: ['Bash(rm -rf:*)', 'Write(**)'],
    })).toEqual({
      commandAllowlist: ['git *', 'pwd'],
      commandDenylist: ['rm -rf *'],
    });
  });

  it('writes and merges Droid settings without replacing unrelated keys', () => {
    const home = makeTempHome();
    const configDir = path.join(home, '.factory');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
      model: 'custom-model',
      commandAllowlist: ['ls'],
      commandDenylist: ['shutdown'],
    }));

    expect(applyPermissionsToVersion('droid', {
      name: 'set',
      allow: ['Bash(git:*)'],
      deny: ['Bash(rm -rf:*)'],
    }, home, true)).toEqual({ success: true });

    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'))).toEqual({
      model: 'custom-model',
      commandAllowlist: ['ls', 'git *'],
      commandDenylist: ['shutdown', 'rm -rf *'],
    });
  });
});

describe('Goose permissions', () => {
  it('maps canonical rules to user permission categories', () => {
    expect(convertToGooseFormat({
      name: 'goose',
      allow: ['Bash(git:*)', 'Read(**)', 'WebFetch(domain:docs.example.com)'],
      deny: ['Write(secrets/**)'],
    })).toEqual({
      user: {
        always_allow: ['developer__fetch', 'developer__shell'],
        ask_before: [],
        never_allow: ['developer__text_editor'],
      },
    });
  });

  it('writes and merges permission.yaml without replacing unrelated tools', () => {
    const home = makeTempHome();
    const configDir = path.join(home, '.config', 'goose');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'permission.yaml'), yaml.stringify({
      user: {
        always_allow: ['developer__analyze'],
        ask_before: ['custom__tool'],
        never_allow: ['developer__text_editor'],
      },
      smart_approve: {
        always_allow: [],
        ask_before: ['developer__shell'],
        never_allow: [],
      },
    }));

    const result = applyPermissionsToVersion('goose', {
      name: 'set',
      allow: ['Bash(git:*)', 'Write(src/**)'],
      deny: ['Read(**/.env)'],
    }, home, true);
    expect(result.success).toBe(true);

    const config = yaml.parse(fs.readFileSync(path.join(configDir, 'permission.yaml'), 'utf-8'));
    expect(config).toEqual({
      user: {
        always_allow: ['developer__analyze', 'developer__shell'],
        ask_before: ['custom__tool'],
        never_allow: ['developer__text_editor'],
      },
      smart_approve: {
        always_allow: [],
        ask_before: ['developer__shell'],
        never_allow: [],
      },
    });
  });
});

describe('permission path handling', () => {
  it('builds selected permission groups with separate allow and deny sections', async () => {
    const home = makeTempHome();
    const groupsDir = path.join(home, '.agents', 'permissions', 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'goose-safe.yaml'), [
      'name: goose-safe',
      'allow:',
      '  - "Bash(git:*)"',
      'deny:',
      '  - "Write(secrets/**)"',
      '',
    ].join('\n'));

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { buildPermissionsFromGroups: buildFromGroups } = await import('./permissions.js');
      expect(buildFromGroups(['goose-safe'])).toEqual({
        name: 'built',
        description: 'Built from groups: goose-safe',
        allow: ['Bash(git:*)'],
        deny: ['Write(secrets/**)'],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      vi.resetModules();
    }
  });

  it('keeps legacy bare-list permission group entries as allow rules', async () => {
    const home = makeTempHome();
    const groupsDir = path.join(home, '.agents', 'permissions', 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'legacy-web.yaml'), [
      '- "WebFetch(domain:cloud.google.com)"',
      '- "WebFetch(domain:docs.aws.amazon.com)"',
      '',
    ].join('\n'));

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { buildPermissionsFromGroups: buildFromGroups } = await import('./permissions.js');
      expect(buildFromGroups(['legacy-web'])).toEqual({
        name: 'built',
        description: 'Built from groups: legacy-web',
        allow: ['WebFetch(domain:cloud.google.com)', 'WebFetch(domain:docs.aws.amazon.com)'],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      vi.resetModules();
    }
  });

  it('rejects traversal in permission group names', async () => {
    makeTempHome();

    expect(() => buildPermissionsFromGroups(['../outside'])).toThrow('Invalid name: ../outside.yaml');
  });

  it('escapes deny rules before writing Codex Starlark string literals', async () => {
    const rules = convertDenyToCodexRules(['Bash(git "status":*)']);

    expect(rules).toContain('"git", "\\"status\\""');
    expect(rules).not.toContain('"git", ""status""');
  });
});

describe('containsBroadGrants', () => {
  it('flags Bash(*) permission packs as broad grants', () => {
    const result = containsBroadGrants({
      name: 'broad',
      allow: ['Bash(*)'],
      deny: [],
    });

    expect(result?.broad).toEqual(['Bash(*)']);
    expect(result?.reason).toContain('approval_policy=never');
  });

  it('allows narrow permission packs', () => {
    const result = containsBroadGrants({
      name: 'narrow',
      allow: ['Bash(git status:*)'],
      deny: [],
      additionalDirectories: ['src'],
    });

    expect(result).toBeNull();
  });
});

describe('computer permission hints', () => {
  it('tells users the app-targeted verbs gated by Computer(bundle-id)', () => {
    const hint = formatComputerPermissionGrantHint('Microsoft.WindowsNotepad');

    expect(hint).toContain('Computer(Microsoft.WindowsNotepad)');
    expect(hint).toContain('agents computer reload');
    expect(hint).toContain('type-text');
    expect(hint).toContain('key');
    expect(COMPUTER_APP_GATED_VERBS).toContain('type-text');
    expect(COMPUTER_APP_GATED_VERBS).toContain('key');
  });
});

describe('convertToKimiFormat', () => {
  it('translates Claude `:*` bash patterns into Kimi globs, with a slash-crossing variant', () => {
    // The core bug: copying `Bash(git status:*)` verbatim never matches in
    // Kimi's engine (it globs the raw command string), so every call prompts.
    // The second `*​/**` form is required because Kimi's `*` does not cross `/`,
    // so a bare `cmd*` misses any path argument (`git push origin feat/x`).
    const { permission } = convertToKimiFormat({
      name: 'core',
      allow: ['Bash(git push:*)', 'Bash(mq:*)', 'Bash(env)'],
      deny: [],
    });

    expect(permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash(git push*)' },
      { decision: 'allow', pattern: 'Bash(git push*/**)' },
      { decision: 'allow', pattern: 'Bash(mq*)' },
      { decision: 'allow', pattern: 'Bash(mq*/**)' },
      // Exact command (no `:*`) takes no path args — single rule, no slash variant.
      { decision: 'allow', pattern: 'Bash(env)' },
    ]);
  });

  it('collapses blanket and glob grants to name-only rules with original casing', () => {
    const { permission } = convertToKimiFormat({
      name: 'broad',
      allow: ['Bash(*)', 'Read(**)', 'Grep'],
      deny: [],
    });

    expect(permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash' },
      { decision: 'allow', pattern: 'Read' },
      { decision: 'allow', pattern: 'Grep' },
    ]);
  });

  it('carries deny rules through the same translation', () => {
    const { permission } = convertToKimiFormat({
      name: 'deny',
      allow: [],
      deny: ['Bash(rm -rf:*)'],
    });

    expect(permission.rules).toEqual([
      { decision: 'deny', pattern: 'Bash(rm -rf*)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*/**)' },
    ]);
  });

  it('writes a re-parseable TOML config with translated patterns (no raw `:*`)', () => {
    const home = makeTempHome();
    const res = applyPermissionsToVersion(
      'kimi',
      { name: 'set', allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] },
      home,
      false,
    );
    expect(res.success).toBe(true);

    const raw = fs.readFileSync(path.join(home, '.kimi-code', 'config.toml'), 'utf-8');
    const parsed = TOML.parse(raw) as { permission: { rules: Array<{ decision: string; pattern: string }> } };
    expect(parsed.permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash(ls*)' },
      { decision: 'allow', pattern: 'Bash(ls*/**)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*/**)' },
    ]);
    // The pre-fix bug would have left the un-matchable Claude `:*` form on disk.
    expect(raw).not.toContain(':*');
  });
});

describe('Kiro permissions', () => {
  it('converts canonical permissions to Kiro v3 capability rules', () => {
    expect(convertToKiroFormat({
      name: 'kiro-rules',
      allow: [
        'Bash(git:*)',
        'Read(**)',
        'Write(src/**)',
        'WebFetch(domain:docs.example.com)',
        'WebSearch(*)',
        'MCP(corp-tools/*)',
        'Subagent',
        'Skill(*)',
      ],
      deny: ['Bash(rm -rf:*)', 'Read(**/.env)'],
    })).toEqual({
      rules: [
        { capability: 'shell', effect: 'allow', match: ['git *'] },
        { capability: 'fs_read', effect: 'allow' },
        { capability: 'fs_write', effect: 'allow', match: ['src/**'] },
        { capability: 'web_fetch', effect: 'allow', match: ['docs.example.com'] },
        { capability: 'web_search', effect: 'allow' },
        { capability: 'mcp', effect: 'allow', match: ['corp-tools/*'] },
        { capability: 'subagent', effect: 'allow' },
        { capability: 'skill', effect: 'allow' },
        { capability: 'shell', effect: 'deny', match: ['rm -rf *'] },
        { capability: 'fs_read', effect: 'deny', match: ['**/.env'] },
      ],
    });
  });

  it('writes and merges permissions.yaml without replacing user rules', () => {
    const home = makeTempHome();
    const settingsDir = path.join(home, '.kiro', 'settings');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'permissions.yaml'), yaml.stringify({
      rules: [
        { capability: 'fs_write', effect: 'ask', match: ['.git/**'] },
        { effect: 'allow', capability: 'shell', match: ['git *'] },
      ],
    }));

    const result = applyPermissionsToVersion('kiro', {
      name: 'test',
      allow: ['Bash(git:*)', 'Write(src/**)'],
      deny: ['Read(**/.env)'],
    }, home, true);
    expect(result.success).toBe(true);

    const config = yaml.parse(fs.readFileSync(path.join(settingsDir, 'permissions.yaml'), 'utf-8'));
    expect(config.rules).toEqual([
      { capability: 'fs_write', effect: 'ask', match: ['.git/**'] },
      { effect: 'allow', capability: 'shell', match: ['git *'] },
      { capability: 'fs_write', effect: 'allow', match: ['src/**'] },
      { capability: 'fs_read', effect: 'deny', match: ['**/.env'] },
    ]);
  });
});
