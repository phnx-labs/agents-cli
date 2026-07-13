import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { executeJob, executeJobDetached } from './runner.js';
import { getRunDir } from './routines.js';
import type { JobConfig } from './routines.js';

function baseConfig(partial: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 3 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'do it',
    ...partial,
  } as JobConfig;
}

describe('runner device enforcement', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
  });

  it('executeJob throws when this machine is not in the devices allowlist', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ devices: ['yosemite-s0', 'mac-mini'] });
    await expect(executeJob(config)).rejects.toThrow(/can only run on/);
  });

  it('executeJobDetached throws when this machine is not in the devices allowlist', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ name: 'guard-reject', devices: ['yosemite-s0'] });
    await expect(executeJobDetached(config)).rejects.toThrow(/can only run on/);

    const runDir = path.dirname(getRunDir(config.name, 'any'));
    expect(fs.existsSync(runDir)).toBe(false);
  });
});
