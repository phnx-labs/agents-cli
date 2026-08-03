import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { dispatchAction } from './dispatch.js';
import type { MonitorConfig, MonitorEvent } from './config.js';
import type { Meta } from '../types.js';

/**
 * The monitor `notify` action used to exec openclaw directly with no target, so
 * it inherited a hardcoded owner number and had no missing-binary guard (raw
 * ENOENT). It now routes through the one owner-send seam (sendToOwner →
 * lookupTransport). Real path: a fake `openclaw` on PATH records the argv.
 */
describe('dispatchAction notify (resolves the owner, fails loud on a missing binary)', () => {
  let tmp: string;
  let record: string;
  const savedPath = process.env.PATH;
  const savedRecord = process.env.OPENCLAW_RECORD;

  function metaWithOwner(to: string): Meta {
    return {
      notify: { owner: { channel: 'telegram', to }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
  }

  function notifyMonitor(): MonitorConfig {
    return {
      name: 'ci-red',
      enabled: true,
      source: { type: 'command', command: 'echo x' },
      condition: { mode: 'on-change' },
      action: { type: 'notify' },
    } as MonitorConfig;
  }

  const event: MonitorEvent = {
    monitorName: 'ci-red',
    firedAt: '2026-07-21T12:00:00.000Z',
    summary: 'build failed',
    payload: {},
  };

  function installFakeOpenclaw(): void {
    const bin = path.join(tmp, 'openclaw');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPENCLAW_RECORD"\nexit 0\n`);
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-notify-'));
    record = path.join(tmp, 'argv.log');
    process.env.OPENCLAW_RECORD = record;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedRecord === undefined) delete process.env.OPENCLAW_RECORD;
    else process.env.OPENCLAW_RECORD = savedRecord;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sends the fired event to notify.owner.to, not a hardcoded number', async () => {
    installFakeOpenclaw();
    const result = await dispatchAction(notifyMonitor(), event, metaWithOwner('monitor-owner'));
    expect(result).toEqual({ kind: 'notify', ok: true });
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target monitor-owner');
    expect(argv).toContain('--message build failed');
  });

  it('follows a change to notify.owner.to', async () => {
    installFakeOpenclaw();
    await dispatchAction(notifyMonitor(), event, metaWithOwner('owner-a'));
    await dispatchAction(notifyMonitor(), event, metaWithOwner('owner-b'));
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target owner-a');
    expect(argv).toContain('--target owner-b');
  });

  it('fails loud with a clean error (not ENOENT) when openclaw is missing', async () => {
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`; // no openclaw on PATH
    const result = await dispatchAction(notifyMonitor(), event, metaWithOwner('monitor-owner'));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('openclaw CLI not found on PATH');
    expect(result.error).not.toMatch(/ENOENT/);
  });

  it('an explicit notifyChannel overrides the owner channel but keeps the owner target', async () => {
    installFakeOpenclaw();
    const monitor = { ...notifyMonitor(), action: { type: 'notify', notifyChannel: 'telegram' } } as MonitorConfig;
    const result = await dispatchAction(monitor, event, metaWithOwner('monitor-owner'));
    expect(result.ok).toBe(true);
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target monitor-owner');
  });

  it('an unresolvable notifyChannel returns ok:false — it does not exit the process', async () => {
    // `agents monitors add --notify <channel>` validates nothing (commands/monitors.ts),
    // so a typo lands in the config and reaches here. Resolving through the
    // die()-capable resolveTransport used to process.exit() and take the whole
    // monitor daemon down with it (engine.ts try/catch can't catch an exit).
    const monitor = {
      ...notifyMonitor(),
      action: { type: 'notify', notifyChannel: 'not-a-real-channel' },
    } as MonitorConfig;
    const result = await dispatchAction(monitor, event, metaWithOwner('monitor-owner'));
    expect(result.kind).toBe('notify');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No channel provider 'not-a-real-channel'/);
  });
});

/**
 * The daemon-survival guarantee, proven in a real child process — the same shape
 * as the review's live repro. An in-process assertion can't distinguish "returned
 * a result" from "would have exited", so this runs dispatchAction for real and
 * requires the process to reach the line after it and exit 0.
 */
describe('dispatchAction notify (process survives an unresolvable channel)', () => {
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-die-'));
  });

  afterEach(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  it('returns to its caller and exits 0 instead of process.exit()-ing', () => {
    const moduleUrl = pathToFileURL(path.resolve('src/lib/monitors/dispatch.ts')).href;
    // A file, not `tsx -e`: the inline form compiles to cjs, where the top-level
    // await this needs is unavailable.
    const fixture = path.join(fixtureDir, 'dispatch-bad-channel.mts');
    fs.writeFileSync(
      fixture,
      `import { dispatchAction } from ${JSON.stringify(moduleUrl)};\n` +
        `const monitor = {\n` +
        `  name: 'ci-red',\n` +
        `  enabled: true,\n` +
        `  source: { type: 'command', command: 'echo x' },\n` +
        `  condition: { mode: 'on-change' },\n` +
        `  action: { type: 'notify', notifyChannel: 'not-a-real-channel' },\n` +
        `} as any;\n` +
        `const event = {\n` +
        `  monitorName: 'ci-red',\n` +
        `  firedAt: '2026-07-21T12:00:00.000Z',\n` +
        `  summary: 'build failed',\n` +
        `  payload: {},\n` +
        `} as any;\n` +
        `const meta = { notify: { owner: { channel: 'telegram', to: 'monitor-owner' } } } as any;\n` +
        `console.log('BEFORE');\n` +
        `const result = await dispatchAction(monitor, event, meta);\n` +
        `console.log('AFTER ' + JSON.stringify(result));\n`,
    );

    const child = spawnSync(tsxBin, [fixture], { encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('BEFORE');
    expect(child.stdout).toContain('AFTER '); // the pre-fix build exited before this
    const result = JSON.parse(child.stdout.slice(child.stdout.indexOf('AFTER ') + 6).trim());
    expect(result.kind).toBe('notify');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No channel provider 'not-a-real-channel'/);
  });
});
