import { describe, test, expect, mock } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// agentlinks.vscode imports 'vscode' at module load. The code paths exercised
// here (createSymlinksInDirectory + ensureSymlinksOnWorkspaceOpen with an empty
// mapping set) only touch fs/path, so an empty stub satisfies the import without
// needing the (cross-file, process-global) ripgrep mock.
mock.module('vscode', () => ({}));

// hasEffectiveConfig/loadWorkspaceConfig read VS Code workspace config, which is
// unavailable in the test host. loadWorkspaceConfig is a counting stub so the
// concurrency test can assert the pass body ran exactly once. It returns an
// empty mapping set, which keeps ensureSymlinksOnWorkspaceOpen off the
// findFiles/RelativePattern path entirely.
let loadConfigCalls = 0;
let loadConfigGate: Promise<void> | null = null;
mock.module('./swarmifyConfig.vscode', () => ({
  hasEffectiveConfig: () => true,
  loadWorkspaceConfig: async () => {
    loadConfigCalls++;
    if (loadConfigGate) await loadConfigGate;
    return { context: [] };
  },
}));

const { createSymlinksInDirectory, ensureSymlinksOnWorkspaceOpen } = await import('./agentlinks.vscode');

function freshTmpDir(): string {
  // realpath so path.relative inside createSymlink matches (/tmp -> /private/tmp).
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlinks-'));
}

function workspaceFolderFor(dir: string): any {
  return {
    uri: { fsPath: dir, toString: () => `file://${dir}` },
    name: path.basename(dir),
    index: 0,
  };
}

describe('createSymlinksInDirectory (async fs.promises, real fs)', () => {
  test('creates the configured alias symlinks pointing at the source file', async () => {
    const dir = freshTmpDir();
    const source = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(source, '# agents');

    const { created, errors } = await createSymlinksInDirectory(source, ['CLAUDE.md', 'GEMINI.md']);

    expect(errors).toEqual([]);
    expect(created).toBe(2);
    for (const alias of ['CLAUDE.md', 'GEMINI.md']) {
      const aliasPath = path.join(dir, alias);
      expect(fs.lstatSync(aliasPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(aliasPath)).toBe('AGENTS.md');
      expect(fs.readFileSync(aliasPath, 'utf8')).toBe('# agents');
    }
  });

  test('does not overwrite an alias that already exists', async () => {
    const dir = freshTmpDir();
    const source = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(source, '# agents');
    // Pre-existing real file at the alias path must be left untouched.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'do not clobber');

    const { errors } = await createSymlinksInDirectory(source, ['CLAUDE.md', 'GEMINI.md']);

    expect(errors).toEqual([]);
    // CLAUDE.md stays a regular file with its original contents.
    expect(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('do not clobber');
    // GEMINI.md is still created as a symlink.
    expect(fs.lstatSync(path.join(dir, 'GEMINI.md')).isSymbolicLink()).toBe(true);
  });

  test('reuses the existence cache instead of re-stat-ing the same path', async () => {
    const dir = freshTmpDir();
    const source = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(source, '# agents');
    const cache = new Map<string, boolean>();

    await createSymlinksInDirectory(source, ['CLAUDE.md'], cache);

    // After creation the alias is recorded as existing in the cache.
    expect(cache.get(path.join(dir, 'CLAUDE.md'))).toBe(true);
  });
});

describe('ensureSymlinksOnWorkspaceOpen concurrency (#100 race)', () => {
  test('coalesces concurrent calls for the same workspace onto a single pass', async () => {
    const dir = freshTmpDir();
    const wf = workspaceFolderFor(dir);

    loadConfigCalls = 0;
    // Hold the first call inside loadWorkspaceConfig so the second arrives while
    // it is still in flight — exactly the activation-loop + .agents-watcher
    // race that fired ensureSymlinksOnWorkspaceOpen twice at once.
    let release!: () => void;
    loadConfigGate = new Promise<void>(r => { release = r; });

    const both = Promise.all([
      ensureSymlinksOnWorkspaceOpen(wf),
      ensureSymlinksOnWorkspaceOpen(wf),
    ]);
    release();
    await both;
    loadConfigGate = null;

    // The second concurrent call must reuse the in-flight promise instead of
    // running the body again. Pre-fix, both calls cleared the signature guard
    // before either set it, so the pass ran twice (loadConfigCalls === 2) and a
    // duplicate symlink pass raced to EEXIST.
    expect(loadConfigCalls).toBe(1);
  });

  test('runs again for a later, non-overlapping call (in-flight entry is cleared)', async () => {
    const dir = freshTmpDir();
    const wf = workspaceFolderFor(dir);

    loadConfigCalls = 0;
    loadConfigGate = null;

    await ensureSymlinksOnWorkspaceOpen(wf);
    await ensureSymlinksOnWorkspaceOpen(wf);

    // Sequential calls each enter the body (the signature short-circuit is keyed
    // on mappings, not suppressed by a stale in-flight entry): one config load
    // per call, proving the in-flight map is cleared in the finally block.
    expect(loadConfigCalls).toBe(2);
  });
});
