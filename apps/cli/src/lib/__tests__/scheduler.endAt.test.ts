import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../state.js';
import { JobScheduler } from '../scheduler.js';
import { writeJob, readJob, type JobConfig } from '../routines.js';

let tmpDir = '';
let userRoutinesDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-endat-test-'));
  userRoutinesDir = path.join(tmpDir, 'routines');
  fs.mkdirSync(userRoutinesDir, { recursive: true });

  vi.spyOn(state, 'getRoutinesDir').mockReturnValue(userRoutinesDir);
  vi.spyOn(state, 'ensureAgentsDir').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeJob(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-end-at',
    schedule: '* * * * * *', // every second (croner extension)
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'noop',
    ...overrides,
  };
}

describe('JobScheduler endAt enforcement', () => {
  it('auto-disables and skips firing when endAt has already passed', async () => {
    const config = makeJob({
      name: 'past-end',
      endAt: '2020-01-01T00:00:00Z',
    });
    writeJob(config);

    let fired = 0;
    const scheduler = new JobScheduler(async () => {
      fired++;
    });
    scheduler.schedule(config);

    // Give croner one tick to fire.
    await new Promise((r) => setTimeout(r, 1300));
    scheduler.stopAll();

    expect(fired).toBe(0);
    const reloaded = readJob('past-end');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.enabled).toBe(false);
  });

  it('fires normally when endAt is in the future', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const config = makeJob({
      name: 'future-end',
      endAt: future,
    });
    writeJob(config);

    let fired = 0;
    const scheduler = new JobScheduler(async () => {
      fired++;
    });
    scheduler.schedule(config);

    await new Promise((r) => setTimeout(r, 1300));
    scheduler.stopAll();

    expect(fired).toBeGreaterThanOrEqual(1);
    const reloaded = readJob('future-end');
    expect(reloaded!.enabled).toBe(true);
  });
});
