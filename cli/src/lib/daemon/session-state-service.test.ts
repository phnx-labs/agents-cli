import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import { SessionStateService } from './session-state-service.js';

let daemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-session-state-service-'));
  process.env.AGENTS_DAEMON_DIR = daemonDir;
});

afterEach(() => {
  if (originalDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = originalDaemonDir;
  fs.rmSync(daemonDir, { recursive: true, force: true });
});

describe('SessionStateService', () => {
  it('runs the real no-reader publish path under supervisor health and stops cleanly', async () => {
    const supervisor = new ServiceSupervisor();
    const service = new SessionStateService(() => supervisor.runNow('session-state'));
    supervisor.register(service);

    await supervisor.startAll({ log: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(supervisor.health()['session-state']).toMatchObject({
      state: 'running',
      consecutiveFailures: 0,
    });

    await supervisor.stopAll();
    expect(supervisor.health()['session-state'].state).toBe('stopped');
  });
});
