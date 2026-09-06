/**
 * The automatic-update PLAN (PHNX-3940): eligibility, deferral, and the
 * once-per-agent target resolution. Real filesystem (HOME redirected to a
 * temp dir), real installation records, real launch-lease files, real OS
 * process-table scan (`realProcessSnapshot`, untouched). The ONE network
 * boundary (`getLatestNpmVersion`, which would otherwise hit
 * registry.npmjs.org) is stubbed via `vi.mock` with `importOriginal` so every
 * other export of `versions.js` stays real — this proves absence/count of
 * network calls, it does not fake a successful vendor response to make an
 * update appear to succeed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const getLatestNpmVersion = vi.fn<(agent: string) => Promise<string | null>>();

vi.mock('./versions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./versions.js')>();
  return { ...actual, getLatestNpmVersion: (agent: string) => getLatestNpmVersion(agent) };
});

let home: string;

async function load() {
  vi.resetModules();
  getLatestNpmVersion.mockReset();
  const store = await import('./store.js');
  const policy = await import('./update-policy.js');
  const shims = await import('./shims.js');
  const runtime = await import('./update-runtime.js');
  return { store, policy, shims, runtime };
}

function makeVersionDir(agent: string, label: string): void {
  fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', agent, label, 'home'), { recursive: true });
}

describe('planAutoUpdates', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-runtime-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a harness with automatic updates disabled never resolves a target (no registry call)', async () => {
    const { store, policy, runtime } = await load();
    makeVersionDir('claude', '2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    policy.setAgentAutoUpdateEnabled('claude', false);

    const plan = await runtime.planAutoUpdates({ agents: ['claude'] });

    expect(getLatestNpmVersion).not.toHaveBeenCalled();
    expect(plan).toHaveLength(1);
    expect(plan[0].eligible).toBe(false);
    expect(plan[0].targetRelease).toBeNull();
    expect(plan[0].reason).toMatch(/disabled/);
  });

  it('the global kill switch also short-circuits before any registry call', async () => {
    const { store, policy, runtime } = await load();
    makeVersionDir('claude', '2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    policy.setGlobalAutoUpdateEnabled(false);

    const plan = await runtime.planAutoUpdates({ agents: ['claude'] });

    expect(getLatestNpmVersion).not.toHaveBeenCalled();
    expect(plan[0].eligible).toBe(false);
  });

  it('resolves the latest release exactly ONCE per agent, reused across every installation', async () => {
    const { store, runtime } = await load();
    getLatestNpmVersion.mockResolvedValue('9.9.9');
    makeVersionDir('claude', 'a');
    makeVersionDir('claude', 'b');
    makeVersionDir('claude', 'c');
    store.createInstallation('claude', 'a', '2.0.60');
    store.createInstallation('claude', 'b', '2.0.61');
    store.createInstallation('claude', 'c', '2.0.62');

    const plan = await runtime.planAutoUpdates({ agents: ['claude'] });

    expect(getLatestNpmVersion).toHaveBeenCalledTimes(1);
    expect(plan).toHaveLength(3);
    for (const entry of plan) {
      expect(entry.targetRelease).toBe('9.9.9');
      expect(entry.eligible).toBe(true);
      expect(entry.deferred).toBe(false);
    }
  });

  it('a registry failure is surfaced per installation, not thrown — the plan still returns', async () => {
    const { store, runtime } = await load();
    getLatestNpmVersion.mockRejectedValue(new Error('registry.npmjs.org unreachable'));
    makeVersionDir('claude', '2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');

    const plan = await runtime.planAutoUpdates({ agents: ['claude'] });

    expect(plan).toHaveLength(1);
    expect(plan[0].eligible).toBe(false);
    expect(plan[0].targetRelease).toBeNull();
    expect(plan[0].reason).toMatch(/registry\.npmjs\.org unreachable/);
  });

  it('a pinned installation is not eligible even when its sibling is', async () => {
    const { store, policy, runtime } = await load();
    getLatestNpmVersion.mockResolvedValue('9.9.9');
    makeVersionDir('claude', 'pinned');
    makeVersionDir('claude', 'floating');
    store.createInstallation('claude', 'pinned', '2.0.60');
    store.createInstallation('claude', 'floating', '2.0.60');
    await policy.setInstallationUpdatePolicy('claude', 'pinned', 'pinned');

    const plan = await runtime.planAutoUpdates({ agents: ['claude'] });
    const byLabel = Object.fromEntries(plan.map((e) => [e.installation.label, e]));

    expect(byLabel.pinned.eligible).toBe(false);
    expect(byLabel.pinned.policy).toBe('pinned');
    expect(byLabel.floating.eligible).toBe(true);
    expect(byLabel.floating.policy).toBe('latest');
  });

  it('a live launch lease defers an otherwise-eligible installation', async () => {
    const { store, shims, runtime } = await load();
    getLatestNpmVersion.mockResolvedValue('9.9.9');
    makeVersionDir('claude', '2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    shims.recordLaunchLease('claude', '2.0.65', process.pid); // guaranteed-alive pid

    const plan = await runtime.planAutoUpdates({ agents: ['claude'] });

    expect(plan[0].eligible).toBe(true); // policy/switches allow it
    expect(plan[0].deferred).toBe(true); // but a launch is in flight
    expect(plan[0].reason).toMatch(/launch is in flight/);
  });

  it('a stale (dead-pid) lease does not defer', async () => {
    const { store, shims, runtime } = await load();
    getLatestNpmVersion.mockResolvedValue('9.9.9');
    makeVersionDir('claude', '2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    shims.recordLaunchLease('claude', '2.0.65', 999_999); // essentially guaranteed dead

    const plan = await runtime.planAutoUpdates({ agents: ['claude'] });

    expect(plan[0].deferred).toBe(false);
  });

  it('a legacy pre-frozen version dir (no installation.json yet) is migrated to policy latest', async () => {
    const { store, runtime } = await load();
    getLatestNpmVersion.mockResolvedValue('9.9.9');
    makeVersionDir('claude', '2.0.65');
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'claude', '2.0.65', 'installation.json'))).toBe(false);

    const plan = await runtime.planAutoUpdates({ agents: ['claude'] });

    expect(plan).toHaveLength(1);
    expect(plan[0].policy).toBe('latest');
    expect(plan[0].eligible).toBe(true);
    // The migration is a real, observable side effect — same as `agents view` triggering it elsewhere.
    expect(store.readInstallation('claude', '2.0.65')).not.toBeNull();
  });

  it('a manual/vendor-managed harness (no isolated reversible swap) is reported honestly, never silently skipped', async () => {
    const { store, runtime } = await load();
    makeVersionDir('droid', 'default');
    store.createInstallation('droid', 'default', '1.0.0');

    const plan = await runtime.planAutoUpdates({ agents: ['droid'] });

    expect(getLatestNpmVersion).not.toHaveBeenCalled();
    expect(plan).toHaveLength(1);
    expect(plan[0].eligible).toBe(false);
    expect(plan[0].reason).toMatch(/manual\/vendor-managed/);
  });
});
