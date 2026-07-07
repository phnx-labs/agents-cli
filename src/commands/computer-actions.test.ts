import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pickTarget,
  parseXY,
  buildElementOrCoords,
  buildRaiseParams,
  buildWaitParams,
  clampCharDelay,
  focusStealNotes,
  shouldRaise,
  appPathIsElectron,
  electronWebviewTip,
  resolveTargetPidDecision,
  CHAR_DELAY_MIN_MS,
  CHAR_DELAY_MAX_MS,
  type AppInfo,
} from './computer-actions.js';
import { resolveRpcTimeoutMs, RPC_TIMEOUT_MS, type ComputerClient, type RPCResponse } from '../lib/computer-rpc.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-computer-actions-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const apps: AppInfo[] = [
  { pid: 100, name: 'Finder', bundle_id: 'com.apple.finder', active: false },
  { pid: 200, name: 'Photoshop', bundle_id: 'com.adobe.Photoshop', active: true },
  { pid: 300, name: 'Notes', bundle_id: 'com.apple.notes', active: false },
];

describe('pickTarget', () => {
  it('prefers an explicit pid, returning the matching app', () => {
    const r = pickTarget(apps, { pid: 300 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.bundle_id).toBe('com.apple.notes');
  });

  it('passes through a pid the daemon does not list (daemon is the authority)', () => {
    const r = pickTarget(apps, { pid: 999 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.app.pid).toBe(999);
      expect(r.app.bundle_id).toBe('');
    }
  });

  it('pid wins over bundle when both are given', () => {
    const r = pickTarget(apps, { pid: 100, bundle: 'com.adobe.Photoshop' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.pid).toBe(100);
  });

  it('resolves a bundle id to its running pid', () => {
    const r = pickTarget(apps, { bundle: 'com.adobe.Photoshop' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.pid).toBe(200);
  });

  it('errors when the bundle is not running / not allow-listed', () => {
    const r = pickTarget(apps, { bundle: 'com.unknown.app' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('com.unknown.app');
  });

  it('falls back to the frontmost active app when neither pid nor bundle is given', () => {
    const r = pickTarget(apps, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app.pid).toBe(200);
  });

  it('errors when nothing is active and no target is specified', () => {
    const noneActive = apps.map((a) => ({ ...a, active: false }));
    const r = pickTarget(noneActive, {});
    expect(r.ok).toBe(false);
  });
});

describe('resolveTargetPidDecision session admissions', () => {
  it('keeps an admitted input target stable for repeated type-text calls in the same session', async () => {
    const cachePath = path.join(makeTempDir(), 'admissions.json');
    let calls = 0;
    const client: ComputerClient = {
      async call(method: string): Promise<RPCResponse> {
        expect(method).toBe('list_apps');
        calls += 1;
        return {
          id: calls,
          result: {
            apps: calls === 1
              ? [{ pid: 4242, name: 'Notepad', bundle_id: 'Microsoft.WindowsNotepad', active: true }]
              : [],
          },
        };
      },
      async close(): Promise<void> {},
    };
    const env = {
      CODEX_THREAD_ID: 'session-557',
      AGENTS_COMPUTER_ADMISSION_CACHE: cachePath,
    } as NodeJS.ProcessEnv;

    await expect(resolveTargetPidDecision(client, {}, { verb: 'type-text', env, nowMs: 10 }))
      .resolves.toEqual({ ok: true, pid: 4242, source: 'list_apps' });
    await expect(resolveTargetPidDecision(client, {}, { verb: 'type-text', env, nowMs: 11 }))
      .resolves.toEqual({ ok: true, pid: 4242, source: 'session_admission' });
  });

  it('shares the admitted target across input verbs in the same session', async () => {
    const cachePath = path.join(makeTempDir(), 'admissions.json');
    let calls = 0;
    const client: ComputerClient = {
      async call(method: string): Promise<RPCResponse> {
        expect(method).toBe('list_apps');
        calls += 1;
        return {
          id: calls,
          result: {
            apps: calls === 1
              ? [{ pid: 5150, name: 'Notepad', bundle_id: 'Microsoft.WindowsNotepad', active: true }]
              : [],
          },
        };
      },
      async close(): Promise<void> {},
    };
    const env = {
      CODEX_THREAD_ID: 'session-557-cross-verb',
      AGENTS_COMPUTER_ADMISSION_CACHE: cachePath,
    } as NodeJS.ProcessEnv;

    await expect(resolveTargetPidDecision(client, {}, { verb: 'type-text', env, nowMs: 20 }))
      .resolves.toEqual({ ok: true, pid: 5150, source: 'list_apps' });
    await expect(resolveTargetPidDecision(client, {}, { verb: 'key', env, nowMs: 21 }))
      .resolves.toEqual({ ok: true, pid: 5150, source: 'session_admission' });
  });

  it('keeps an admitted explicit bundle stable for repeated input calls', async () => {
    const cachePath = path.join(makeTempDir(), 'admissions.json');
    let calls = 0;
    const client: ComputerClient = {
      async call(method: string): Promise<RPCResponse> {
        expect(method).toBe('list_apps');
        calls += 1;
        return {
          id: calls,
          result: {
            apps: calls === 1
              ? [{ pid: 7070, name: 'Notepad', bundle_id: 'Microsoft.WindowsNotepad', active: true }]
              : [],
          },
        };
      },
      async close(): Promise<void> {},
    };
    const env = {
      CODEX_THREAD_ID: 'session-557-bundle',
      AGENTS_COMPUTER_ADMISSION_CACHE: cachePath,
    } as NodeJS.ProcessEnv;

    await expect(resolveTargetPidDecision(client, { bundle: 'Microsoft.WindowsNotepad' }, { verb: 'type-text', env, nowMs: 25 }))
      .resolves.toEqual({ ok: true, pid: 7070, source: 'list_apps' });
    await expect(resolveTargetPidDecision(client, { bundle: 'Microsoft.WindowsNotepad' }, { verb: 'key', env, nowMs: 26 }))
      .resolves.toEqual({ ok: true, pid: 7070, source: 'session_admission' });
  });

  it('does not reuse an input admission outside the session that admitted it', async () => {
    const cachePath = path.join(makeTempDir(), 'admissions.json');
    let calls = 0;
    const client: ComputerClient = {
      async call(method: string): Promise<RPCResponse> {
        calls += 1;
        return {
          id: calls,
          result: {
            apps: calls === 1
              ? [{ pid: 6001, name: 'Notepad', bundle_id: 'Microsoft.WindowsNotepad', active: true }]
              : [],
          },
        };
      },
      async close(): Promise<void> {},
    };

    await expect(resolveTargetPidDecision(client, {}, {
      verb: 'type-text',
      env: { CODEX_THREAD_ID: 'session-a', AGENTS_COMPUTER_ADMISSION_CACHE: cachePath } as NodeJS.ProcessEnv,
      nowMs: 30,
    })).resolves.toEqual({ ok: true, pid: 6001, source: 'list_apps' });

    const denied = await resolveTargetPidDecision(client, {}, {
      verb: 'type-text',
      env: { CODEX_THREAD_ID: 'session-b', AGENTS_COMPUTER_ADMISSION_CACHE: cachePath } as NodeJS.ProcessEnv,
      nowMs: 31,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('no active app found in allow list');
  });
});

describe('parseXY', () => {
  it('parses a valid coordinate pair', () => {
    expect(parseXY('18,136', '--from')).toEqual({ x: 18, y: 136 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseXY(' 18 , 136 ', '--to')).toEqual({ x: 18, y: 136 });
  });

  it('parses negative coordinates', () => {
    expect(parseXY('-5,-10', '--from')).toEqual({ x: -5, y: -10 });
  });

  it('throws on the wrong number of parts', () => {
    expect(() => parseXY('18', '--from')).toThrow('--from');
    expect(() => parseXY('1,2,3', '--from')).toThrow('--from');
  });

  it('throws on non-numeric parts', () => {
    expect(() => parseXY('a,b', '--to')).toThrow('--to');
  });
});

describe('buildElementOrCoords', () => {
  it('builds an element_id spec from --id', () => {
    const r = buildElementOrCoords({ id: '@e7' });
    expect(r).toEqual({ ok: true, params: { element_id: '@e7' } });
  });

  it('builds an x/y spec from coordinates', () => {
    const r = buildElementOrCoords({ x: 18, y: 136 });
    expect(r).toEqual({ ok: true, params: { x: 18, y: 136 } });
  });

  it('prefers --id over coordinates when both are present', () => {
    const r = buildElementOrCoords({ id: '@e7', x: 1, y: 2 });
    expect(r).toEqual({ ok: true, params: { element_id: '@e7' } });
  });

  it('errors when neither target is provided', () => {
    const r = buildElementOrCoords({});
    expect(r.ok).toBe(false);
  });

  it('errors when only one coordinate is provided', () => {
    const r = buildElementOrCoords({ x: 18 });
    expect(r.ok).toBe(false);
  });
});

describe('buildRaiseParams', () => {
  it('returns empty params for an app-level raise', () => {
    expect(buildRaiseParams({})).toEqual({});
  });

  it('builds a window_id param', () => {
    expect(buildRaiseParams({ windowId: 127403 })).toEqual({ window_id: 127403 });
  });

  it('builds a title param', () => {
    expect(buildRaiseParams({ title: 'Windows 11' })).toEqual({ title: 'Windows 11' });
  });

  it('passes both refinements through when given', () => {
    expect(buildRaiseParams({ windowId: 5, title: 'VM' })).toEqual({ window_id: 5, title: 'VM' });
  });
});

describe('buildWaitParams', () => {
  it('duration wins over every other mode', () => {
    const r = buildWaitParams({ duration: 500, id: '@e1', role: 'AXButton' });
    expect(r).toEqual({ ok: true, params: { duration_ms: 500 } });
  });

  it('builds an element poll from --id', () => {
    const r = buildWaitParams({ id: '@e3', until: 'enabled', timeout: 2000 });
    expect(r).toEqual({ ok: true, params: { until: 'enabled', timeout_ms: 2000, element_id: '@e3' } });
  });

  it('element id wins over a locator', () => {
    const r = buildWaitParams({ id: '@e3', role: 'AXButton' });
    expect(r).toEqual({ ok: true, params: { element_id: '@e3' } });
  });

  it('builds a locator from role/label/identifier', () => {
    const r = buildWaitParams({ role: 'AXButton', label: 'Save' });
    expect(r).toEqual({ ok: true, params: { locator: { role: 'AXButton', label: 'Save' } } });
  });

  it('errors when no mode is selected', () => {
    const r = buildWaitParams({});
    expect(r.ok).toBe(false);
  });

  it('errors when only --until/--timeout are given (no target)', () => {
    const r = buildWaitParams({ until: 'exists', timeout: 1000 });
    expect(r.ok).toBe(false);
  });
});

describe('clampCharDelay', () => {
  it('returns undefined when unset so the daemon applies its 4ms default', () => {
    expect(clampCharDelay(undefined)).toBeUndefined();
  });

  it('passes a typical VM-guest value through unchanged', () => {
    expect(clampCharDelay(25)).toBe(25);
  });

  it('clamps below the floor up to the minimum', () => {
    expect(clampCharDelay(0)).toBe(CHAR_DELAY_MIN_MS);
    expect(clampCharDelay(-100)).toBe(CHAR_DELAY_MIN_MS);
  });

  it('clamps above the ceiling down to the maximum', () => {
    expect(clampCharDelay(1000)).toBe(CHAR_DELAY_MAX_MS);
  });

  it('keeps the boundary values', () => {
    expect(clampCharDelay(CHAR_DELAY_MIN_MS)).toBe(1);
    expect(clampCharDelay(CHAR_DELAY_MAX_MS)).toBe(250);
  });

  it('truncates fractional input and rejects NaN', () => {
    expect(clampCharDelay(25.9)).toBe(25);
    expect(clampCharDelay(NaN)).toBeUndefined();
  });
});

describe('focusStealNotes', () => {
  it('is silent for focus-safe element mode without --raise', () => {
    expect(focusStealNotes({ id: '@e7' })).toEqual([]);
  });

  it('element mode ignores --raise and says so (never steals the user\'s foreground)', () => {
    const notes = focusStealNotes({ id: '@e7', raise: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('ignored in element mode');
  });

  it('warns about the cursor in coordinate mode', () => {
    const notes = focusStealNotes({ x: 10, y: 20 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('moves your real cursor');
  });

  it('coordinate mode with --raise warns about both foreground and cursor', () => {
    const notes = focusStealNotes({ x: 10, y: 20, raise: true });
    expect(notes).toHaveLength(2);
    expect(notes.join(' ')).toContain('takes keyboard focus');
    expect(notes.join(' ')).toContain('moves your real cursor');
  });

  it('a target-only verb (key/type-text) with --raise warns about foreground only', () => {
    expect(focusStealNotes({ raise: true })).toEqual([expect.stringContaining('takes keyboard focus')]);
  });

  it('is silent when no target and no --raise are given', () => {
    expect(focusStealNotes({})).toEqual([]);
  });
});

describe('shouldRaise', () => {
  it('honors --raise only outside element mode, so an element action never takes foreground', () => {
    expect(shouldRaise({ raise: true })).toBe(true);
    expect(shouldRaise({ raise: true, id: '@e1' })).toBe(false);
    expect(shouldRaise({ id: '@e1' })).toBe(false);
    expect(shouldRaise({})).toBe(false);
  });
});

describe('appPathIsElectron', () => {
  const framework = 'Contents/Frameworks/Electron Framework.framework';
  it('is true when the .app bundles the Electron framework', () => {
    const exists = (p: string) => p === `/Applications/VSCodium.app/${framework}`;
    expect(appPathIsElectron('/Applications/VSCodium.app', exists)).toBe(true);
  });

  it('is false for a native .app with no Electron framework', () => {
    expect(appPathIsElectron('/System/Applications/Utilities/Terminal.app', () => false)).toBe(false);
  });

  it('is false when the app path could not be resolved', () => {
    expect(appPathIsElectron(null, () => true)).toBe(false);
  });
});

describe('electronWebviewTip', () => {
  it('names the app and steers to CDP with the relaunch flag', () => {
    const tip = electronWebviewTip('com.vscodium');
    expect(tip).toContain('com.vscodium');
    expect(tip).toContain('Electron');
    expect(tip).toContain('--remote-debugging-port');
    expect(tip).toContain('agents browser --electron');
  });
});

describe('resolveRpcTimeoutMs', () => {
  it('defaults to RPC_TIMEOUT_MS when the env var is unset', () => {
    expect(resolveRpcTimeoutMs(undefined)).toBe(RPC_TIMEOUT_MS);
  });

  it('parses a positive override', () => {
    expect(resolveRpcTimeoutMs('5000')).toBe(5000);
  });

  it('rejects garbage and non-positive values', () => {
    expect(resolveRpcTimeoutMs('abc')).toBe(RPC_TIMEOUT_MS);
    expect(resolveRpcTimeoutMs('0')).toBe(RPC_TIMEOUT_MS);
    expect(resolveRpcTimeoutMs('-1')).toBe(RPC_TIMEOUT_MS);
  });
});
