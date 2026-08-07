import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;

async function load() {
  vi.resetModules();
  return import('./routine-activation.js');
}

describe('device routine activation', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-routine-activation-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('stores sorted membership only in this device document', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    const activation = await load();

    expect(activation.enabledRoutineNames()).toBeNull();
    activation.replaceEnabledRoutines(['watchdog', 'check-updates', 'watchdog']);

    const central = path.join(home, '.agents', 'agents.yaml');
    const device = path.join(home, '.agents', 'devices', 'test-host', 'agents.yaml');
    expect(fs.readFileSync(device, 'utf-8')).toContain('routines:\n  - check-updates\n  - watchdog');
    expect(fs.readFileSync(central, 'utf-8')).not.toContain('routines:');
    expect(activation.enabledRoutineNames()).toEqual(['check-updates', 'watchdog']);
  });

  it('seeds legacy names once and changes only the requested membership', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    const activation = await load();

    activation.setRoutineEnabledOnThisDevice('watchdog', true, ['check-updates']);
    activation.setRoutineEnabledOnThisDevice('watchdog', false, ['ignored-after-materialize']);

    expect(activation.enabledRoutineNames()).toEqual(['check-updates']);
  });

  it('adds replacement routines to a materialized manifest exactly once', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    const activation = await load();
    activation.replaceEnabledRoutines(['existing']);

    expect(activation.addEnabledRoutinesOnUpgrade(['watchdog', 'device-probe'])).toBe(true);
    expect(activation.enabledRoutineNames()).toEqual(['device-probe', 'existing', 'watchdog']);
    expect(activation.addEnabledRoutinesOnUpgrade(['watchdog', 'device-probe'])).toBe(false);
  });

  it('leaves an unmaterialized manifest definition-driven', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    const activation = await load();

    expect(activation.addEnabledRoutinesOnUpgrade(['watchdog'])).toBe(false);
    expect(activation.enabledRoutineNames()).toBeNull();
  });

  it('reads peer activation without writing peer documents', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'self' }));
    const activation = await load();
    const peerDir = path.join(home, '.agents', 'devices', 'peer');
    fs.mkdirSync(peerDir, { recursive: true });
    const peerFile = path.join(peerDir, 'agents.yaml');
    fs.writeFileSync(peerFile, 'routines:\n  - watchdog\n');
    const before = fs.readFileSync(peerFile, 'utf-8');

    expect(activation.devicesWithRoutineEnabled('watchdog')).toEqual(['peer']);
    expect(fs.readFileSync(peerFile, 'utf-8')).toBe(before);
  });
});
