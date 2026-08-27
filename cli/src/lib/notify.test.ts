import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildOpenClawNotifyArgs,
  formatUrgentBlockMessage,
  notifyUrgentBlock,
  sendToOwner,
} from './notify.js';
import type { Meta } from './types.js';
import type { OpenBlock } from './feed/feed.js';

describe('buildOpenClawNotifyArgs', () => {
  it('builds message-send argv with the caller-supplied target (no hardcoded number)', () => {
    const args = buildOpenClawNotifyArgs('hello', { target: 'chat-42' });
    expect(args).toEqual([
      'message',
      'send',
      '--channel',
      'telegram',
      '--account',
      'default',
      '--target',
      'chat-42',
      '--message',
      'hello',
    ]);
    expect(args).not.toContain('--text');
  });

  it('has no numeric-literal recipient default baked into the source', () => {
    // The recipient is always resolved by the caller; regression guard against
    // re-introducing a `?? '<some chat id>'` default for any target/owner.
    const src = fs.readFileSync(new URL('./notify.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/\?\?\s*['"]\d{5,}['"]/);
  });
});

describe('formatUrgentBlockMessage', () => {
  it('formats urgent feed notifications without emoji', () => {
    const message = formatUrgentBlockMessage({
      blockId: 'block-a',
      sessionId: 'a',
      mailboxId: 'a',
      host: 'zion',
      runtime: 'headless',
      ts: '2026-07-21T12:00:00.000Z',
      blockClass: 'decision',
      costOfDelay: 'high',
      questions: [{ header: 'Deploy', text: 'Production deploy?' }],
    });

    expect(message).toBe('URGENT DECISION on zion: [Deploy] Production deploy? (cost: high, id: block-a)');
    expect(message).not.toContain(String.fromCodePoint(0x1f6a8));
  });
});

/**
 * Real-path tests for the consolidated owner-send seam. No mocking: a real
 * `openclaw` executable (a shell script that records its argv) is placed on PATH,
 * so the assertions run through lookupTransport → openclaw-telegram provider →
 * exec, the actual delivery path.
 *
 * POSIX-only (RUSH-2215): the openclaw-telegram provider resolves the binary
 * with `which openclaw` and execs it, and the fake is a `#!/bin/sh` recorder —
 * neither works on Windows (no `which`; an extensionless shell script is not
 * executable), so these assertions can only run on a POSIX host.
 */
describe.skipIf(process.platform === 'win32')('sendToOwner (owner resolution + provider routing)', () => {
  let tmp: string;
  let record: string;
  const savedPath = process.env.PATH;
  const savedRecord = process.env.OPENCLAW_RECORD;

  /** A Meta that routes telegram -> openclaw-telegram and names an owner. */
  function metaWithOwner(to: string): Meta {
    return {
      notify: {
        owner: { channel: 'telegram', to },
        transports: { telegram: 'openclaw-telegram' },
      },
    } as Meta;
  }

  /** Install a fake `openclaw` on PATH that appends its argv to `record`. */
  function installFakeOpenclaw(): void {
    const bin = path.join(tmp, 'openclaw');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPENCLAW_RECORD"\nexit 0\n`);
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  }

  /** A PATH with `which`/`sh` available but no `openclaw` anywhere on it. */
  function pathWithoutOpenclaw(): void {
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
    record = path.join(tmp, 'argv.log');
    process.env.OPENCLAW_RECORD = record;
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml');
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedRecord === undefined) delete process.env.OPENCLAW_RECORD;
    else process.env.OPENCLAW_RECORD = savedRecord;
    delete process.env.AGENTS_HUMANS_FILE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves the recipient from notify.owner.to and hands it to the provider', async () => {
    installFakeOpenclaw();
    const result = await sendToOwner('ping', { meta: metaWithOwner('owner-chat-1') });
    expect(result.ok).toBe(true);
    expect(result.channel).toBe('openclaw-telegram');
    expect(result.id).toBe('owner-chat-1');
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target owner-chat-1');
    expect(argv).toContain('--message ping');
  });

  it('follows a change to notify.owner.to (one source of truth)', async () => {
    installFakeOpenclaw();
    await sendToOwner('a', { meta: metaWithOwner('first') });
    await sendToOwner('b', { meta: metaWithOwner('second') });
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target first');
    expect(argv).toContain('--target second');
  });

  it('honours a dry-run without exec, echoing the resolved target', async () => {
    installFakeOpenclaw();
    const result = await sendToOwner('ping', { meta: metaWithOwner('owner-chat-2'), dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.id).toBe('owner-chat-2');
    expect(fs.existsSync(record)).toBe(false); // nothing exec'd
  });

  it('fails loud (not ENOENT) when the provider binary is missing', async () => {
    pathWithoutOpenclaw();
    const result = await sendToOwner('ping', { meta: metaWithOwner('owner-chat-3') });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('openclaw CLI not found on PATH');
    expect(result.error).not.toMatch(/ENOENT/);
  });

  it('fails loud when notify.owner is unset (no hardcoded fallback)', async () => {
    const result = await sendToOwner('ping', { meta: {} as Meta });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('notify.owner');
  });

  it('returns ok:false on an unresolvable channel — never process.exit()', async () => {
    // sendToOwner is called from the monitor daemon and the feed-dispatch loop,
    // so it must resolve via lookupTransport, not the die()-capable
    // resolveTransport: an exit here bypasses both callers' try/catch.
    let exited: number | undefined;
    const realExit = process.exit;
    // Tripwire, not a mock of the code under test: if the seam still exits, the
    // call would abort the run — record the attempt and let the assertion fail.
    process.exit = ((code?: number) => {
      exited = code ?? 0;
      throw new Error(`process.exit(${exited})`);
    }) as typeof process.exit;
    try {
      const result = await sendToOwner('ping', {
        meta: { notify: { owner: { channel: 'typo-channel', to: 'owner-chat-4' } } } as Meta,
      });
      expect(exited).toBeUndefined();
      expect(result.ok).toBe(false);
      expect(result.channel).toBe('typo-channel');
      expect(result.id).toBe('owner-chat-4');
      expect(result.error).toMatch(/No channel provider 'typo-channel'/);
    } finally {
      process.exit = realExit;
    }
  });
});

// POSIX-only (RUSH-2215): same openclaw `which` + `#!/bin/sh` recorder path as
// sendToOwner above — untestable on Windows.
describe.skipIf(process.platform === 'win32')('notifyUrgentBlock (feed urgent-block dispatch resolves the owner)', () => {
  let tmp: string;
  let record: string;
  const savedPath = process.env.PATH;
  const savedRecord = process.env.OPENCLAW_RECORD;

  function block(): OpenBlock {
    return {
      blockId: 'b1',
      sessionId: 's1',
      mailboxId: 'm1',
      host: 'zion',
      runtime: 'headless',
      ts: '2026-07-21T12:00:00.000Z',
      questions: [{ header: 'Deploy', text: 'Ship it?' }],
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-block-'));
    record = path.join(tmp, 'argv.log');
    process.env.OPENCLAW_RECORD = record;
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml');
    const bin = path.join(tmp, 'openclaw');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPENCLAW_RECORD"\nexit 0\n`);
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedRecord === undefined) delete process.env.OPENCLAW_RECORD;
    else process.env.OPENCLAW_RECORD = savedRecord;
    delete process.env.AGENTS_HUMANS_FILE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sends the urgent block to notify.owner.to, not a hardcoded number', async () => {
    const meta = {
      notify: { owner: { channel: 'telegram', to: 'urgent-owner' }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
    const result = await notifyUrgentBlock(block(), { meta });
    expect(result.ok).toBe(true);
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target urgent-owner');
    expect(argv).toContain('URGENT');
  });

  it('skips an already-notified block without touching the provider', async () => {
    const meta = {
      notify: { owner: { channel: 'telegram', to: 'urgent-owner' }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
    const result = await notifyUrgentBlock({ ...block(), notifiedAt: '2026-07-21T12:00:00.000Z' }, { meta });
    expect(result.skipped).toBe(true);
    expect(fs.existsSync(record)).toBe(false);
  });
});

/**
 * PHNX-3303 integration: sendToOwner must actually INVOKE the SSH forward when
 * local owner delivery fails on a box with no working provider — proving the
 * wiring, not just the isolated owner-forward.ts functions.
 *
 * Real path, no mocking of the logic: the owner channel is the macOS-only rush
 * `imessage` transport, `rush` is absent from PATH so the local send genuinely
 * fails its `which rush` preflight, a real device registry names a macOS peer,
 * and a fake `ssh` on PATH stands in for the transport (the same on-PATH-fake
 * pattern the openclaw tests above use) returning the peer's `agents send
 * --json` result. POSIX-only: the rig needs `which` + `#!/bin/sh`.
 */
describe.skipIf(process.platform === 'win32')('sendToOwner forwards over SSH on local failure (PHNX-3303)', () => {
  let tmp: string;
  let sshRecord: string;
  const saved = {
    PATH: process.env.PATH,
    devicesDir: process.env.AGENTS_DEVICES_DIR,
    machineId: process.env.AGENTS_SYNC_MACHINE_ID,
    humans: process.env.AGENTS_HUMANS_FILE,
    sshRecord: process.env.SSH_RECORD,
    guard: process.env.AGENTS_OWNER_NO_FORWARD,
  };
  const ownerMeta = { notify: { owner: { channel: 'imessage', to: '+18055551234' } } } as Meta;

  function writeRegistry(reg: object): void {
    fs.writeFileSync(path.join(process.env.AGENTS_DEVICES_DIR!, 'registry.json'), JSON.stringify(reg));
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sendtoowner-forward-'));
    const devicesDir = path.join(tmp, 'devices');
    fs.mkdirSync(devicesDir, { recursive: true });
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    const now = new Date().toISOString();
    writeRegistry({
      'mac-test': {
        name: 'mac-test', platform: 'macos', shell: 'posix',
        address: { via: 'manual', dnsName: 'mac-test.example' },
        auth: { method: 'key' }, createdAt: now, updatedAt: now,
      },
    });
    process.env.AGENTS_SYNC_MACHINE_ID = 'linux-self'; // not the mac peer
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml'); // absent -> meta.notify.owner wins

    sshRecord = path.join(tmp, 'ssh.log');
    process.env.SSH_RECORD = sshRecord;
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const ssh = path.join(bin, 'ssh');
    // No `rush` on PATH -> the LOCAL imessage send fails its `which rush` preflight.
    fs.writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SSH_RECORD"\nprintf '%s\\n' '{"ok":true,"channel":"imessage","id":"+18055551234"}'\nexit 0\n`);
    fs.chmodSync(ssh, 0o755);
    process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    delete process.env.AGENTS_OWNER_NO_FORWARD;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries({
      PATH: saved.PATH, AGENTS_DEVICES_DIR: saved.devicesDir, AGENTS_SYNC_MACHINE_ID: saved.machineId,
      AGENTS_HUMANS_FILE: saved.humans, SSH_RECORD: saved.sshRecord, AGENTS_OWNER_NO_FORWARD: saved.guard,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('hands off to the macOS peer when this box has no rush', async () => {
    const result = await sendToOwner('ship it', { meta: ownerMeta });
    expect(result.ok).toBe(true); // forwarded delivery, not the local rush failure
    const log = fs.readFileSync(sshRecord, 'utf-8');
    expect(log).toContain('mac-test.example');
    expect(log).toContain('AGENTS_OWNER_NO_FORWARD'); // loop guard rides the forward
    expect(log).toContain('send');
  });

  it('keeps the clean local error (never dials a peer) when no capable peer exists', async () => {
    writeRegistry({});
    const result = await sendToOwner('ship it', { meta: ownerMeta });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('rush CLI not found on PATH');
    expect(fs.existsSync(sshRecord)).toBe(false);
  });

  it('does not forward for a Linux-capable transport — only the rush family hops', async () => {
    const meta = {
      notify: { owner: { channel: 'telegram', to: 'c1' }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
    const result = await sendToOwner('ship it', { meta });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('openclaw CLI not found on PATH');
    expect(fs.existsSync(sshRecord)).toBe(false); // non-rush failure stays local
  });
});
