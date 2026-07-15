import { describe, expect, it } from 'vitest';
import type { OpenBlock } from '../lib/feed.js';
import {
  formatFeedMastheadRight,
  formatFeedReplyHint,
  formatOutcomeHeader,
  mergeFeedBlocks,
  parseRemoteFeed,
  remoteFeedHostsToDial,
  sessionHintsFromActive,
  shouldIncludeLocalFeed,
} from './feed.js';
import { groupBlocksByOutcome } from '../lib/feed-outcome.js';
import { GLYPH } from '../lib/comms-render.js';

function block(id: string, host: string, ts: string, extra?: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: `block-${id}`,
    sessionId: id,
    mailboxId: id,
    host,
    runtime: 'headless',
    ts,
    questions: [{ text: `${id}?` }],
    ...extra,
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

describe('formatOutcomeHeader', () => {
  it('renders the rollup the operator sees at a glance', () => {
    const groups = groupBlocksByOutcome([
      block('a', 'zion', '2026-07-13T00:00:00Z', { ticket: 'RUSH-1125' }),
      block('b', 'zion', '2026-07-13T00:00:00Z', {
        ticket: 'RUSH-1125',
        answer: { answeredAt: 't', answeredFrom: 'cli' },
      }),
    ]);
    expect(formatOutcomeHeader(groups[0])).toBe('RUSH-1125 · 2 agents · 1 needs you · 1 answered');
  });
});

describe('formatFeedMastheadRight', () => {
  it('counts blocks and unique mailbox agents', () => {
    expect(formatFeedMastheadRight([
      block('a', 'zion', '2026-07-13T00:00:00Z'),
      block('b', 'zion', '2026-07-13T00:00:00Z'),
      block('a-again', 'zion', '2026-07-13T00:00:00Z', { mailboxId: 'a', sessionId: 'a-again', blockId: 'block-a-again' }),
    ])).toBe('3 blocks · 2 agents');
    expect(formatFeedMastheadRight([block('solo', 'zion', '2026-07-13T00:00:00Z')])).toBe('1 block · 1 agent');
  });
});

describe('formatFeedReplyHint', () => {
  it('matches the shared fleet-comms reply line (↳ ag message …)', () => {
    expect(formatFeedReplyHint('agent-1')).toBe(`↳ ag message agent-1 "…"`);
    expect(formatFeedReplyHint('agent-1').startsWith('↳')).toBe(true);
    expect(GLYPH.ask).toBe('▲');
    expect(GLYPH.delivered).toBe('✓');
  });
});

describe('sessionHintsFromActive', () => {
  it('maps session ticket/PR/worktree into enrichment hints', () => {
    const hints = sessionHintsFromActive([
      {
        sessionId: 'sess-1',
        agentId: 'agent-1',
        ticket: { id: 'RUSH-9' },
        pr: { number: 12, url: 'https://github.com/x/y/pull/12' },
        worktree: { slug: 'rush-9-fix' },
      },
    ]);
    expect(hints[0]).toMatchObject({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      mailboxId: 'agent-1',
      ticketId: 'RUSH-9',
      prNumber: 12,
      worktreeSlug: 'rush-9-fix',
    });
  });
});
