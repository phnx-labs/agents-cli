import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AddressInfo } from 'net';
import {
  DEFAULT_WEBHOOK_PORT,
  addHostedReceiver,
  getDaemonWebhooksConfigPath,
  hostedReceiverPort,
  readDaemonWebhooksConfig,
  removeHostedReceiver,
  resolveReceiverSecrets,
  startHostedWebhookReceivers,
  writeDaemonWebhooksConfig,
} from './daemon-webhooks.js';
import { DAEMON_SERVICES, DAEMON_SERVICE_IDS } from './daemon-services.js';

let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-webhooks-'));
  previousConfigDir = process.env.AGENTS_DAEMON_CONFIG_DIR;
  process.env.AGENTS_DAEMON_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.AGENTS_DAEMON_CONFIG_DIR;
  else process.env.AGENTS_DAEMON_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('daemon webhooks config', () => {
  it('hosts nothing when no config file exists', () => {
    expect(fs.existsSync(getDaemonWebhooksConfigPath())).toBe(false);
    expect(readDaemonWebhooksConfig()).toEqual({ receivers: [] });
  });

  it('round-trips a declared receiver through the real YAML file', () => {
    writeDaemonWebhooksConfig({
      receivers: [{ bundle: 'linear-webhook', port: 8788, rateLimit: 30, funnel: { publicPort: 443 } }],
    });

    const onDisk = yaml.parse(fs.readFileSync(getDaemonWebhooksConfigPath(), 'utf-8'));
    expect(onDisk.receivers).toEqual([
      { bundle: 'linear-webhook', port: 8788, rateLimit: 30, funnel: { publicPort: 443 } },
    ]);
    expect(readDaemonWebhooksConfig().receivers[0]).toEqual({
      bundle: 'linear-webhook',
      port: 8788,
      rateLimit: 30,
      funnel: { publicPort: 443 },
    });
  });

  it('reads an unreadable or malformed file as "host nothing", never a throw', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(getDaemonWebhooksConfigPath(), 'receivers: [ this: is: not: valid', 'utf-8');
    expect(readDaemonWebhooksConfig()).toEqual({ receivers: [] });
  });

  it('drops an entry with no bundle and a funnel port Tailscale cannot serve', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      getDaemonWebhooksConfigPath(),
      yaml.stringify({
        receivers: [
          { port: 9000 },                                        // no bundle -> unusable, dropped
          { bundle: 'gh', port: 8790, funnel: { publicPort: 9999 } }, // 9999 is not a Funnel port
        ],
      }),
      'utf-8',
    );
    const { receivers } = readDaemonWebhooksConfig();
    // The bundle-less entry is gone entirely; the bad funnel port is dropped but
    // the receiver still binds localhost rather than being silently discarded.
    expect(receivers).toEqual([{ bundle: 'gh', port: 8790 }]);
  });

  it('treats the port as the receiver identity: a second add on it is an edit', () => {
    addHostedReceiver({ bundle: 'first' });
    addHostedReceiver({ bundle: 'second', port: 8788 });
    expect(readDaemonWebhooksConfig().receivers.map((r) => [r.bundle, hostedReceiverPort(r)]))
      .toEqual([['first', DEFAULT_WEBHOOK_PORT], ['second', 8788]]);

    addHostedReceiver({ bundle: 'replacement', port: 8788 });
    expect(readDaemonWebhooksConfig().receivers.map((r) => [r.bundle, hostedReceiverPort(r)]))
      .toEqual([['first', DEFAULT_WEBHOOK_PORT], ['replacement', 8788]]);
  });

  it('removes by port and reports when nothing was declared there', () => {
    addHostedReceiver({ bundle: 'first' });
    expect(removeHostedReceiver(9999)).toBeNull();
    expect(readDaemonWebhooksConfig().receivers).toHaveLength(1);
    expect(removeHostedReceiver(DEFAULT_WEBHOOK_PORT)).toEqual({ bundle: 'first' });
    expect(readDaemonWebhooksConfig().receivers).toEqual([]);
  });

  it('returns the removed entry so the caller can take its public Funnel down', () => {
    // The Funnel is brought up per receiver; dropping the receiver without
    // dropping the Funnel leaves a public HTTPS route pointed at a dead port.
    addHostedReceiver({ bundle: 'gh', port: 8790, funnel: { publicPort: 8443 } });
    expect(removeHostedReceiver(8790)).toEqual({ bundle: 'gh', port: 8790, funnel: { publicPort: 8443 } });
  });
});

describe('webhook-receiver daemon service', () => {
  it('is catalogued as a hosted service', () => {
    expect(DAEMON_SERVICE_IDS).toContain('webhook-receiver');
    const def = DAEMON_SERVICES.find((s) => s.id === 'webhook-receiver');
    expect(def?.title).toBe('Webhook receiver');
    expect(def?.description).toContain('webhooks.yaml');
  });
});

describe('startHostedWebhookReceivers', () => {
  it('binds nothing when no receiver is declared', async () => {
    const logs: string[] = [];
    const hosted = await startHostedWebhookReceivers({ log: (level, msg) => logs.push(`${level} ${msg}`) });
    try {
      expect(hosted.count).toBe(0);
      expect(logs).toEqual([]);
    } finally {
      await hosted.close();
    }
  });

  it('survives a bind failure: the conflicting receiver is skipped, the rest still bind', async () => {
    // A REAL occupied port. `server.listen()` reports EADDRINUSE as an async
    // 'error' event, not a throw — so before this was awaited, the event reached
    // the process-level uncaughtException handler and killed the whole daemon
    // (with it: the secrets broker, scheduler, monitors, browser IPC, self-heal).
    // Nothing here is mocked: the squatter is an actual listening HTTP server.
    const squatter = http.createServer(() => {});
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const takenPort = (squatter.address() as AddressInfo).port;
    const freePort = takenPort + 1;

    // Two receivers whose secrets DO resolve, so the only difference between
    // them is the bind: one port is taken, the other is not.
    const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-webhooks-secrets-'));
    const previousStateDir = process.env.AGENTS_STATE_DIR;
    process.env.AGENTS_STATE_DIR = bundleDir;
    writeDaemonWebhooksConfig({
      receivers: [{ bundle: 'conflicting', port: takenPort }, { bundle: 'healthy', port: freePort }],
    });

    const logs: { level: string; message: string }[] = [];
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    // Resolve both bundles to a fixed secret without touching the real keychain.
    const hosted = await startHostedWebhookReceivers({
      log: (level, message) => logs.push({ level, message }),
      resolveSecrets: () => ({ linear: 'test-secret' }),
    });
    try {
      // One bound, one skipped — and the process is still alive to assert it.
      expect(hosted.count).toBe(1);
      const warn = logs.find((l) => l.level === 'WARN');
      expect(warn?.message).toContain(`:${takenPort} failed to bind`);
      expect(warn?.message).toMatch(/EADDRINUSE|address already in use/i);
      expect(logs.some((l) => l.level === 'INFO' && l.message.includes(`127.0.0.1:${freePort}`))).toBe(true);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      await hosted.close();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
      if (previousStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
      else process.env.AGENTS_STATE_DIR = previousStateDir;
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it('fails a receiver LOUD when its signing secret cannot be resolved', async () => {
    // A bundle that genuinely does not exist on this machine — the same failure
    // shape as a locked bundle: the receiver must NOT bind unverifiable ingress,
    // and the reason must reach the daemon log rather than being swallowed.
    addHostedReceiver({ bundle: 'daemon-webhooks-test-absent-bundle', port: 8791 });
    const logs: { level: string; message: string }[] = [];
    const hosted = await startHostedWebhookReceivers({ log: (level, message) => logs.push({ level, message }) });
    try {
      expect(hosted.count).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('WARN');
      expect(logs[0].message).toContain(':8791 skipped');
      expect(logs[0].message).toContain('daemon-webhooks-test-absent-bundle');
    } finally {
      await hosted.close();
    }
  });

  it('throws rather than returning empty secrets for an unresolvable bundle', () => {
    expect(() => resolveReceiverSecrets('daemon-webhooks-test-absent-bundle')).toThrow();
  });
});
