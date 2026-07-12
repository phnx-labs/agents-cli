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
