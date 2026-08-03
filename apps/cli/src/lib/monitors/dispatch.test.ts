import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dispatchAction } from './dispatch.js';
import type { MonitorConfig, MonitorEvent } from './config.js';
import type { Meta } from '../types.js';

/**
 * The monitor `notify` action used to exec openclaw directly with no target, so
 * it inherited a hardcoded owner number and had no missing-binary guard (raw
 * ENOENT). It now routes through the one owner-send seam (sendToOwner →
 * resolveTransport). Real path: a fake `openclaw` on PATH records the argv.
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
});
