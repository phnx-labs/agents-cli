import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as TOML from 'smol-toml';

import { carryForwardSettings, fillGaps } from '../settings-manifest.js';

let tmpDir: string;
let fromHome: string;
let toHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-forward-'));
  fromHome = path.join(tmpDir, 'from');
  toHome = path.join(tmpDir, 'to');
  fs.mkdirSync(path.join(fromHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(fromHome, '.codex'), { recursive: true });
  fs.mkdirSync(toHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

describe('fillGaps', () => {
  it('keeps target scalars and arrays, copies missing keys, recurses objects', () => {
    const target = {
      model: 'opus',
      env: { KEEP: '1' },
      permissions: { allow: ['Bash(git *)'] },
    };
    const source = {
      model: 'sonnet',
      env: { KEEP: 'stale', ADD: '2' },
      permissions: { allow: ['Bash(npm *)', 'Bash(git *)'], deny: ['Bash(rm *)'] },
      extra: true,
    };
    const merged = fillGaps(target, source);
    expect(merged.model).toBe('opus');
    expect(merged.env).toEqual({ KEEP: '1', ADD: '2' });
    expect(merged.permissions).toEqual({
      allow: ['Bash(git *)'],
      deny: ['Bash(rm *)'],
    });
    expect(merged.extra).toBe(true);
  });

  it('does not re-append stale array entries the target has since mutated', () => {
    // Factory sync merges system hooks INTO the user's entry; a union would
    // re-add the stale pre-mutation copy from the source and fire it twice.
    const mutated = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo guard' }, { type: 'command', command: 'system-guard.sh' }],
    };
    const stale = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] };
    const merged = fillGaps({ PreToolUse: [mutated] }, { PreToolUse: [stale] });
    expect(merged.PreToolUse).toEqual([mutated]);
  });
});

describe('carryForwardSettings (claude)', () => {
  it('copies settings.json into a fresh home and merges into a populated one', () => {
    const userSettings = {
      env: { FOO: 'bar', DEBUG: 'true' },
      permissions: { allow: ['Bash(npm *)'], deny: ['Bash(rm -rf *)'] },
      mcpServers: { fooServer: { command: '/bin/foo' } },
      customKey: { nested: 'preserved' },
    };
    writeJson(path.join(fromHome, '.claude/settings.json'), userSettings);

    // Fresh home: file lands verbatim.
    const first = carryForwardSettings('claude', fromHome, toHome);
    expect(first.applied).toContain('.claude/settings.json');
    const fresh = JSON.parse(fs.readFileSync(path.join(toHome, '.claude/settings.json'), 'utf-8'));
    expect(fresh).toEqual(userSettings);

    // Populated home: target values win, gaps fill.
    writeJson(path.join(toHome, '.claude/settings.json'), {
      env: { FOO: 'newer' },
      model: 'opus',
    });
    const second = carryForwardSettings('claude', fromHome, toHome);
    expect(second.applied).toContain('.claude/settings.json');
    const merged = JSON.parse(fs.readFileSync(path.join(toHome, '.claude/settings.json'), 'utf-8'));
    expect(merged.env).toEqual({ FOO: 'newer', DEBUG: 'true' });
    expect(merged.model).toBe('opus');
    expect(merged.customKey).toEqual({ nested: 'preserved' });
    expect(second.backupDir).toBeDefined();
    expect(fs.existsSync(path.join(second.backupDir!, '.claude/settings.json'))).toBe(true);
  });

  it('copies keybindings.json only when absent', () => {
    fs.writeFileSync(path.join(fromHome, '.claude/keybindings.json'), '{"bindings":[]}');
    writeJson(path.join(toHome, '.claude/keybindings.json'), { bindings: ['mine'] });
    const result = carryForwardSettings('claude', fromHome, toHome);
    expect(result.applied).not.toContain('.claude/keybindings.json');
    const kept = JSON.parse(fs.readFileSync(path.join(toHome, '.claude/keybindings.json'), 'utf-8'));
    expect(kept.bindings).toEqual(['mine']);
  });

  it('is idempotent: second run applies nothing', () => {
    writeJson(path.join(fromHome, '.claude/settings.json'), { env: { A: '1' } });
    carryForwardSettings('claude', fromHome, toHome);
    const again = carryForwardSettings('claude', fromHome, toHome);
    expect(again.applied).toEqual([]);
    expect(again.backupDir).toBeUndefined();
  });

  it('survives a malformed source file without touching the target', () => {
    fs.writeFileSync(path.join(fromHome, '.claude/settings.json'), '{not json');
    writeJson(path.join(toHome, '.claude/settings.json'), { env: { SAFE: '1' } });
    const result = carryForwardSettings('claude', fromHome, toHome);
    expect(result.applied).toEqual([]);
    const target = JSON.parse(fs.readFileSync(path.join(toHome, '.claude/settings.json'), 'utf-8'));
    expect(target.env.SAFE).toBe('1');
  });
});

describe('carryForwardSettings (codex)', () => {
  it('merges config.toml, strips state keys, copies auth.json with 0600', () => {
    fs.writeFileSync(path.join(fromHome, '.codex/config.toml'), TOML.stringify({
      model: 'gpt-5.5',
      approval_policy: 'on-request',
      mcp_servers: { tomlServer: { command: '/bin/toml-mcp' } },
      projects: { '/root/work': { trust_level: 'trusted' } },
      notice: { hide_full_access_warning: true },
    } as never));
    fs.writeFileSync(path.join(fromHome, '.codex/auth.json'), '{"OPENAI_API_KEY":"sk-test"}');

    fs.mkdirSync(path.join(toHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(toHome, '.codex/config.toml'), TOML.stringify({
      model: 'gpt-6',
    } as never));

    const result = carryForwardSettings('codex', fromHome, toHome);
    expect(result.applied).toEqual(expect.arrayContaining(['.codex/config.toml', '.codex/auth.json']));

    const merged = TOML.parse(fs.readFileSync(path.join(toHome, '.codex/config.toml'), 'utf-8')) as Record<string, any>;
    expect(merged.model).toBe('gpt-6');
    expect(merged.approval_policy).toBe('on-request');
    expect(merged.mcp_servers.tomlServer.command).toBe('/bin/toml-mcp');
    expect(merged.projects['/root/work'].trust_level).toBe('trusted');
    expect(merged.notice).toBeUndefined();

    // NTFS has no POSIX mode bits — the 0o600 restrictMode is a no-op on Windows.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(toHome, '.codex/auth.json')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('copies prompt dir entries without clobbering existing ones', () => {
    fs.mkdirSync(path.join(fromHome, '.codex/prompts'), { recursive: true });
    fs.writeFileSync(path.join(fromHome, '.codex/prompts/review.md'), 'old review');
    fs.writeFileSync(path.join(fromHome, '.codex/prompts/new.md'), 'brand new');
    fs.mkdirSync(path.join(toHome, '.codex/prompts'), { recursive: true });
    fs.writeFileSync(path.join(toHome, '.codex/prompts/review.md'), 'mine');

    const result = carryForwardSettings('codex', fromHome, toHome);
    expect(result.applied).toContain('.codex/prompts');
    expect(fs.readFileSync(path.join(toHome, '.codex/prompts/review.md'), 'utf-8')).toBe('mine');
    expect(fs.readFileSync(path.join(toHome, '.codex/prompts/new.md'), 'utf-8')).toBe('brand new');
  });
});

describe('carryForwardSettings (unsupported agent)', () => {
  it('is a no-op for agents without a manifest', () => {
    const result = carryForwardSettings('gemini', fromHome, toHome);
    expect(result.applied).toEqual([]);
  });
});
