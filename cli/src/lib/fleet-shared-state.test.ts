import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FLEET_SHARED_STATE_FILE,
  readFleetSharedDeviceStates,
  updateFleetSharedDeviceState,
} from './fleet-shared-state.js';

const dirs: string[] = [];
function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fleet-state-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fleet shared daemon state (real files)', () => {
  it('merges independent usage and auth writers without losing either field', () => {
    const root = tempStore();
    const usage = {
      rows: {
        'claude:org=alpha': {
          capturedAt: '2026-08-30T20:00:00.000Z',
          windows: [{ key: 'five_hour' as const, label: 'Session', shortLabel: 'S', usedPercent: 42, resetsAt: null, windowMinutes: 300 }],
        },
      },
    };

    expect(updateFleetSharedDeviceState('zion', { usage }, root).changed).toBe(true);
    expect(updateFleetSharedDeviceState('zion', { auth: { status: 'ready' } }, root).changed).toBe(true);

    const read = readFleetSharedDeviceStates(root);
    expect(read.errors).toEqual([]);
    expect(read.states).toEqual([{ version: 1, device: 'zion', usage, auth: { status: 'ready' } }]);
  });

  it('does not rewrite an unchanged state and isolates a malformed peer', () => {
    const root = tempStore();
    updateFleetSharedDeviceState('worker-a', { auth: { status: 'missing' } }, root);
    const file = path.join(root, 'devices', 'worker-a', FLEET_SHARED_STATE_FILE);
    const before = fs.statSync(file).mtimeMs;
    expect(updateFleetSharedDeviceState('worker-a', { auth: { status: 'missing' } }, root).changed).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(before);

    const malformedDir = path.join(root, 'devices', 'worker-b');
    fs.mkdirSync(malformedDir, { recursive: true });
    fs.writeFileSync(path.join(malformedDir, FLEET_SHARED_STATE_FILE), '{broken', 'utf-8');
    const read = readFleetSharedDeviceStates(root);
    expect(read.states.map((state) => state.device)).toEqual(['worker-a']);
    expect(read.errors).toEqual([{ device: 'worker-b', message: expect.stringContaining('JSON') }]);
  });

  it('rejects a file copied into another device owner directory', () => {
    const root = tempStore();
    const dir = path.join(root, 'devices', 'worker-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, FLEET_SHARED_STATE_FILE),
      JSON.stringify({ version: 1, device: 'worker-a', auth: { status: 'ready' } }),
      'utf-8',
    );
    expect(readFleetSharedDeviceStates(root)).toMatchObject({
      states: [],
      errors: [{ device: 'worker-b', message: 'unrecognized shared-state envelope' }],
    });
  });
});
