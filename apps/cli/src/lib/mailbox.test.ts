import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mailboxDir, enqueue, drain, peek, clear, assertValidMailboxId, isExpired, sweepExpired, type MailboxMessage } from './mailbox.js';
import { blockIdForSession, getBlockReceipts, publishBlock } from './feed.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-test-'));
}

const BOX = 'a1b2';

/** Write a raw file straight into inbox/ (to simulate misplaced/corrupt msgs). */
function writeRawInbox(boxDir: string, name: string, content: string): void {
  const inbox = path.join(boxDir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, name), content, 'utf-8');
}

function texts(msgs: MailboxMessage[]): string[] {
  return msgs.map((m) => m.text);
}

describe('mailbox', () => {
  it('drains in FIFO order, stamps `to`, and empties the inbox', () => {
    const box = mailboxDir(BOX, tmpRoot());
    enqueue(box, { to: BOX, text: 'first' });
    enqueue(box, { to: BOX, text: 'second' });
    enqueue(box, { to: BOX, text: 'third' });

    const got = drain(box);
    expect(texts(got)).toEqual(['first', 'second', 'third']);
    expect(got.every((m) => m.to === BOX)).toBe(true);

    // idempotent: a second drain finds nothing.
    expect(drain(box)).toEqual([]);
    // pending inbox is empty; delivered messages are archived.
    expect(fs.readdirSync(path.join(box, 'inbox'))).toHaveLength(0);
    expect(fs.readdirSync(path.join(box, 'consumed'))).toHaveLength(3);
  });

  it('is at-least-once: recovers a message left in processing/ by an interrupted drain', () => {
    const box = mailboxDir(BOX, tmpRoot());
    const msgId = enqueue(box, { to: BOX, text: 'survive-a-crash' });

    // Simulate a drain that CLAIMED the message (inbox -> processing) then died
    // before archiving it.
    fs.mkdirSync(path.join(box, 'processing'), { recursive: true });
    fs.renameSync(
      path.join(box, 'inbox', `${msgId}.json`),
      path.join(box, 'processing', `${msgId}.json`),
    );

    const got = drain(box);
    expect(texts(got)).toEqual(['survive-a-crash']);
    expect(fs.readdirSync(path.join(box, 'processing'))).toHaveLength(0);
    expect(fs.readdirSync(path.join(box, 'consumed'))).toHaveLength(1);
  });

  it('a single drain sweeps every message written by concurrent-style enqueues', () => {
    const box = mailboxDir(BOX, tmpRoot());
    const n = 5;
    for (let i = 0; i < n; i++) enqueue(box, { to: BOX, text: `m${i}` });

    const got = drain(box);
    expect(got).toHaveLength(n);
    expect(texts(got)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(fs.readdirSync(path.join(box, 'inbox'))).toHaveLength(0);
  });

  it('empty inbox is a no-op (no throw, dirs created)', () => {
    const box = mailboxDir(BOX, tmpRoot());
    expect(drain(box)).toEqual([]);
    expect(fs.existsSync(path.join(box, 'inbox'))).toBe(true);
    expect(fs.existsSync(path.join(box, 'processing'))).toBe(true);
    expect(fs.existsSync(path.join(box, 'consumed'))).toBe(true);
  });

  it('refuses a message addressed to a different box (anti-misroute) and drops it', () => {
    const box = mailboxDir(BOX, tmpRoot());
    // Simulate a file that landed in the wrong box, addressed to someone else.
    writeRawInbox(box, '1700000000000-000000-deadbeef.json',
      JSON.stringify({ msgId: 'x', to: 'someone-else', ts: '', text: 'not for you' }));
    // And one legitimately addressed here.
    enqueue(box, { to: BOX, text: 'for me' });

    const got = drain(box);
    expect(texts(got)).toEqual(['for me']); // the mismatched one is NOT delivered
    // The dropped message must not loop — inbox is drained clean.
    expect(fs.readdirSync(path.join(box, 'inbox'))).toHaveLength(0);
  });

  it('drops a corrupt message without stalling the queue', () => {
    const box = mailboxDir(BOX, tmpRoot());
    writeRawInbox(box, '1700000000000-000000-cafebabe.json', '{ not valid json');
    enqueue(box, { to: BOX, text: 'still delivered' });

    const got = drain(box);
    expect(texts(got)).toEqual(['still delivered']);
    expect(fs.readdirSync(path.join(box, 'inbox'))).toHaveLength(0);
  });

  it('peek is non-destructive; clear removes pending messages', () => {
    const box = mailboxDir(BOX, tmpRoot());
    enqueue(box, { to: BOX, text: 'a' });
    enqueue(box, { to: BOX, text: 'b' });

    expect(texts(peek(box))).toEqual(['a', 'b']);
    // peek did not consume:
    expect(texts(peek(box))).toEqual(['a', 'b']);

    expect(clear(box)).toBe(2);
    expect(peek(box)).toEqual([]);
    expect(drain(box)).toEqual([]);
  });

  it('rejects a mailboxId with a path separator or traversal (fail loud, not silent-drop)', () => {
    const root = tmpRoot();
    for (const bad of ['team1/subagentA', '..', '.', '', 'a\\b', 'foo/../bar']) {
      expect(() => mailboxDir(bad, root)).toThrow(/Invalid mailboxId/);
    }
    // enqueue validates the `to` stamp at write time too.
    const box = mailboxDir(BOX, root);
    expect(() => enqueue(box, { to: 'team1/subagentA', text: 'x' })).toThrow(/Invalid mailboxId/);
    // a clean id passes.
    expect(() => assertValidMailboxId('loop-1700000000000-a1b2c3')).not.toThrow();
  });

  it('round-trips the `from` field and a host:/path clip token in text', () => {
    const box = mailboxDir(BOX, tmpRoot());
    enqueue(box, { to: BOX, from: 'operator@s0', text: 'match this  zion:/Users/m/mock.png' });

    const [msg] = drain(box);
    expect(msg.from).toBe('operator@s0');
    expect(msg.text).toContain('zion:/Users/m/mock.png');
  });

  it('stamps expiresAt when ttlSeconds is provided', () => {
    const box = mailboxDir(BOX, tmpRoot());
    const msgId = enqueue(box, { to: BOX, text: 'ttl', ttlSeconds: 60 });
    const pending = peek(box);
    expect(pending).toHaveLength(1);
    expect(pending[0].expiresAt).toBeTruthy();
    expect(Date.parse(pending[0].expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('drain/peek drop expired messages to consumed with a dropped marker', () => {
    const box = mailboxDir(BOX, tmpRoot());
    const now = new Date('2026-01-01T00:00:00.000Z');
    const msgId = enqueue(box, { to: BOX, text: 'fresh', ttlSeconds: 30 });
    // backdate the record so it is already expired
    const file = path.join(box, 'inbox', `${msgId}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
    record.ts = new Date(now.getTime() - 60_000).toISOString();
    record.expiresAt = new Date(now.getTime() - 1).toISOString();
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');

    expect(drain(box, BOX, now)).toEqual([]);
    const consumed = fs.readdirSync(path.join(box, 'consumed'));
    expect(consumed).toHaveLength(1);
    const archived = JSON.parse(fs.readFileSync(path.join(box, 'consumed', consumed[0]), 'utf-8'));
    expect(archived.dropped).toBe('expired');
    expect(archived.text).toBe('fresh');
  });

  it('isExpired checks expiry against a provided time', () => {
    const msg: MailboxMessage = { msgId: 'x', to: BOX, ts: '', text: '', expiresAt: '2026-01-01T00:00:00.000Z' };
    expect(isExpired(msg, new Date('2026-01-01T00:00:01.000Z'))).toBe(true);
    expect(isExpired(msg, new Date('2025-12-31T23:59:59.000Z'))).toBe(false);
  });

  it('surfaces consumed receipts to the feed store when a message carries blockId', () => {
    const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-receipt-'));
    const previous = process.env.AGENTS_FEED_DIR;
    process.env.AGENTS_FEED_DIR = feedDir;
    try {
      // The feed block must exist for the receipt to be recorded.
      const blockId = blockIdForSession(BOX);
      publishBlock({
        blockId,
        sessionId: BOX,
        mailboxId: BOX,
        host: 'test-host',
        runtime: 'claude',
        ts: new Date().toISOString(),
        questions: [{ text: 'Confirm?' }],
      }, feedDir);

      const box = mailboxDir(BOX, tmpRoot());
      const msgId = enqueue(box, { to: BOX, from: 'feed', text: 'yes', blockId });

      const [msg] = drain(box);
      expect(msg.blockId).toBe(blockId);

      const receipts = getBlockReceipts(blockId, feedDir);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ msgId, status: 'consumed', from: 'feed' });
    } finally {
      process.env.AGENTS_FEED_DIR = previous;
    }
  });
});
