/**
 * Tests for the RulesHandler resource handler.
 *
 * Uses real filesystem (temp dirs), no mocking.
 * Tests the core functions directly with injected layer directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  RulesHandler,
  listAllRules,
  resolveRule,
  listSubrulesInDir,
  type RulesLayerDir,
} from './rules.js';

let tmpDir: string;

function writeFile(rel: string, content: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

function makeLayer(name: string, layer: 'project' | 'user' | 'system'): RulesLayerDir {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return { layer, dir };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-handler-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('listAllRules — union', () => {
  it('unions unique subrules from multiple layers', () => {
    const system = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    const project = makeLayer('project', 'project');

    // System layer has subrule-a
    writeFile('system/subrules/subrule-a.md', '# System A');

    // User layer has subrule-b
    writeFile('user/subrules/subrule-b.md', '# User B');

    // Project layer has subrule-c
    writeFile('project/subrules/subrule-c.md', '# Project C');

    const results = listAllRules([project, user, system]);

    // Should have all 3 unique subrules
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['subrule-a', 'subrule-b', 'subrule-c']);
  });

  it('returns empty array when no layers have subrules', () => {
    const system = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');

    const results = listAllRules([user, system]);

    expect(results).toHaveLength(0);
  });
});

describe('listAllRules — override', () => {
  it('higher layer wins on name collision (project > user > system)', () => {
    const system = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    const project = makeLayer('project', 'project');

    // Same subrule name in all layers
    writeFile('system/subrules/shared.md', 'SYSTEM VERSION');
    writeFile('user/subrules/shared.md', 'USER VERSION');
    writeFile('project/subrules/shared.md', 'PROJECT VERSION');

    const results = listAllRules([project, user, system]);

    // Should only have one entry for 'shared'
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('shared');
    expect(results[0].layer).toBe('project');
    expect(results[0].item.content).toBe('PROJECT VERSION');
  });

  it('user layer wins when no project layer exists', () => {
    const system = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');

    writeFile('system/subrules/shared.md', 'SYSTEM VERSION');
    writeFile('user/subrules/shared.md', 'USER VERSION');

    const results = listAllRules([user, system]);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('shared');
    expect(results[0].layer).toBe('user');
    expect(results[0].item.content).toBe('USER VERSION');
  });

  it('system layer used when no user or project override', () => {
    const system = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');

    writeFile('system/subrules/system-only.md', 'SYSTEM ONLY');
    writeFile('user/subrules/user-only.md', 'USER ONLY');

    const results = listAllRules([user, system]);

    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['system-only', 'user-only']);

    const systemRule = results.find((r) => r.name === 'system-only');
    expect(systemRule?.layer).toBe('system');
  });
});

describe('resolveRule', () => {
  it('resolves a single subrule by name from highest layer', () => {
    const system = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');

    writeFile('system/subrules/core.md', 'SYSTEM CORE');
    writeFile('user/subrules/core.md', 'USER CORE');

    const result = resolveRule('core', [user, system]);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('core');
    expect(result!.layer).toBe('user');
    expect(result!.item.content).toBe('USER CORE');
  });

  it('falls back to lower layer when not in higher layer', () => {
    const system = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');

    writeFile('system/subrules/system-only.md', 'SYSTEM ONLY');

    const result = resolveRule('system-only', [user, system]);

    expect(result).not.toBeNull();
    expect(result!.layer).toBe('system');
    expect(result!.item.content).toBe('SYSTEM ONLY');
  });

  it('returns null for non-existent subrule', () => {
    const system = makeLayer('system', 'system');

    writeFile('system/subrules/exists.md', 'content');

    const result = resolveRule('does-not-exist', [system]);

    expect(result).toBeNull();
  });
});

describe('listSubrulesInDir', () => {
  it('lists markdown files without .md extension', () => {
    const dir = path.join(tmpDir, 'subrules');
    writeFile('subrules/rule-a.md', 'A');
    writeFile('subrules/rule-b.md', 'B');
    writeFile('subrules/rule-c.md', 'C');

    const names = listSubrulesInDir(dir);

    expect(names).toEqual(['rule-a', 'rule-b', 'rule-c']);
  });

  it('excludes README.md from listing', () => {
    const dir = path.join(tmpDir, 'subrules');
    writeFile('subrules/README.md', '# Documentation');
    writeFile('subrules/actual-rule.md', 'Real rule content');

    const names = listSubrulesInDir(dir);

    expect(names).toEqual(['actual-rule']);
  });

  it('returns empty array for non-existent directory', () => {
    const names = listSubrulesInDir(path.join(tmpDir, 'nonexistent'));

    expect(names).toEqual([]);
  });

  it('ignores non-markdown files', () => {
    const dir = path.join(tmpDir, 'subrules');
    writeFile('subrules/rule.md', 'MD');
    writeFile('subrules/config.yaml', 'yaml');
    writeFile('subrules/script.js', 'js');

    const names = listSubrulesInDir(dir);

    expect(names).toEqual(['rule']);
  });

  it('lists dir-form subrules (foo/rule.md) alongside flat ones', () => {
    const dir = path.join(tmpDir, 'subrules');
    writeFile('subrules/flat.md', 'FLAT');
    writeFile('subrules/dir/rule.md', 'DIR');
    // A directory without rule.md is not a subrule.
    writeFile('subrules/notarule/hooks.yaml', 'x: {}');

    const names = listSubrulesInDir(dir);

    expect(names).toEqual(['dir', 'flat']);
  });
});

describe('rules — dir-form subrules', () => {
  it('resolveRule reads dir-form rule.md', () => {
    const system = makeLayer('system', 'system');
    writeFile('system/subrules/foo/rule.md', 'DIR FOO');

    const result = resolveRule('foo', [system]);
    expect(result).not.toBeNull();
    expect(result!.item.content).toBe('DIR FOO');
    expect(result!.path).toBe(path.join(system.dir, 'subrules', 'foo', 'rule.md'));
  });

  it('dir-form in a higher layer shadows a flat one in a lower layer', () => {
    const system = makeLayer('system', 'system');
    const user = makeLayer('user', 'user');
    writeFile('system/subrules/foo.md', 'SYS FLAT');
    writeFile('user/subrules/foo/rule.md', 'USER DIR');

    const result = resolveRule('foo', [user, system]);
    expect(result!.layer).toBe('user');
    expect(result!.item.content).toBe('USER DIR');
  });

  it('listAllRules includes dir-form subrules', () => {
    const system = makeLayer('system', 'system');
    writeFile('system/subrules/flat.md', 'FLAT');
    writeFile('system/subrules/dir/rule.md', 'DIR');

    const results = listAllRules([system]);
    const byName = Object.fromEntries(results.map((r) => [r.name, r.item.content]));
    expect(Object.keys(byName).sort()).toEqual(['dir', 'flat']);
    expect(byName.dir).toBe('DIR');
  });
});

describe('RulesHandler.format', () => {
  it('returns md for all agents', () => {
    expect(RulesHandler.format('claude')).toBe('md');
    expect(RulesHandler.format('codex')).toBe('md');
    expect(RulesHandler.format('gemini')).toBe('md');
  });
});

describe('RulesHandler.targetDir', () => {
  it('returns the agent config directory name', () => {
    expect(RulesHandler.targetDir('claude')).toBe('.claude');
    expect(RulesHandler.targetDir('codex')).toBe('.codex');
    expect(RulesHandler.targetDir('gemini')).toBe('.gemini');
  });
});

describe('RulesHandler.kind', () => {
  it('returns rule as the resource kind', () => {
    expect(RulesHandler.kind).toBe('rule');
  });
});
