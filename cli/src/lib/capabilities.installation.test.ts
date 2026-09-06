import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('release-aware capability checks', () => {
  let root: string;
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
  it('uses the installed release without changing stable home or settings labels', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-capability-'));
    vi.stubEnv('HOME', root);
    vi.resetModules();
    const { createInstallation, installedReleaseFor } = await import('./installations/store.js');
    const { supports } = await import('./capabilities.js');
    const { commandAppliesTo } = await import('./commands.js');
    createInstallation('codex', 'main', '0.153.4');
    createInstallation('codex', 'old-home', '0.110.0');
    expect(installedReleaseFor('codex', 'main')).toBe('0.153.4');
    expect(installedReleaseFor('codex', '0.116.0')).toBe('0.116.0');
    expect(supports('codex', 'hooks', 'main').ok).toBe(true);
    expect(supports('codex', 'plugins', 'main').ok).toBe(true);
    expect(supports('codex', 'commands', 'main').ok).toBe(false);
    expect(supports('codex', 'hooks', 'old-home').ok).toBe(false);
    expect(commandAppliesTo('codex', 'main', { since: '0.150.0' }).ok).toBe(true);
    expect(commandAppliesTo('codex', 'main', { until: '0.150.0' }).ok).toBe(false);
  });
});
