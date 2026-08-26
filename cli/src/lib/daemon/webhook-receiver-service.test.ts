import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import { WebhookReceiverService } from './webhook-receiver-service.js';

let daemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-webhook-service-'));
  process.env.AGENTS_DAEMON_DIR = daemonDir;
});

afterEach(() => {
  if (originalDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = originalDaemonDir;
  fs.rmSync(daemonDir, { recursive: true, force: true });
});

describe('WebhookReceiverService', () => {
  it('starts the real empty receiver host as measured healthy and closes cleanly', async () => {
    const logs: string[] = [];
    const supervisor = new ServiceSupervisor();
    supervisor.register(new WebhookReceiverService());

    await supervisor.startAll({ log: (_level, message) => logs.push(message) });

    expect(supervisor.health()['webhook-receiver']).toMatchObject({
      state: 'running',
      consecutiveFailures: 0,
    });
    expect(logs).toContain('Webhook receiver service enabled; no receivers declared in daemon/webhooks.yaml');

    await supervisor.stopAll();
    expect(supervisor.health()['webhook-receiver'].state).toBe('stopped');
  });
});
