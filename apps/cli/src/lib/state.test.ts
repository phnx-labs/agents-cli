import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// state.ts resolves HOME and the device id at import time, so we point both at a
// throwaway temp dir and re-import the module fresh for each test. This
// exercises the REAL partition + overlay (writeMetaUnlocked / overlayMachineLocal)
// against real files — no mocking of the persistence layer.
let TMP = '';

async function freshState() {
  vi.resetModules();
  return import('./state.js');
}

function centralPath() {
  return path.join(TMP, '.agents', 'agents.yaml');
}
function devicePath() {
  return path.join(TMP, '.agents', 'devices', 'testbox', 'agents.yaml');
}

// agents.yaml is git-tracked in the user's DotAgents repo, so a read that
// rewrites it dirties the working tree and blocks `agents repo pull`
// ("Working tree has uncommitted changes"). Reads must not write.
function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(centralPath(), yamlText);
}

describe('defaultBrowserProfile is device-local', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-state-test-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('writes to devices/<machine>/agents.yaml, never central, and overlays back on read', async () => {
    const { updateMeta, readMeta } = await freshState();

    updateMeta((m) => ({ ...m, defaultBrowserProfile: 'comet-local' }));

    const central = fs.readFileSync(centralPath(), 'utf-8');
    expect(central).not.toContain('defaultBrowserProfile');

    const device = fs.readFileSync(devicePath(), 'utf-8');
    expect(device).toContain('defaultBrowserProfile: comet-local');

    // Overlay makes it visible again on read (device is the sole source).
    expect(readMeta().defaultBrowserProfile).toBe('comet-local');
  });

  it('clears the value cleanly (no stale overlay resurrecting it)', async () => {
    const { updateMeta, readMeta } = await freshState();

    updateMeta((m) => ({ ...m, defaultBrowserProfile: 'comet-local' }));
    updateMeta((m) => {
      const { defaultBrowserProfile, ...rest } = m;
      void defaultBrowserProfile;
      return rest;
    });

    expect(readMeta().defaultBrowserProfile).toBeUndefined();
    const device = fs.readFileSync(devicePath(), 'utf-8');
    expect(device).not.toContain('defaultBrowserProfile');
  });
});

describe('reading state never writes a tracked agents.yaml (RUSH-1925)', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-state-seed-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('leaves the file byte-identical across repeated reads', async () => {
    // The committed state that deadlocked zion: no hermes entry, so the old
    // read path inserted one and wrote, dirtying a git-tracked file.
    writeCentral('registries:\n  mcp: {}\n  skill: {}\nseededPresets: []\n');
    const before = fs.readFileSync(centralPath(), 'utf-8');

    const { readMeta } = await freshState();
    readMeta();
    readMeta();
    expect(fs.readFileSync(centralPath(), 'utf-8')).toBe(before);
  });

  it('does not resurrect the seed through an unrelated write', async () => {
    // A write for another reason must not flush a seeded registry into the file
    // — that is how the in-memory-only first attempt at this fix still leaked.
    writeCentral('registries:\n  mcp: {}\n  skill: {}\n');

    const { updateMeta } = await freshState();
    updateMeta((m) => ({ ...m, defaultAgent: 'claude' }));

    const after = fs.readFileSync(centralPath(), 'utf-8');
    expect(after).toContain('defaultAgent: claude');
    expect(after).not.toContain('hermes-agent.nousresearch.com');
  });
});

describe('getProjectAgentsDir does not treat a DotAgents-repo clone as a project layer (RUSH-2037)', () => {
  // Cloning your own ~/.agents repo to the canonical ~/src/github.com/<you>/.agents
  // path makes it a git checkout of the very repo whose rules already load as the
  // user layer. It must not ALSO be picked up as a project layer (project outranks
  // user), or a stale clone silently shadows the live rules and plants a compiled
  // AGENTS.md in an ancestor dir. Discovery is by repo identity (git origin), not path.
  function initGitRepo(dir: string, originUrl: string) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl], { stdio: 'ignore' });
  }

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-projectdir-test-'));
    process.env.HOME = TMP;
  });
  afterEach(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('returns a legitimate project .agents/ (a plain subdir, not its own git repo)', async () => {
    const { getProjectAgentsDir } = await freshState();
    const proj = path.join(TMP, 'proj');
    const projAgents = path.join(proj, '.agents');
    fs.mkdirSync(path.join(projAgents, 'rules', 'subrules'), { recursive: true });

    expect(getProjectAgentsDir(proj)).toBe(projAgents);
  });

  it('rejects a checkout of the SYSTEM DotAgents repo at .agents/', async () => {
    const { getProjectAgentsDir } = await freshState();
    const wrap = path.join(TMP, 'src', 'github.com', 'phnx-labs');
    fs.mkdirSync(wrap, { recursive: true });
    fs.writeFileSync(path.join(wrap, 'agents.yaml'), 'agents: {}\n'); // walk boundary
    initGitRepo(path.join(wrap, '.agents'), 'git@github.com:phnx-labs/.agents-system.git');

    expect(getProjectAgentsDir(wrap)).toBeNull();
  });

  it('rejects a checkout of the USER DotAgents repo at .agents/ (origin matches ~/.agents)', async () => {
    // The live user repo (~/.agents) is a git checkout with a known origin...
    initGitRepo(path.join(TMP, '.agents'), 'git@github.com:acme/.agents.git');
    const { getProjectAgentsDir } = await freshState();
    // ...and a *clone* of it sits at the canonical ~/src path.
    const wrap = path.join(TMP, 'src', 'github.com', 'acme');
    fs.mkdirSync(wrap, { recursive: true });
    fs.writeFileSync(path.join(wrap, 'agents.yaml'), 'agents: {}\n'); // walk boundary
    initGitRepo(path.join(wrap, '.agents'), 'https://github.com/acme/.agents.git'); // same slug, different URL form

    expect(getProjectAgentsDir(wrap)).toBeNull();
  });

  it('still returns an UNRELATED git repo checked out at .agents/ (no over-rejection)', async () => {
    const { getProjectAgentsDir } = await freshState();
    const proj = path.join(TMP, 'other-project');
    const projAgents = path.join(proj, '.agents');
    initGitRepo(projAgents, 'git@github.com:example/unrelated-project.git');
    fs.mkdirSync(path.join(projAgents, 'rules'), { recursive: true });

    expect(getProjectAgentsDir(proj)).toBe(projAgents);
  });
});
