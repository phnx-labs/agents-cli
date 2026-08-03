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
