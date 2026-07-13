import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../state.js';
import { JobScheduler } from '../scheduler.js';
import { writeJob, type JobConfig } from '../routines.js';
import { detectOverdueJobs } from '../overdue.js';

let tmpDir = '';
let userRoutinesDir = '';
let runsDir = '';
const savedMachineId = process.env.AGENTS_SYNC_MACHINE_ID;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-device-test-'));
  userRoutinesDir = path.join(tmpDir, 'routines');
  runsDir = path.join(tmpDir, 'runs');
  fs.mkdirSync(userRoutinesDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });

  vi.spyOn(state, 'getRoutinesDir').mockReturnValue(userRoutinesDir);
  vi.spyOn(state, 'getRunsDir').mockReturnValue(runsDir);
  vi.spyOn(state, 'ensureAgentsDir').mockImplementation(() => {});
  process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
  else process.env.AGENTS_SYNC_MACHINE_ID = savedMachineId;
});

function makeJob(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'device-test',
    schedule: '0 3 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'noop',
    ...overrides,
  };
}

describe('JobScheduler devices allowlist', () => {
  it('loads unpinned jobs and jobs whose allowlist includes this device; skips foreign', () => {
    writeJob(makeJob({ name: 'unpinned' }));
    writeJob(makeJob({ name: 'allowed-here', devices: ['zion'] }));
    writeJob(makeJob({ name: 'allowed-elsewhere', devices: ['yosemite-s0'] }));
    writeJob(makeJob({ name: 'multi-includes-here', devices: ['mac-mini', 'zion'] }));

    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    const names = scheduler.listScheduled().map((j) => j.name).sort();
    scheduler.stopAll();

    expect(names).toEqual(['allowed-here', 'multi-includes-here', 'unpinned']);
  });

  it('matches an allowlist entry case-insensitively and ignores a domain suffix', () => {
    writeJob(makeJob({ name: 'fqdn-entry', devices: ['Zion.tailnet.ts.net'] }));

    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    const names = scheduler.listScheduled().map((j) => j.name);
    scheduler.stopAll();

    expect(names).toEqual(['fqdn-entry']);
  });
});

describe('detectOverdueJobs devices allowlist', () => {
  it('never flags a job restricted to another device as overdue here', () => {
    writeJob(makeJob({ name: 'foreign-overdue', devices: ['yosemite-s0'] }));
    writeJob(makeJob({ name: 'local-overdue', devices: ['zion'] }));
    writeJob(makeJob({ name: 'unpinned-overdue' }));

    const names = detectOverdueJobs().map((j) => j.name).sort();
    expect(names).toEqual(['local-overdue', 'unpinned-overdue']);
  });
});
