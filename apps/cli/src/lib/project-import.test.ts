import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  buildFactoryImportCandidates,
  buildLinearImportCandidates,
  slugifyProjectName,
  validateImportOpts,
  type LinearImportDeps,
} from './project-import.js';
import { matchLocalCheckoutExact } from './linear-projects.js';
import type { ProjectDef } from './projects.js';

const HOME = process.env.HOME ?? os.homedir();

/** The real registry's shape — the rows that buried the user's actual projects. */
const FACTORY_ROWS = [
  { name: 'agents-cli', path: path.join(HOME, 'src/agents-cli'), repoSlug: 'muqsitnawaz/agents-cli', confidence: 'high' },
  { name: 'agents', path: path.join(HOME, 'src/agents'), repoSlug: 'muqsitnawaz/agents', confidence: 'high' },
  { name: 'swarmify', path: path.join(HOME, 'src/swarmify'), repoSlug: 'muqsitnawaz/swarmify', confidence: 'medium' },
  { name: 'inflow', path: path.join(HOME, 'src/inflow'), repoSlug: 'grinich/inflow', confidence: 'low' },
  { name: 'agents-cleaned-stale2', path: path.join(HOME, 'src/agents-cleaned-stale2'), confidence: 'low' },
  { name: 'nameless-confidence', path: path.join(HOME, 'src/x') },
];

const names = (r: { defs: ProjectDef[] }) => r.defs.map((d) => d.name);

describe('validateImportOpts', () => {
  it('requires exactly one source', () => {
    expect(() => validateImportOpts({})).toThrow(/Pick an import source/);
    expect(() => validateImportOpts({ fromFactory: true, fromLinear: true })).toThrow(/mutually exclusive/);
    expect(validateImportOpts({ fromLinear: true }).source).toBe('linear');
  });

  it('defaults the factory floor to high and lowers it with --all', () => {
    expect(validateImportOpts({ fromFactory: true }).minConfidence).toBe('high');
    expect(validateImportOpts({ fromFactory: true, all: true }).minConfidence).toBe('any');
    expect(validateImportOpts({ fromFactory: true, minConfidence: 'MEDIUM' }).minConfidence).toBe('medium');
  });

  it('errors loudly on an unknown confidence instead of falling back', () => {
    expect(() => validateImportOpts({ fromFactory: true, minConfidence: 'kinda' })).toThrow(/Invalid --min-confidence/);
  });

  it('rejects confidence flags that do not apply, and contradictory ones', () => {
    expect(() => validateImportOpts({ fromLinear: true, all: true })).toThrow(/--from-factory only/);
    expect(() => validateImportOpts({ fromLinear: true, minConfidence: 'low' })).toThrow(/--from-factory only/);
    expect(() => validateImportOpts({ fromFactory: true, all: true, minConfidence: 'high' })).toThrow(/mutually exclusive/);
  });
});

describe('buildFactoryImportCandidates', () => {
  it('imports only high-confidence rows by default', () => {
    const r = buildFactoryImportCandidates(FACTORY_ROWS, new Map(), { minConfidence: 'high', force: false });
    expect(names(r)).toEqual(['agents-cli', 'agents']);
    expect(r.skipped.map((s) => s.name)).toEqual(['swarmify', 'inflow', 'agents-cleaned-stale2', 'nameless-confidence']);
    expect(r.skipped[0].reason).toBe('confidence "medium" is below the "high" floor');
  });

  it('widens to medium, and to everything under --all', () => {
    const med = buildFactoryImportCandidates(FACTORY_ROWS, new Map(), { minConfidence: 'medium', force: false });
    expect(names(med)).toEqual(['agents-cli', 'agents', 'swarmify']);
    const low = buildFactoryImportCandidates(FACTORY_ROWS, new Map(), { minConfidence: 'low', force: false });
    expect(names(low)).toEqual(['agents-cli', 'agents', 'swarmify', 'inflow', 'agents-cleaned-stale2']);
    const all = buildFactoryImportCandidates(FACTORY_ROWS, new Map(), { minConfidence: 'any', force: false });
    expect(names(all)).toEqual(['agents-cli', 'agents', 'swarmify', 'inflow', 'agents-cleaned-stale2', 'nameless-confidence']);
  });

  it('treats a missing confidence field as below every stated floor — only --all takes it', () => {
    const r = buildFactoryImportCandidates(FACTORY_ROWS, new Map(), { minConfidence: 'any', force: false });
    expect(names(r)).toContain('nameless-confidence');
    const low = buildFactoryImportCandidates(FACTORY_ROWS, new Map(), { minConfidence: 'low', force: false });
    expect(names(low)).not.toContain('nameless-confidence');
    const strict = buildFactoryImportCandidates(FACTORY_ROWS, new Map(), { minConfidence: 'medium', force: false });
    expect(strict.skipped.find((s) => s.name === 'nameless-confidence')?.reason)
      .toBe('no confidence field is below the "medium" floor');
  });

  it('stores the root home-relative and maps repo + linear id', () => {
    const r = buildFactoryImportCandidates(
      [{ name: 'rush', path: path.join(HOME, 'src/rush'), repoSlug: 'phnx-labs/rush', linearProjectId: 'lin_1', confidence: 'high' }],
      new Map(),
      { minConfidence: 'high', force: false },
    );
    expect(r.defs[0]).toEqual({ name: 'rush', root: '~/src/rush', repo: 'phnx-labs/rush', linear: { projectId: 'lin_1' } });
  });

  it('keeps an existing def unless --force', () => {
    const existing = new Map<string, ProjectDef>([['agents-cli', { name: 'agents-cli', description: 'mine' }]]);
    const keep = buildFactoryImportCandidates(FACTORY_ROWS, existing, { minConfidence: 'high', force: false });
    expect(names(keep)).toEqual(['agents']);
    expect(keep.skipped[0]).toEqual({ name: 'agents-cli', reason: 'already defined — pass --force to overwrite' });
    const forced = buildFactoryImportCandidates(FACTORY_ROWS, existing, { minConfidence: 'high', force: true });
    expect(names(forced)).toEqual(['agents-cli', 'agents']);
  });

  it('skips a duplicate name in the same registry instead of silently clobbering the first', () => {
    // The registry keys by owner/repo but names by basename, so two orgs with
    // the same repo name arrive as two rows called `inflow`.
    const r = buildFactoryImportCandidates(
      [
        { name: 'inflow', path: '/tmp/a/inflow', repoSlug: 'grinich/inflow', confidence: 'high' },
        { name: 'inflow', path: '/tmp/b/inflow', repoSlug: 'me/inflow', confidence: 'high' },
      ],
      new Map(),
      { minConfidence: 'high', force: false },
    );
    expect(r.defs).toHaveLength(1);
    expect(r.defs[0].repo).toBe('grinich/inflow');
    expect(r.skipped).toEqual([{ name: 'inflow', reason: 'another row in this registry already claimed the name' }]);
  });

  it('skips rows with an unusable name rather than writing a bad filename', () => {
    const r = buildFactoryImportCandidates(
      [{ name: '../escape', confidence: 'high' }, { confidence: 'high' }],
      new Map(),
      { minConfidence: 'high', force: false },
    );
    expect(r.defs).toEqual([]);
    expect(r.skipped).toEqual([
      { name: '../escape', reason: 'not a usable project name' },
      { name: '(unnamed)', reason: 'not a usable project name' },
    ]);
  });
});

describe('slugifyProjectName', () => {
  it('turns a Linear display name into a safe slug', () => {
    expect(slugifyProjectName('Agents CLI')).toBe('agents-cli');
    expect(slugifyProjectName('Rush / Web')).toBe('rush-web');
    expect(slugifyProjectName('  Q3 — Growth!  ')).toBe('q3-growth');
    expect(slugifyProjectName('x'.repeat(80))).toHaveLength(64);
  });

  it('returns empty when nothing usable survives', () => {
    expect(slugifyProjectName('!!!')).toBe('');
    expect(slugifyProjectName('')).toBe('');
  });
});

describe('matchLocalCheckoutExact', () => {
  const dirs = ['agents-cli', 'agents-cli-web', 'rush'];

  it('binds only on an exact normalized match', () => {
    expect(matchLocalCheckoutExact('Agents CLI', dirs)).toBe('agents-cli');
    expect(matchLocalCheckoutExact('agents_cli', dirs)).toBe('agents-cli');
  });

  it('refuses the containment match that would bind the wrong checkout', () => {
    expect(matchLocalCheckoutExact('Agents CLI Website', dirs)).toBeUndefined();
    expect(matchLocalCheckoutExact('Nothing Here', dirs)).toBeUndefined();
  });

  it('refuses an ambiguous match', () => {
    expect(matchLocalCheckoutExact('Agents CLI', ['agents-cli', 'agents_cli'])).toBeUndefined();
  });

  it('treats a slash in a display name as punctuation, not a path boundary', () => {
    // "Rush / Web" is one name, not `rush/web`. Keying it the path way (last
    // segment) yields `web`, which exact-matches an unrelated `web/` checkout.
    expect(matchLocalCheckoutExact('Rush / Web', ['web', 'agents-cli'])).toBeUndefined();
    expect(matchLocalCheckoutExact('Rush / Web', ['rush-web', 'web'])).toBe('rush-web');
  });
});

describe('buildLinearImportCandidates', () => {
  const deps: LinearImportDeps = {
    localDirs: ['agents-cli', 'agents-cli-web'],
    resolveRoot: (d) => `~/src/${d}`,
    resolveOrigin: (d) => `muqsitnawaz/${d}`,
  };
  const noLocal: LinearImportDeps = { localDirs: [], resolveRoot: () => undefined, resolveOrigin: () => undefined };

  it('binds root and repo on an exact local match', () => {
    const r = buildLinearImportCandidates(
      [{ id: 'lin_1', name: 'Agents CLI', url: 'https://linear.app/x/project/agents-cli' }],
      new Map(),
      deps,
      { force: false },
    );
    expect(r.defs[0]).toEqual({
      name: 'agents-cli',
      root: '~/src/agents-cli',
      repo: 'muqsitnawaz/agents-cli',
      linear: { projectId: 'lin_1', url: 'https://linear.app/x/project/agents-cli' },
    });
  });

  it('writes name + linear only when no local checkout matches', () => {
    const r = buildLinearImportCandidates([{ id: 'lin_2', name: 'Marketing Site' }], new Map(), deps, { force: false });
    expect(r.defs[0]).toEqual({ name: 'marketing-site', linear: { projectId: 'lin_2' } });
  });

  it('does NOT auto-bind on a containment-only match', () => {
    const r = buildLinearImportCandidates([{ id: 'lin_3', name: 'Agents' }], new Map(), deps, { force: false });
    expect(r.defs[0]).toEqual({ name: 'agents', linear: { projectId: 'lin_3' } });
  });

  it('does NOT bind a slashed display name to the checkout after the slash', () => {
    // Regression: "Rush / Web" once bound `~/src/web` because the match key
    // kept only the last path segment. The def name and the match key must be
    // derived from the same reading of the string.
    const r = buildLinearImportCandidates(
      [{ id: 'lin_rw', name: 'Rush / Web' }],
      new Map(),
      { localDirs: ['web', 'agents-cli'], resolveRoot: (d) => `~/src/${d}`, resolveOrigin: (d) => `someone/${d}` },
      { force: false },
    );
    expect(r.defs[0]).toEqual({ name: 'rush-web', linear: { projectId: 'lin_rw' } });
  });

  it('preserves hand-set fields on an existing def and overwrites only linear', () => {
    const existing = new Map<string, ProjectDef>([
      ['agents-cli', { name: 'agents-cli', description: 'the CLI', contexts: [{ path: 'apps/cli', purpose: 'the package' }], linear: { projectId: 'old' } }],
    ]);
    const r = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], existing, noLocal, { force: false });
    expect(r.defs[0]).toEqual({
      name: 'agents-cli',
      description: 'the CLI',
      contexts: [{ path: 'apps/cli', purpose: 'the package' }],
      linear: { projectId: 'lin_1' },
    });
  });

  it('re-imports idempotently — the same name overwrites in place', () => {
    const first = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], new Map(), deps, { force: false });
    const second = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], new Map(first.defs.map((d) => [d.name, d])), deps, { force: true });
    expect(second.defs).toEqual(first.defs);
  });

  it('refuses to relink a def that already has root/repo without --force', () => {
    const existing = new Map<string, ProjectDef>([['agents-cli', { name: 'agents-cli', root: '~/elsewhere', repo: 'me/mine' }]]);
    const r = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], existing, deps, { force: false });
    expect(r.defs).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'agents-cli', reason: 'existing def already has root/repo — pass --force to relink' }]);
    const forced = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], existing, deps, { force: true });
    expect(forced.defs[0].root).toBe('~/src/agents-cli');
  });

  it('skips a slug collision instead of silently overwriting the first', () => {
    const r = buildLinearImportCandidates(
      [{ id: 'a', name: 'Rush Web' }, { id: 'b', name: 'rush/web' }],
      new Map(),
      noLocal,
      { force: false },
    );
    expect(names(r)).toEqual(['rush-web']);
    expect(r.defs[0].linear).toEqual({ projectId: 'a' });
    expect(r.skipped).toEqual([{ name: 'rush/web', reason: 'another Linear project already claimed the name "rush-web"' }]);
  });

  it('skips a project whose name has no safe slug', () => {
    const r = buildLinearImportCandidates([{ id: 'a', name: '!!!' }], new Map(), noLocal, { force: false });
    expect(r.defs).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/no usable project name/);
  });
});
