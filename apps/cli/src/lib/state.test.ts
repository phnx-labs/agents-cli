import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
