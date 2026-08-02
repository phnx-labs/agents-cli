import { describe, it, expect } from 'vitest';
import {
  resourceUnit, formatResourceDelta, resourceDelta, deltaBrief, wrapPhrases, repoSlug,
  resolveDeviceIntent, parseRemoteRepoRows, renderDeviceStatusRows, NO_REPO_FANOUT_ENV,
  type ChangeAction, type DeviceRepoStatus,
} from './repo.js';

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

describe('resourceDelta', () => {
  it('reports total distinct units and ordered counts (new before changed)', () => {
    const d = resourceDelta([
      e('new', 'skills/a/SKILL.md'),
      e('new', 'skills/b/SKILL.md'),
      e('changed', 'hooks/h.md'),
    ]);
    expect(d.total).toBe(3);
    expect(d.counts).toEqual([
      { action: 'new', kind: 'skill', count: 2 },
      { action: 'changed', kind: 'hook', count: 1 },
    ]);
  });

  it('counts a multi-file unit once', () => {
    const d = resourceDelta([e('changed', 'skills/foo/SKILL.md'), e('changed', 'skills/foo/a.md')]);
    expect(d.total).toBe(1);
    expect(d.counts).toEqual([{ action: 'changed', kind: 'skill', count: 1 }]);
  });
});

describe('deltaBrief', () => {
  it('shows the top kinds and folds the rest into +N by unit count', () => {
    // 24 skills, 9 commands, 4 plugins, 7 hooks, 1 workflow -> total 45
    const entries: { action: ChangeAction; file: string }[] = [];
    const add = (kind: string, n: number) => {
      for (let i = 0; i < n; i++) entries.push(e('new', `${kind}/u${i}/f.md`));
    };
    add('skills', 24); add('commands', 9); add('plugins', 4); add('hooks', 7); add('workflows', 1);
    const d = resourceDelta(entries);
    expect(d.total).toBe(45);
    // top 2 kinds shown (24 + 9 = 33 units), remainder 45 - 33 = 12
    expect(plain(deltaBrief(d))).toBe('(24 skills, 9 commands, +12)');
  });

  it('drops the +N when everything fits in the shown kinds', () => {
    const d = resourceDelta([e('changed', 'hooks/h.md'), e('changed', 'rules/r.md')]);
    expect(plain(deltaBrief(d))).toBe('(1 hook, 1 rule)');
  });

  it('is empty for an empty delta', () => {
    expect(deltaBrief(resourceDelta([]))).toBe('');
  });
});

describe('wrapPhrases', () => {
  it('packs phrases into lines no wider than the budget', () => {
    const parts = ['aaaa', 'bbbb', 'cccc']; // each 4 wide, ", " adds 2
    // width 10 fits "aaaa, bbbb" (10) but not a third -> two lines
    expect(wrapPhrases(parts, 10)).toEqual(['aaaa, bbbb', 'cccc']);
  });

  it('keeps an over-long single phrase on its own line rather than dropping it', () => {
    expect(wrapPhrases(['x'.repeat(30)], 10)).toEqual(['x'.repeat(30)]);
  });

  it('measures visible width, ignoring ANSI color codes', () => {
    const red = (s: string) => `[31m${s}[39m`;
    // Two 4-char words colored; budget 10 fits both on one line by visible width.
    expect(wrapPhrases([red('aaaa'), red('bbbb')], 10)).toEqual([`${red('aaaa')}, ${red('bbbb')}`]);
  });
});

describe('repoSlug', () => {
  it('extracts owner/repo from ssh and https git URLs', () => {
    expect(repoSlug('git@github.com:muqsitnawaz/.agents.git')).toBe('muqsitnawaz/.agents');
    expect(repoSlug('https://github.com/phnx-labs/agents-cli.git')).toBe('phnx-labs/agents-cli');
    expect(repoSlug('https://github.com/phnx-labs/agents-cli')).toBe('phnx-labs/agents-cli');
  });

  it('falls back to the raw string for non-github URLs', () => {
    expect(repoSlug('/local/path/repo')).toBe('/local/path/repo');
  });
});

describe('resolveDeviceIntent', () => {
  it('reads --devices-all / --hosts-all as a full-fleet sweep', () => {
    expect(resolveDeviceIntent({ devicesAll: true })).toEqual({ all: true });
    expect(resolveDeviceIntent({ hostsAll: true })).toEqual({ all: true });
  });

  it('treats --devices/--hosts "all" (any case) as a full-fleet sweep', () => {
    expect(resolveDeviceIntent({ devices: 'all' })).toEqual({ all: true });
    expect(resolveDeviceIntent({ hosts: 'ALL' })).toEqual({ all: true });
    expect(resolveDeviceIntent({ devices: '' })).toEqual({ all: true });
  });

  it('parses an explicit comma list into trimmed device names (--devices/--hosts alias)', () => {
    expect(resolveDeviceIntent({ devices: 'a, b ,c' })).toEqual({ hosts: ['a', 'b', 'c'] });
    expect(resolveDeviceIntent({ hosts: 'box' })).toEqual({ hosts: ['box'] });
  });

  it('returns null (local-only) when no device flag is passed', () => {
    expect(resolveDeviceIntent({})).toBeNull();
    expect(resolveDeviceIntent({ verbose: true, json: true })).toBeNull();
  });

  it('never fans out again on a peer carrying the recursion-guard env', () => {
    const prev = process.env[NO_REPO_FANOUT_ENV];
    process.env[NO_REPO_FANOUT_ENV] = '1';
    try {
      expect(resolveDeviceIntent({ devicesAll: true })).toBeNull();
      expect(resolveDeviceIntent({ devices: 'box' })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env[NO_REPO_FANOUT_ENV];
      else process.env[NO_REPO_FANOUT_ENV] = prev;
    }
  });
});

describe('parseRemoteRepoRows', () => {
  it('tags a peer\'s RepoRow[] with its device name', () => {
    const json = JSON.stringify([
      { alias: 'system', branch: 'main', tracking: true, clean: true },
      { alias: 'user', branch: 'main', tracking: true, clean: false },
    ]);
    expect(parseRemoteRepoRows(json, 'yosemite-m0')).toEqual([
      {
        device: 'yosemite-m0',
        reachable: true,
        rows: [
          { alias: 'system', branch: 'main', tracking: true, clean: true },
          { alias: 'user', branch: 'main', tracking: true, clean: false },
        ],
      },
    ]);
  });

  it('drops non-object rows and survives version skew without throwing', () => {
    const json = JSON.stringify([{ alias: 'system' }, null, 5, ['x'], { alias: 'user' }]);
    expect(parseRemoteRepoRows(json, 'box')).toEqual([
      { device: 'box', reachable: true, rows: [{ alias: 'system' }, { alias: 'user' }] },
    ]);
  });

  it('yields no entry for non-JSON or a non-array payload', () => {
    expect(parseRemoteRepoRows('not json', 'box')).toEqual([]);
    expect(parseRemoteRepoRows('{"a":1}', 'box')).toEqual([]);
  });
});

describe('renderDeviceStatusRows', () => {
  // Collapse ANSI + column padding so assertions key on content, not spacing.
  const norm = (s: string) => plain(s).replace(/\s+/g, ' ').trim();

  it('renders one row per (device, repo) with the device shown once per group', () => {
    const results: DeviceRepoStatus[] = [
      {
        device: 'zion', reachable: true, rows: [
          { alias: 'system', branch: 'main', tracking: true, clean: true },
          { alias: 'user', branch: 'main', tracking: true, clean: false, local: resourceDelta([e('changed', 'skills/x/SKILL.md')]) },
        ],
      },
    ];
    const rows = renderDeviceStatusRows(results).map(norm);
    expect(rows[0]).toBe('DEVICE REPO SYNC CHANGES');
    expect(rows).toContain('zion system up to date clean');
    // Second repo of the same device: device column blank -> trims away.
    expect(rows).toContain('user up to date ~1 edit');
  });

  it('shows a compact ↓N pull cell for a behind repo', () => {
    const results: DeviceRepoStatus[] = [
      {
        device: 'box', reachable: true, rows: [
          {
            alias: 'user', branch: 'main', tracking: true, clean: true,
            pull: { delta: resourceDelta([e('new', 'skills/a/SKILL.md'), e('new', 'skills/b/SKILL.md')]), commits: 2 },
          },
        ],
      },
    ];
    const rows = renderDeviceStatusRows(results).map(norm);
    expect(rows).toContain('box user ↓2 (2 skills) clean');
  });

  it('collapses an unreachable device to a single marker row', () => {
    const rows = renderDeviceStatusRows([{ device: 'asleep', reachable: false }]).map(norm);
    expect(rows).toContain('asleep unreachable');
  });

  it('renders a raw trailer (missing / no-remote) in place of the sync cell', () => {
    const results: DeviceRepoStatus[] = [
      { device: 'box', reachable: true, rows: [{ alias: 'user', raw: 'missing /home/u/.agents-work' }] },
    ];
    const rows = renderDeviceStatusRows(results).map(norm);
    expect(rows).toContain('box user missing /home/u/.agents-work');
  });

  it('returns no lines for an empty result set', () => {
    expect(renderDeviceStatusRows([])).toEqual([]);
  });
});
