import { describe, expect, it } from 'vitest';
import type { OpenBlock } from '../lib/feed.js';
import {
  mergeFeedBlocks,
  parseRemoteFeed,
  remoteFeedHostsToDial,
  shouldIncludeLocalFeed,
} from './feed.js';

function block(id: string, host: string, ts: string): OpenBlock {
  return {
    blockId: `block-${id}`,
    sessionId: id,
    mailboxId: id,
    host,
    runtime: 'headless',
    ts,
    questions: [{ text: `${id}?` }],
  };
}

describe('parseRemoteFeed', () => {
  it('keeps valid blocks and stamps the source machine', () => {
    const parsed = parseRemoteFeed(JSON.stringify([
      block('one', 'untrusted-wire-host', '2026-07-13T00:00:00Z'),
      null,
      { blockId: 'broken' },
    ]), 'mac-mini');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].host).toBe('mac-mini');
    expect(parsed[0].sessionId).toBe('one');
  });

  it('returns an empty list for malformed peer output', () => {
    expect(parseRemoteFeed('login banner\n[]', 'mac-mini')).toEqual([]);
    expect(parseRemoteFeed('{}', 'mac-mini')).toEqual([]);
  });
});

describe('mergeFeedBlocks', () => {
  it('deduplicates a repeated host/session and sorts newest first', () => {
    const local = block('same', 'zion', '2026-07-13T00:00:00Z');
    const duplicate = { ...local, questions: [{ text: 'remote duplicate' }] };
    const newest = block('new', 'mac-mini', '2026-07-13T01:00:00Z');
    const merged = mergeFeedBlocks([local], [duplicate, newest]);
    expect(merged.map((item) => item.sessionId)).toEqual(['new', 'same']);
    expect(merged[1].questions[0].text).toBe('same?');
  });

  it('does not collapse the same session id on two different hosts', () => {
    expect(mergeFeedBlocks(
      [block('same', 'zion', '2026-07-13T00:00:00Z')],
      [block('same', 'mac-mini', '2026-07-13T00:00:00Z')],
    )).toHaveLength(2);
  });
});

describe('feed host scoping', () => {
  it('includes local by default and scopes explicit host lists', () => {
    expect(shouldIncludeLocalFeed(undefined, 'zion')).toBe(true);
    expect(shouldIncludeLocalFeed(['mac-mini'], 'zion')).toBe(false);
    expect(shouldIncludeLocalFeed(['muqsit@zion.tail.ts.net'], 'zion')).toBe(true);
  });

  it('dials every peer by default and removes self from explicit lists', () => {
    expect(remoteFeedHostsToDial(undefined, 'zion')).toBeUndefined();
    expect(remoteFeedHostsToDial(['zion', 'mac-mini'], 'zion')).toEqual(['mac-mini']);
  });
});
