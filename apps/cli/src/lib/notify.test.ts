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
import type { OpenBlock } from './feed.js';

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
 */
describe('sendToOwner (owner resolution + provider routing)', () => {
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
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedRecord === undefined) delete process.env.OPENCLAW_RECORD;
    else process.env.OPENCLAW_RECORD = savedRecord;
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

describe('notifyUrgentBlock (feed urgent-block dispatch resolves the owner)', () => {
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
