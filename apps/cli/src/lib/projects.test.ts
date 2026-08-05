import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isSafeProjectName,
  loadProjectDef,
  listProjectDefs,
  writeProjectDef,
  removeProjectDef,
  validateProjectDef,
  projectBasePath,
  resolveDefinedProjectPath,
  projectNameForCwd,
  resolveProjectNameForCwd,
  type ProjectDef,
} from './projects.js';

const HOME = process.env.HOME ?? os.homedir();
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-test-'));
  process.env.AGENTS_PROJECTS_DIR = dir;
});
afterEach(() => {
  delete process.env.AGENTS_PROJECTS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isSafeProjectName', () => {
  it('accepts slugs, rejects separators and traversal', () => {
    expect(isSafeProjectName('rush')).toBe(true);
    expect(isSafeProjectName('rush-web.2')).toBe(true);
    expect(isSafeProjectName('..')).toBe(false);
    expect(isSafeProjectName('a/b')).toBe(false);
    expect(isSafeProjectName('.hidden')).toBe(false);
    expect(isSafeProjectName('')).toBe(false);
  });
});

describe('validateProjectDef', () => {
  it('throws when name is missing or unsafe', () => {
    expect(() => validateProjectDef({})).toThrow(/valid "name"/);
    expect(() => validateProjectDef({ name: '../evil' })).toThrow(/valid slug/);
    expect(() => validateProjectDef('nope')).toThrow(/mapping/);
  });

  it('throws when the in-file name disagrees with the filename', () => {
    // The filename is the stable id — a def that names itself otherwise would
    // resolve under one name and list under another.
    expect(() => validateProjectDef({ name: 'other' }, 'rush')).toThrow(/must match the filename/);
    expect(validateProjectDef({ name: 'rush' }, 'rush').name).toBe('rush');
    expect(validateProjectDef({ root: '~/x' }, 'rush').name).toBe('rush'); // no name field → filename wins
  });

  it('keeps well-formed nested fields and drops malformed list entries', () => {
    const def = validateProjectDef({
      name: 'rush',
      repos: [{ slug: 'phnx-labs/rush', subpath: 'apps/web' }, { bad: true }, 'nope'],
      contexts: [{ path: 'apps/web', purpose: 'the app' }, { path: 'x' }],
      integrations: [{ kind: 'gdrive', url: 'https://d', label: 'docs' }, { kind: 'x' }],
      linear: { projectId: 'abc', url: 'https://linear' },
    });
    expect(def.repos).toEqual([{ slug: 'phnx-labs/rush', subpath: 'apps/web' }]);
    expect(def.contexts).toEqual([{ path: 'apps/web', purpose: 'the app' }]);
    expect(def.integrations).toEqual([{ kind: 'gdrive', url: 'https://d', label: 'docs' }]);
    expect(def.linear).toEqual({ projectId: 'abc', url: 'https://linear' });
  });

  it('parses linear.name alongside existing linear fields', () => {
    const def = validateProjectDef({
      name: 'rush',
      linear: { projectId: 'lin_1', url: 'https://linear.app/x', name: 'Rush' },
    });
    expect(def.linear).toEqual({ projectId: 'lin_1', url: 'https://linear.app/x', name: 'Rush' });
  });

  it('parses dispatch block with all optional subfields', () => {
    const def = validateProjectDef({
      name: 'rush',
      dispatch: { enabled: true, maxAgents: 3, provider: 'codex', host: 'mac-mini' },
    });
    expect(def.dispatch).toEqual({ enabled: true, maxAgents: 3, provider: 'codex', host: 'mac-mini' });
  });

  it('accepts a partial dispatch block', () => {
    const def = validateProjectDef({ name: 'rush', dispatch: { enabled: false } });
    expect(def.dispatch).toEqual({ enabled: false });
    expect(def.dispatch?.maxAgents).toBeUndefined();
  });

  it('ignores a non-finite or non-number maxAgents', () => {
    const def1 = validateProjectDef({ name: 'rush', dispatch: { maxAgents: 'five' } });
    expect(def1.dispatch?.maxAgents).toBeUndefined();
    const def2 = validateProjectDef({ name: 'rush', dispatch: { maxAgents: Infinity } });
    expect(def2.dispatch?.maxAgents).toBeUndefined();
  });

  it('omits dispatch entirely when the field is absent', () => {
    const def = validateProjectDef({ name: 'rush' });
    expect(def.dispatch).toBeUndefined();
  });

  it('accepts repos[].path (string) and drops an entry whose path is malformed', () => {
    const def = validateProjectDef({
      name: 'rush',
      repos: [
        { slug: 'phnx-labs/rush-infra', path: '~/src/rush-infra' },
        { slug: 'phnx-labs/bad', path: 42 },
      ],
    });
    expect(def.repos).toEqual([{ slug: 'phnx-labs/rush-infra', path: '~/src/rush-infra' }]);
  });

  it('keeps well-formed goals (measure optional) and drops entries without a string objective', () => {
    const def = validateProjectDef({
      name: 'rush',
      goals: [
        { objective: 'Ship agents-cli 2.0', measure: 'fleet on 2.x' },
        { objective: 'Grow adoption' },
        { measure: 'no objective' },
        { objective: 42 },
        'nope',
      ],
    });
    expect(def.goals).toEqual([
      { objective: 'Ship agents-cli 2.0', measure: 'fleet on 2.x' },
      { objective: 'Grow adoption' },
    ]);
  });
});

describe('write/load roundtrip', () => {
  it('normalizes root/defaultPath to home-relative and reads back', () => {
    const abs = path.join(HOME, 'src', 'github.com', 'me', 'rush');
    writeProjectDef({ name: 'rush', root: abs, defaultPath: path.join(abs, 'apps/web') });
    const raw = fs.readFileSync(path.join(dir, 'rush.yaml'), 'utf8');
    expect(raw).toContain('root: ~/src/github.com/me/rush');
    expect(raw).toContain('defaultPath: ~/src/github.com/me/rush/apps/web');

    const loaded = loadProjectDef('rush');
    expect(loaded?.name).toBe('rush');
    expect(loaded?.root).toBe('~/src/github.com/me/rush');
  });

  it('normalizes repos[].path to home-relative and preserves it through the roundtrip', () => {
    const abs = path.join(HOME, 'src', 'github.com', 'me', 'rush-infra');
    writeProjectDef({
      name: 'rush',
      root: path.join(HOME, 'src', 'github.com', 'me', 'rush'),
      repos: [{ slug: 'phnx-labs/rush-infra', subpath: 'deploy', path: abs }],
    });
    const raw = fs.readFileSync(path.join(dir, 'rush.yaml'), 'utf8');
    expect(raw).toContain('path: ~/src/github.com/me/rush-infra');

    const loaded = loadProjectDef('rush');
    expect(loaded?.repos).toEqual([
      { slug: 'phnx-labs/rush-infra', subpath: 'deploy', path: '~/src/github.com/me/rush-infra' },
    ]);
  });

  it('loadProjectDef returns undefined for an absent project', () => {
    expect(loadProjectDef('ghost')).toBeUndefined();
  });

  it('loadProjectDef throws on a bad name field and on a non-mapping (fail loud)', () => {
    fs.writeFileSync(path.join(dir, 'badname.yaml'), 'name: 123\n', 'utf8');
    expect(() => loadProjectDef('badname')).toThrow(/must be a valid slug/);
    fs.writeFileSync(path.join(dir, 'seq.yaml'), '- a\n- b\n', 'utf8');
    expect(() => loadProjectDef('seq')).toThrow(/mapping/);
  });
});

describe('listProjectDefs', () => {
  it('lists valid defs sorted', () => {
    writeProjectDef({ name: 'zeta' });
    writeProjectDef({ name: 'alpha' });
    const names = listProjectDefs().map((d) => d.name);
    expect(names).toEqual(['alpha', 'zeta']);
  });

  it('surfaces a malformed definition instead of returning a false empty state', () => {
    writeProjectDef({ name: 'valid' });
    fs.writeFileSync(path.join(dir, 'broken.yaml'), '- a\n- b\n', 'utf8');
    expect(() => listProjectDefs()).toThrow(/mapping/);
  });

  it('ignores a .yml file so list and load agree on .yaml (no silent-drop)', () => {
    writeProjectDef({ name: 'real' });
    fs.writeFileSync(path.join(dir, 'ghost.yml'), 'name: ghost\n', 'utf8');
    // listed set is exactly the .yaml files...
    expect(listProjectDefs().map((d) => d.name)).toEqual(['real']);
    // ...and loadProjectDef agrees: the .yml is not loadable, so it's not "there".
    expect(loadProjectDef('ghost')).toBeUndefined();
  });

  it('is empty when the dir does not exist', () => {
    process.env.AGENTS_PROJECTS_DIR = path.join(dir, 'nope');
    expect(listProjectDefs()).toEqual([]);
  });
});

describe('removeProjectDef', () => {
  it('removes an existing def and reports false for a missing one', () => {
    writeProjectDef({ name: 'gone' });
    expect(removeProjectDef('gone')).toBe(true);
    expect(loadProjectDef('gone')).toBeUndefined();
    expect(removeProjectDef('gone')).toBe(false);
  });

  it('surfaces filesystem failures instead of reporting a missing project', () => {
    fs.mkdirSync(path.join(dir, 'blocked.yaml'));
    expect(() => removeProjectDef('blocked')).toThrow();
  });
});

describe('projectBasePath', () => {
  const def: ProjectDef = { name: 'rush', root: '~/src/rush', defaultPath: '~/src/rush/apps/web' };
  it('prefers defaultPath, keeps ~ for remote, expands for local', () => {
    expect(projectBasePath(def, true)).toBe('~/src/rush/apps/web');
    expect(projectBasePath(def, false)).toBe(path.join(HOME, 'src/rush/apps/web'));
  });
  it('falls back to root, and undefined when neither set', () => {
    expect(projectBasePath({ name: 'x', root: '~/r' }, true)).toBe('~/r');
    expect(projectBasePath({ name: 'x' }, true)).toBeUndefined();
  });
});

describe('resolveDefinedProjectPath', () => {
  const def: ProjectDef = { name: 'rush', root: '~/src/rush', defaultPath: '~/src/rush/apps/web' };
  it('no worktree → defaultPath, ~ kept for remote', () => {
    expect(resolveDefinedProjectPath(def, undefined, true)).toBe('~/src/rush/apps/web');
    expect(resolveDefinedProjectPath(def, undefined, false)).toBe(path.join(HOME, 'src/rush/apps/web'));
  });
  it('worktree hangs off the repo ROOT, not the defaultPath subdir', () => {
    expect(resolveDefinedProjectPath(def, 'fix', true)).toBe('~/src/rush/.agents/worktrees/fix');
    expect(resolveDefinedProjectPath(def, 'fix', false)).toBe(
      path.join(HOME, 'src/rush/.agents/worktrees/fix'),
    );
  });
  it('undefined when the definition has no root/defaultPath', () => {
    expect(resolveDefinedProjectPath({ name: 'bare' }, undefined, true)).toBeUndefined();
    expect(resolveDefinedProjectPath({ name: 'bare' }, 'wt', true)).toBeUndefined();
  });
});

describe('projectNameForCwd', () => {
  const defs: ProjectDef[] = [
    { name: 'rush', root: '~/src/rush' },
    { name: 'rush-web', root: '~/src/rush/apps/web' }, // nested — must win over rush
    { name: 'other', root: '~/src/other' },
  ];
  it('matches a cwd inside a project root, longest (nested) wins', () => {
    expect(projectNameForCwd(path.join(HOME, 'src/rush/packages/api'), defs)).toBe('rush');
    expect(projectNameForCwd(path.join(HOME, 'src/rush/apps/web/components'), defs)).toBe('rush-web');
    expect(projectNameForCwd(path.join(HOME, 'src/rush'), defs)).toBe('rush');
  });
  it('matches a worktree under the project root', () => {
    expect(projectNameForCwd(path.join(HOME, 'src/rush/.agents/worktrees/fix'), defs)).toBe('rush');
  });
  it('undefined for a cwd outside every project, or a sibling-prefix false match', () => {
    expect(projectNameForCwd(path.join(HOME, 'src/unrelated'), defs)).toBeUndefined();
    // ~/src/rush-extra must NOT match ~/src/rush (segment-aware, not string prefix)
    expect(projectNameForCwd(path.join(HOME, 'src/rush-extra/x'), defs)).toBeUndefined();
    expect(projectNameForCwd(undefined, defs)).toBeUndefined();
  });
});

describe('resolveProjectNameForCwd', () => {
  it('prefers the defined project over the repo key', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-canonical-'));
    try {
      fs.mkdirSync(path.join(repo, '.git'));
      const sub = path.join(repo, 'apps', 'web');
      fs.mkdirSync(sub, { recursive: true });
      const defs: ProjectDef[] = [{ name: 'rush', root: repo }];
      expect(resolveProjectNameForCwd(sub, defs)).toBe('rush'); // def name, not the repo basename
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('falls back to the repository key for a cwd no definition contains — and with no defs at all', () => {
    // Real temp repo: the fallback does the fs walk and names the repo dir.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-fallback-'));
    try {
      fs.mkdirSync(path.join(repo, '.git'));
      const sub = path.join(repo, 'apps', 'cli');
      fs.mkdirSync(sub, { recursive: true });
      const elsewhere: ProjectDef[] = [{ name: 'rush', root: path.join(repo, 'elsewhere-def-root') }];
      expect(resolveProjectNameForCwd(sub, elsewhere)).toBe(path.basename(repo));
      expect(resolveProjectNameForCwd(sub, [])).toBe(path.basename(repo)); // == today's behavior
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('undefined for an empty cwd', () => {
    expect(resolveProjectNameForCwd(undefined, [])).toBeUndefined();
    expect(resolveProjectNameForCwd('', [])).toBeUndefined();
  });
});

describe('projectNameForCwd — monorepo subprojects', () => {
  const HOME_ = process.env.HOME ?? os.homedir();
  const mono = path.join(HOME_, 'src', 'rush');
  // Two projects sharing ONE checkout: the umbrella and a subdir project.
  const defs: ProjectDef[] = [
    { name: 'rush', root: '~/src/rush' },
    { name: 'rush-cli', root: '~/src/rush', defaultPath: '~/src/rush/apps/cli' },
  ];

  it('attributes work in the subdir to the SUBPROJECT, not the umbrella', () => {
    // `root ?? defaultPath` gave both defs the same anchor (~/src/rush), so the
    // longest-match tiebreak had nothing to separate them and the first listed
    // def won regardless of where the session actually was.
    expect(projectNameForCwd(path.join(mono, 'apps', 'cli', 'src'), defs)).toBe('rush-cli');
    expect(projectNameForCwd(path.join(mono, 'apps', 'cli'), defs)).toBe('rush-cli');
  });

  it('still attributes work outside the subdir to the umbrella', () => {
    expect(projectNameForCwd(path.join(mono, 'apps', 'web'), defs)).toBe('rush');
    expect(projectNameForCwd(mono, defs)).toBe('rush');
  });

  it('does not depend on definition order', () => {
    const reversed = [...defs].reverse();
    expect(projectNameForCwd(path.join(mono, 'apps', 'cli', 'x'), reversed)).toBe('rush-cli');
    expect(projectNameForCwd(path.join(mono, 'apps', 'web'), reversed)).toBe('rush');
  });

  it('anchors a bound repo checkout and its subpath too', () => {
    const withRepos: ProjectDef[] = [
      { name: 'umbrella', root: '~/src/rush' },
      { name: 'infra', root: '~/src/rush', repos: [{ slug: 'o/infra', path: '~/src/rush/infra', subpath: 'deploy' }] },
    ];
    expect(projectNameForCwd(path.join(mono, 'infra', 'deploy', 'k8s'), withRepos)).toBe('infra');
    expect(projectNameForCwd(path.join(mono, 'infra'), withRepos)).toBe('infra');
    expect(projectNameForCwd(path.join(mono, 'docs'), withRepos)).toBe('umbrella');
  });

  it('matches nothing outside every anchor', () => {
    expect(projectNameForCwd(path.join(HOME_, 'src', 'elsewhere'), defs)).toBeUndefined();
  });

  it('a lone narrowed project still owns the rest of its own checkout', () => {
    // The subdir claim must not shrink a project that has no umbrella beside it:
    // `--path` picks where an agent starts, not which work counts. Narrowing to
    // the subdir alone silently orphaned every session in the repo root and in
    // sibling subdirs.
    const solo: ProjectDef[] = [{ name: 'foo', root: '~/src/foo', defaultPath: '~/src/foo/apps/web' }];
    const repo = path.join(HOME_, 'src', 'foo');
    expect(projectNameForCwd(path.join(repo, 'apps', 'web'), solo)).toBe('foo');
    expect(projectNameForCwd(repo, solo)).toBe('foo');
    expect(projectNameForCwd(path.join(repo, 'apps', 'api'), solo)).toBe('foo');
    // Still bounded by the root.
    expect(projectNameForCwd(path.join(HOME_, 'src', 'bar'), solo)).toBeUndefined();
  });

  it('the umbrella outranks a subproject root even when listed second', () => {
    // The fallback must lose to any outright claim, in either definition order.
    const reversed = [...defs].reverse();
    expect(projectNameForCwd(path.join(mono, 'apps', 'web'), defs)).toBe('rush');
    expect(projectNameForCwd(path.join(mono, 'apps', 'web'), reversed)).toBe('rush');
    expect(projectNameForCwd(mono, defs)).toBe('rush');
    expect(projectNameForCwd(mono, reversed)).toBe('rush');
  });
});
