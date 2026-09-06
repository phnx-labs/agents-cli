/**
 * The switches that gate the automatic-update pass (PHNX-3940). Real
 * filesystem — HOME redirected to a temp dir so `state.ts`/`device-config.ts`
 * resolve `agents.yaml` there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;

async function load() {
  vi.resetModules();
  const store = await import('./store.js');
  const policy = await import('./update-policy.js');
  return { store, policy };
}

function makeVersionDir(agent: string, label: string): void {
  fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', agent, label, 'home'), { recursive: true });
}

describe('update-policy', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-policy-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('effectiveUpdatePolicy', () => {
    it('legacy/absent updatePolicy defaults to latest', async () => {
      const { policy } = await load();
      expect(policy.effectiveUpdatePolicy({ updatePolicy: undefined })).toBe('latest');
      expect(policy.effectiveUpdatePolicy({})).toBe('latest');
    });

    it('reflects an explicitly pinned installation', async () => {
      const { store, policy } = await load();
      makeVersionDir('claude', '2.0.65');
      const installation = store.createInstallation('claude', '2.0.65', '2.0.65');
      expect(policy.effectiveUpdatePolicy(installation)).toBe('latest');

      const pinned = await policy.setInstallationUpdatePolicy('claude', '2.0.65', 'pinned');
      expect(policy.effectiveUpdatePolicy(pinned)).toBe('pinned');
      // Reload from disk — the write must have persisted, not just returned an in-memory copy.
      expect(policy.effectiveUpdatePolicy(store.readInstallation('claude', '2.0.65')!)).toBe('pinned');

      const unpinned = await policy.setInstallationUpdatePolicy('claude', '2.0.65', 'latest');
      expect(policy.effectiveUpdatePolicy(unpinned)).toBe('latest');
    });

    it('never touches history or releaseVersion when pinning/unpinning', async () => {
      const { store, policy } = await load();
      makeVersionDir('claude', '2.0.65');
      const installation = store.createInstallation('claude', '2.0.65', '2.0.65');
      const pinned = await policy.setInstallationUpdatePolicy('claude', '2.0.65', 'pinned');
      expect(pinned.releaseVersion).toBe('2.0.65');
      expect(pinned.history).toEqual(installation.history);
    });

    it('throws a clear error for a label with no installation directory at all', async () => {
      const { policy } = await load();
      await expect(policy.setInstallationUpdatePolicy('claude', 'does-not-exist', 'pinned')).rejects.toThrow();
    });
  });

  describe('global and per-harness auto-update switches', () => {
    it('defaults both on', async () => {
      const { policy } = await load();
      expect(policy.isGlobalAutoUpdateEnabled()).toBe(true);
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(true);
      expect(policy.rawGlobalAutoUpdateSetting()).toBeUndefined();
      expect(policy.rawAgentAutoUpdateSetting('claude')).toBeUndefined();
    });

    it('persists an explicit false for the global switch and reads it back after reload', async () => {
      const { policy: policyA } = await load();
      policyA.setGlobalAutoUpdateEnabled(false);
      expect(policyA.isGlobalAutoUpdateEnabled()).toBe(false);

      const { policy: policyB } = await load(); // fresh module graph — forces a real disk re-read
      expect(policyB.rawGlobalAutoUpdateSetting()).toBe(false);
      expect(policyB.isGlobalAutoUpdateEnabled()).toBe(false);
    });

    it('persists an explicit false for one harness and reads it back after reload', async () => {
      const { policy: policyA } = await load();
      policyA.setAgentAutoUpdateEnabled('codex', false);
      expect(policyA.isAutoUpdateEnabledForAgent('codex')).toBe(false);
      expect(policyA.isAutoUpdateEnabledForAgent('claude')).toBe(true); // unaffected

      const { policy: policyB } = await load();
      expect(policyB.rawAgentAutoUpdateSetting('codex')).toBe(false);
      expect(policyB.isAutoUpdateEnabledForAgent('codex')).toBe(false);
    });

    it('the global switch is a HARD kill switch — off wins even over an explicit per-harness true', async () => {
      const { policy } = await load();
      policy.setAgentAutoUpdateEnabled('claude', true);
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(true);

      policy.setGlobalAutoUpdateEnabled(false);
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(false);
    });

    it('unset restores the default for both switches', async () => {
      const { policy } = await load();
      policy.setGlobalAutoUpdateEnabled(false);
      policy.setAgentAutoUpdateEnabled('claude', false);
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(false);

      policy.unsetGlobalAutoUpdateEnabled();
      expect(policy.rawGlobalAutoUpdateSetting()).toBeUndefined();
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(false); // per-agent false still applies

      policy.unsetAgentAutoUpdateEnabled('claude');
      expect(policy.rawAgentAutoUpdateSetting('claude')).toBeUndefined();
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(true);
    });
  });
});
