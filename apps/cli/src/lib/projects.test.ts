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
  it('lists valid defs sorted, skipping a malformed one', () => {
    writeProjectDef({ name: 'zeta' });
    writeProjectDef({ name: 'alpha' });
    fs.writeFileSync(path.join(dir, 'broken.yaml'), '- a\n- b\n', 'utf8');
    const names = listProjectDefs().map((d) => d.name);
    expect(names).toEqual(['alpha', 'zeta']);
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
