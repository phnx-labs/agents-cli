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

describe('pins route to the untracked pins file; the tracked doc is operator-only', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-state-test-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
    // getDevicesDir() reads this at call time (tests/setup.ts pins it fork-wide).
    process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    delete process.env.AGENTS_DEVICES_DIR;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function pinsPath() {
    return path.join(TMP, '.agents', '.history', 'devices', 'pins-testbox.json');
  }

  it('routes agents:/isolatedAgents: to .history pins JSON, never the tracked doc or central', async () => {
    const { updateMeta, readMeta } = await freshState();

    updateMeta((m) => ({
      ...m,
      agents: { claude: '2.1.0' },
      isolatedAgents: { codex: '0.144.6' },
      fleet: { devices: {}, defaults: { config: { maxAgents: 4 } } },
    }));

    // Pins land in the untracked pins file…
    const pins = JSON.parse(fs.readFileSync(pinsPath(), 'utf-8'));
    expect(pins).toEqual({ agents: { claude: '2.1.0' }, isolatedAgents: { codex: '0.144.6' } });
    // …never in central, and the tracked device doc is not created for pins.
    const central = fs.readFileSync(centralPath(), 'utf-8');
    expect(central).not.toContain('claude: 2.1.0');
    expect(central).toContain('maxAgents: 4');
    expect(fs.existsSync(devicePath())).toBe(false);

    // Both read back through the overlay.
    expect(readMeta().agents?.claude).toBe('2.1.0');
    expect(readMeta().isolatedAgents?.codex).toBe('0.144.6');
    expect(readMeta().fleet?.defaults?.config).toEqual({ maxAgents: 4 });
  });

  it('writeMeta preserves a config: block device-config wrote into the tracked doc', async () => {
    const { updateMeta, readMeta } = await freshState();

    // device-config.ts owns config: in the doc; write it directly (its writer).
    fs.mkdirSync(path.dirname(devicePath()), { recursive: true });
    fs.writeFileSync(devicePath(), 'config:\n  maxAgents: 4\n');

    updateMeta((m) => ({ ...m, deviceRoutines: ['watchdog'] }));

    const doc = fs.readFileSync(devicePath(), 'utf-8');
    expect(doc).toContain('maxAgents: 4'); // config survived the meta write
    expect(doc).toContain('- watchdog');
    expect(readMeta().deviceRoutines).toEqual(['watchdog']);
  });

  it('clears pins cleanly (no stale pins file resurrecting them)', async () => {
    const { updateMeta, readMeta } = await freshState();

    updateMeta((m) => ({ ...m, agents: { claude: '2.1.0' } }));
    expect(readMeta().agents?.claude).toBe('2.1.0');

    updateMeta((m) => {
      const { agents, ...rest } = m;
      void agents;
      return rest;
    });
    expect(readMeta().agents?.claude).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(pinsPath(), 'utf-8'))).toEqual({});
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
