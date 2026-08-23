import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testHome = '';

async function fresh() {
  vi.resetModules();
  const sentinel = await import('./interactive-host.js');
  const config = await import('../device-config.js');
  return { ...sentinel, ...config };
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-interactive-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('isDeviceInteractive', () => {
  it('matches the sentinel regardless of case and surrounding space', async () => {
    const { isDeviceInteractive } = await fresh();
    for (const v of ['interactive', 'INTERACTIVE', '  Interactive  ']) {
      expect(isDeviceInteractive(v), v).toBe(true);
    }
  });

  it('does not match anything else', async () => {
    const { isDeviceInteractive } = await fresh();
    // `auto` in particular must stay a distinct sentinel: it means "pick by
    // load", this means one specific pinned box.
    for (const v of ['auto', 'zion', 'interactive-host', 'inter', '', undefined, null]) {
      expect(isDeviceInteractive(v as string | undefined | null), String(v)).toBe(false);
    }
  });
});

describe('resolveInteractiveDevice', () => {
  it('returns null when no host is pinned', async () => {
    // Callers must refuse on null. Falling back to the local machine would run
    // the command on a headless worker with nobody watching — the exact failure
    // the sentinel exists to prevent, and it would fail invisibly.
    const { resolveInteractiveDevice } = await fresh();
    expect(resolveInteractiveDevice()).toBeNull();
  });

  it('returns the pinned host', async () => {
    const { setConfigValue, resolveInteractiveDevice } = await fresh();
    setConfigValue('interactive.host', 'zion');

    const { resolveInteractiveDevice: read } = await fresh();
    expect(read()).toBe('zion');
  });

  it('cannot be pinned to a blank host — the config layer rejects it first', async () => {
    // Worth pinning down where the guard lives: `interactive.host` validates the
    // device name at write time, so a blank pin never reaches this module. The
    // trim in resolveInteractiveDevice is therefore defensive, not the guard.
    const { setConfigValue } = await fresh();
    expect(() => setConfigValue('interactive.host', '   ')).toThrow(/Invalid device name/);

    const { resolveInteractiveDevice } = await fresh();
    expect(resolveInteractiveDevice()).toBeNull();
  });
});

describe('interactiveUnsetError', () => {
  it('names the command that fixes it', async () => {
    const { interactiveUnsetError } = await fresh();
    expect(interactiveUnsetError()).toContain('agents config set interactive.host');
  });
});
