import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

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

  it('preserves every concurrent upgrade addition', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    const activation = await load();
    activation.replaceEnabledRoutines(['existing']);
    const names = Array.from({ length: 8 }, (_, index) => `replacement-${index}`);

    await Promise.all(names.map((name) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e',
        `const m = await import('./src/lib/routine-activation.ts'); m.addEnabledRoutinesOnUpgrade([${JSON.stringify(name)}]);`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, AGENTS_SYNC_MACHINE_ID: 'test-host' },
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
    })));

    vi.resetModules();
    const reloaded = await import('./routine-activation.js');
    expect(reloaded.enabledRoutineNames()).toEqual(['existing', ...names].sort());
  }, 30_000);

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

describe('routineDeviceIndex', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-routine-index-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeDevice(name: string, body: string): void {
    const dir = path.join(home, '.agents', 'devices', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.yaml'), body);
  }

  it('is unmaterialized when no device declares a routines list', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    writeDevice('test-host', 'agents: {}\n');
    const { routineDeviceIndex } = await load();

    const index = routineDeviceIndex();
    expect(index.materialized).toBe(false);
    expect(index.byRoutine.size).toBe(0);
    expect(index.errors).toEqual([]);
  });

  it('maps each routine to the sorted devices that enable it', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    writeDevice('zion', 'routines:\n  - watchdog\n  - git-review\n');
    writeDevice('mac-mini', 'routines:\n  - watchdog\n');
    const { routineDeviceIndex } = await load();

    const index = routineDeviceIndex();
    expect(index.materialized).toBe(true);
    expect(index.byRoutine.get('watchdog')).toEqual(['mac-mini', 'zion']);
    expect(index.byRoutine.get('git-review')).toEqual(['zion']);
    expect(index.byRoutine.get('absent')).toBeUndefined();
  });

  it('reports a corrupt device document instead of throwing, and keeps the rest', async () => {
    // devicesWithRoutineEnabled throws here. For a listing that would blank every
    // row over one unreadable peer file, so the index collects and continues.
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    writeDevice('zion', 'routines:\n  - watchdog\n');
    writeDevice('broken', 'routines: not-a-list\n');
    writeDevice('unparseable', 'routines: [\n');
    const { routineDeviceIndex } = await load();

    const index = routineDeviceIndex();
    expect(index.byRoutine.get('watchdog')).toEqual(['zion']);
    expect(index.errors).toHaveLength(2);
    expect(index.errors.join('\n')).toMatch(/broken/);
    expect(index.errors.join('\n')).toMatch(/unparseable/);
  });

  it('normalizes exactly like the writers, so a duplicate cannot double-count', async () => {
    vi.doMock('./machine-id.js', () => ({ machineId: () => 'test-host' }));
    // Written to THIS device so both readers describe the same document.
    writeDevice('test-host', 'routines:\n  - watchdog\n  - watchdog\n  - "  watchdog  "\n');
    const { routineDeviceIndex, enabledRoutineNames } = await load();

    expect(routineDeviceIndex().byRoutine.get('watchdog')).toEqual(['test-host']);
    // The fleet index and this device's own view must not disagree.
    expect(enabledRoutineNames()).toEqual(['watchdog']);
  });
});
