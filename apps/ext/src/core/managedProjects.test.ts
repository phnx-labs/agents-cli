import { test, describe, expect } from 'bun:test';
import {
  defToManaged,
  managedToProjectDef,
  projectNameFromPath,
  upsertManagedProject,
  deleteManagedProject,
} from './managedProjects';
import * as os from 'os';
import * as path from 'path';

const HOME = os.homedir();

describe('projectNameFromPath', () => {
  test('returns the folder basename', () => {
    expect(projectNameFromPath('/Users/me/src/github.com/phnx-labs/agents-cli')).toBe('agents-cli');
    expect(projectNameFromPath('/a/b/')).toBe('b');
    expect(projectNameFromPath('foo')).toBe('foo');
  });
});

describe('defToManaged', () => {
  test('maps name to id and name', () => {
    const m = defToManaged({ name: 'rush', root: '~/src/rush' });
    expect(m.id).toBe('rush');
    expect(m.name).toBe('rush');
    expect(m.confidence).toBe('high');
    expect(m.source).toBe('manual');
  });

  test('expands home-relative root to absolute path', () => {
    const m = defToManaged({ name: 'rush', root: '~/src/rush' });
    expect(m.path).toBe(path.join(HOME, 'src/rush'));
  });

  test('falls back to defaultPath when root is absent', () => {
    const m = defToManaged({ name: 'rush', defaultPath: '~/src/rush/apps/web' });
    expect(m.path).toBe(path.join(HOME, 'src/rush/apps/web'));
  });

  test('leaves absolute paths unchanged', () => {
    const m = defToManaged({ name: 'rush', root: '/abs/path' });
    expect(m.path).toBe('/abs/path');
  });

  test('maps linear.projectId and linear.name', () => {
    const m = defToManaged({ name: 'rush', linear: { projectId: 'lin_1', name: 'Rush', url: 'https://linear.app/x' } });
    expect(m.linearProjectId).toBe('lin_1');
    expect(m.linearProjectName).toBe('Rush');
  });

  test('maps dispatch.enabled to autoDispatch', () => {
    const on = defToManaged({ name: 'rush', dispatch: { enabled: true } });
    expect(on.autoDispatch).toBe(true);

    const off = defToManaged({ name: 'rush', dispatch: { enabled: false } });
    expect(off.autoDispatch).toBe(false);

    const absent = defToManaged({ name: 'rush' });
    expect(absent.autoDispatch).toBe(false);
  });

  test('maps dispatch.maxAgents', () => {
    const m = defToManaged({ name: 'rush', dispatch: { enabled: true, maxAgents: 4 } });
    expect(m.maxAgents).toBe(4);

    const none = defToManaged({ name: 'rush' });
    expect(none.maxAgents).toBeUndefined();
  });

  test('maps repo slug from top-level repo field', () => {
    const m = defToManaged({ name: 'rush', repo: 'phnx-labs/rush' });
    expect(m.repoSlug).toBe('phnx-labs/rush');
  });

  test('falls back to repos[0].slug when repo is absent', () => {
    const m = defToManaged({ name: 'rush', repos: [{ slug: 'phnx-labs/rush' }, { slug: 'phnx-labs/other' }] });
    expect(m.repoSlug).toBe('phnx-labs/rush');
  });

  test('prefers top-level repo over repos[0].slug', () => {
    const m = defToManaged({ name: 'rush', repo: 'phnx-labs/rush', repos: [{ slug: 'phnx-labs/other' }] });
    expect(m.repoSlug).toBe('phnx-labs/rush');
  });

  test('empty name yields empty id and name', () => {
    const m = defToManaged({});
    expect(m.id).toBe('');
    expect(m.name).toBe('');
  });
});

describe('managedToProjectDef', () => {
  test('maps ManagedProject fields onto a ProjectDef shape', () => {
    const def = managedToProjectDef({
      id: 'rush',
      name: 'rush',
      path: path.join(HOME, 'src/rush'),
      repoSlug: 'phnx-labs/rush',
      dirs: [],
      linearProjectId: 'lin_1',
      linearProjectName: 'Rush',
      autoDispatch: true,
      maxAgents: 3,
      confidence: 'high',
      source: 'manual',
    });
    expect(def.name).toBe('rush');
    expect(def.root).toBe('~/src/rush');
    expect(def.repo).toBe('phnx-labs/rush');
    expect(def.linear).toEqual({ projectId: 'lin_1', name: 'Rush' });
    expect(def.dispatch).toEqual({ enabled: true, maxAgents: 3 });
  });

  test('preserves unmanaged prior fields (goals, contexts) and drops agents stamp', () => {
    const def = managedToProjectDef(
      {
        id: 'rush',
        name: 'rush',
        path: path.join(HOME, 'src/rush'),
        dirs: [],
        confidence: 'high',
        source: 'manual',
      },
      {
        name: 'rush',
        root: '~/old',
        goals: [{ objective: 'Ship 2.0' }],
        contexts: [{ path: 'apps/cli', purpose: 'CLI' }],
        agents: 4,
      },
    );
    expect(def.goals).toEqual([{ objective: 'Ship 2.0' }]);
    expect(def.contexts).toEqual([{ path: 'apps/cli', purpose: 'CLI' }]);
    expect(def.root).toBe('~/src/rush');
    expect(def.agents).toBeUndefined();
  });

  test('preserves prior dispatch fields when an older AGI EXT payload omits them', () => {
    const def = managedToProjectDef(
      {
        id: 'rush',
        name: 'rush',
        path: path.join(HOME, 'src/rush'),
        dirs: [],
        confidence: 'high',
        source: 'manual',
      },
      {
        name: 'rush',
        dispatch: { enabled: true, maxAgents: 4, provider: 'host', host: 'mac-mini' },
      },
    );
    expect(def.dispatch).toEqual({ enabled: true, maxAgents: 4, provider: 'host', host: 'mac-mini' });
  });

  test('an explicit autoDispatch false disables dispatch without deleting its routing fields', () => {
    const def = managedToProjectDef(
      {
        id: 'rush',
        name: 'rush',
        path: path.join(HOME, 'src/rush'),
        dirs: [],
        autoDispatch: false,
        confidence: 'high',
        source: 'manual',
      },
      {
        name: 'rush',
        dispatch: { enabled: true, maxAgents: 4, provider: 'host', host: 'mac-mini' },
      },
    );
    expect(def.dispatch).toEqual({ maxAgents: 4, provider: 'host', host: 'mac-mini' });
  });
});

describe('upsertManagedProject / deleteManagedProject — id safety', () => {
  test('upsert rejects a path-traversal id before shelling out', async () => {
    const bad = { id: '../secret', name: 'x', path: '/tmp/x', dirs: [], confidence: 'high', source: 'manual' } as Parameters<typeof upsertManagedProject>[0];
    await expect(upsertManagedProject(bad)).rejects.toThrow(/Unsafe project id/);
  });

  test('delete rejects a path-traversal id before shelling out', async () => {
    await expect(deleteManagedProject('../secret')).rejects.toThrow(/Unsafe project id/);
  });

  test('delete rejects a dot-dot id', async () => {
    await expect(deleteManagedProject('..')).rejects.toThrow(/Unsafe project id/);
  });
});
