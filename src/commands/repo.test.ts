import { describe, it, expect } from 'vitest';
import { resourceUnit, formatResourceDelta, type ChangeAction } from './repo.js';

/** Strip ANSI color codes so assertions are stable regardless of TTY/color env. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

const e = (action: ChangeAction, file: string) => ({ action, file });

describe('resourceUnit', () => {
  it('collapses every file under a directory-based resource to one unit', () => {
    expect(resourceUnit('skills/git-workflow/SKILL.md')).toEqual({ kind: 'skill', unit: 'skills/git-workflow' });
    expect(resourceUnit('skills/git-workflow/extra.md')).toEqual({ kind: 'skill', unit: 'skills/git-workflow' });
    expect(resourceUnit('plugins/rush/.claude-plugin/plugin.json')).toEqual({ kind: 'plugin', unit: 'plugins/rush' });
  });

  it('maps prompts/ to command (Codex) and treats flat config files individually', () => {
    expect(resourceUnit('prompts/foo.md').kind).toBe('command');
    expect(resourceUnit('agents.yaml')).toEqual({ kind: 'config', unit: 'agents.yaml' });
    expect(resourceUnit('hooks.yaml')).toEqual({ kind: 'config', unit: 'hooks.yaml' });
  });

  it('buckets unknown top-level paths as other', () => {
    expect(resourceUnit('README.md').kind).toBe('other');
  });
});

describe('formatResourceDelta', () => {
  it('counts distinct resource units, not files (3 changed files in one skill = 1 skill)', () => {
    const out = plain(formatResourceDelta([
      e('changed', 'skills/foo/SKILL.md'),
      e('changed', 'skills/foo/a.md'),
      e('changed', 'skills/foo/b.md'),
    ]));
    expect(out).toBe('1 changed skill');
  });

  it('pluralizes and groups by action then kind', () => {
    const out = plain(formatResourceDelta([
      e('new', 'skills/a/SKILL.md'),
      e('new', 'skills/b/SKILL.md'),
      e('changed', 'hooks/h.md'),
    ]));
    expect(out).toBe('2 new skills, 1 changed hook');
  });

  it('treats a unit with mixed add+modify as a single change, not new', () => {
    const out = plain(formatResourceDelta([
      e('new', 'skills/foo/new-file.md'),
      e('changed', 'skills/foo/SKILL.md'),
    ]));
    expect(out).toBe('1 changed skill');
  });

  it('caps at maxParts with a "+N more" overflow', () => {
    const entries = [
      e('new', 'skills/a/SKILL.md'),
      e('new', 'commands/b.md'),
      e('new', 'plugins/c/plugin.json'),
      e('new', 'hooks/d.md'),
      e('new', 'mcp/e.json'),
      e('new', 'rules/f.md'),
      e('new', 'workflows/g.ts'),
    ];
    const out = plain(formatResourceDelta(entries, 5));
    expect(out.split(', ').length).toBe(6); // 5 phrases + "+N more"
    expect(out.endsWith('+2 more')).toBe(true);
  });

  it('returns empty string for no changes', () => {
    expect(formatResourceDelta([])).toBe('');
  });
});
