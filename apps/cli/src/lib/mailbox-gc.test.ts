import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mailboxDir, enqueue, drain } from './mailbox.js';
import { gcMailbox } from './mailbox-gc.js';
import { blockIdForSession, publishBlock, readBlock } from './feed.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-gc-'));
}

const BOX = 'a1b2';

describe('mailbox GC', () => {
  it('archives pending messages from a dead box and removes its feed block', () => {
    const root = tmpRoot();
    const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-gc-feed-'));
    const previous = process.env.AGENTS_FEED_DIR;
    process.env.AGENTS_FEED_DIR = feedDir;
    try {
      const box = mailboxDir(BOX, root);
      enqueue(box, { to: BOX, text: 'to dead agent' });
      publishBlock({
        blockId: blockIdForSession(BOX),
        sessionId: BOX,
        mailboxId: BOX,
        host: 'test-host',
        runtime: 'claude',
        ts: new Date().toISOString(),
        questions: [{ text: 'Dead?' }],
      }, feedDir);

      const result = gcMailbox(new Set(), { root, feedRoot: feedDir });

      expect(result.deadBoxes).toBe(1);
      expect(result.messagesDroppedDead).toBe(1);
      expect(result.blocksRemoved).toBe(1);
      const inboxFiles = fs.existsSync(path.join(box, 'inbox')) ? fs.readdirSync(path.join(box, 'inbox')) : [];
      expect(inboxFiles).toHaveLength(0);
      const consumed = fs.readdirSync(path.join(box, 'consumed'));
      expect(consumed).toHaveLength(1);
      const archived = JSON.parse(fs.readFileSync(path.join(box, 'consumed', consumed[0]), 'utf-8'));
      expect(archived.dropped).toBe('dead');
      expect(readBlock(blockIdForSession(BOX), feedDir)).toBeUndefined();
    } finally {
      process.env.AGENTS_FEED_DIR = previous;
    }
  });

  it('leaves live boxes alone', () => {
    const root = tmpRoot();
    const box = mailboxDir(BOX, root);
    enqueue(box, { to: BOX, text: 'alive' });

    const result = gcMailbox(new Set([BOX]), { root });

    expect(result.deadBoxes).toBe(0);
    expect(result.messagesDroppedDead).toBe(0);
    expect(fs.readdirSync(path.join(box, 'inbox'))).toHaveLength(1);
  });

  it('prunes old consumed entries', () => {
    const root = tmpRoot();
    const box = mailboxDir(BOX, root);
    enqueue(box, { to: BOX, text: 'old' });
    drain(box);
    // backdate the consumed file
    const consumedFile = path.join(box, 'consumed', fs.readdirSync(path.join(box, 'consumed'))[0]);
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(consumedFile, oldTime, oldTime);

    const result = gcMailbox(new Set([BOX]), { root, maxConsumedAgeMinutes: 1 });

    expect(result.consumedPruned).toBe(1);
    expect(fs.existsSync(consumedFile)).toBe(false);
  });
});
