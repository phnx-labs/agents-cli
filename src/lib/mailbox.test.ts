import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mailboxDir, enqueue, drain, peek, clear, assertValidMailboxId, type MailboxMessage } from './mailbox.js';

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
});
