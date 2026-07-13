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

describe('JobScheduler device pinning', () => {
  it('loads unpinned jobs and jobs pinned to this device; skips foreign pins', () => {
    writeJob(makeJob({ name: 'unpinned' }));
    writeJob(makeJob({ name: 'pinned-here', device: 'zion' }));
    writeJob(makeJob({ name: 'pinned-elsewhere', device: 'yosemite-s0' }));

    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    const names = scheduler.listScheduled().map((j) => j.name).sort();
    scheduler.stopAll();

    expect(names).toEqual(['pinned-here', 'unpinned']);
  });

  it('matches a pin case-insensitively and ignores a domain suffix', () => {
    writeJob(makeJob({ name: 'fqdn-pin', device: 'Zion.tailnet.ts.net' }));

    const scheduler = new JobScheduler(async () => {});
    scheduler.loadAll();
    const names = scheduler.listScheduled().map((j) => j.name);
    scheduler.stopAll();

    expect(names).toEqual(['fqdn-pin']);
  });
});

describe('detectOverdueJobs device pinning', () => {
  it('never flags a job pinned to another device as overdue here', () => {
    // Daily schedule with no recorded runs — overdue everywhere it may run.
    writeJob(makeJob({ name: 'foreign-overdue', device: 'yosemite-s0' }));
    writeJob(makeJob({ name: 'local-overdue', device: 'zion' }));
    writeJob(makeJob({ name: 'unpinned-overdue' }));

    const names = detectOverdueJobs().map((j) => j.name).sort();
    expect(names).toEqual(['local-overdue', 'unpinned-overdue']);
  });
});
