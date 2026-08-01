import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import type { OpenBlock } from '../lib/feed.js';
import {
  controlFeedSession,
  formatFeedMastheadRight,
  formatFeedReplyHint,
  formatOutcomeHeader,
  mergeFeedBlocks,
  parseRemoteFeed,
  prepareLocalFeedBlocks,
  remoteFeedHostsToDial,
  sessionHintsFromActive,
  shouldIncludeLocalFeed,
} from './feed.js';
import { groupBlocksByOutcome } from '../lib/feed-outcome.js';
import { GLYPH } from '../lib/comms-render.js';
import { formatActivityLine } from '../lib/activity.js';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

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

  it('drops blocks whose mailboxId is not a safe path segment', () => {
    const valid = block('ok', 'peer', '2026-07-13T00:00:00Z');
    const crafted = { ...block('evil', 'peer', '2026-07-13T00:00:00Z'), mailboxId: '../../etc/passwd' };
    const dotdot = { ...block('dots', 'peer', '2026-07-13T00:00:00Z'), mailboxId: '..' };
    const parsed = parseRemoteFeed(JSON.stringify([valid, crafted, dotdot]), 'mac-mini');
    expect(parsed.map((b) => b.sessionId)).toEqual(['ok']);
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

describe('prepareLocalFeedBlocks', () => {
  it('does not apply suppression side effects when local feed is excluded', () => {
    const prepared = prepareLocalFeedBlocks([
      block('remote-stall', 'mac-mini', '2026-07-13T00:00:00Z', {
        questions: [{ text: 'Should I continue?' }],
      }),
    ], { includeLocal: false });

    expect(prepared.visible).toHaveLength(0);
    expect(prepared.dispatch).toEqual([]);
    expect(prepared.filter.suppressed[0]).toMatchObject({
      blockId: 'block-remote-stall',
      suppressed: false,
    });
  });

  it('keeps suppressed blocks visible in --all while dispatch ignores them', () => {
    const stall = block('stall-all', 'zion', '2026-07-13T00:00:00Z', {
      questions: [{ text: 'What next?' }],
    });

    const prepared = prepareLocalFeedBlocks([stall], { includeLocal: false, all: true });

    expect(prepared.visible.map((b) => b.sessionId)).toEqual(['stall-all']);
    expect(prepared.dispatch).toEqual([]);
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

describe('controlFeedSession', () => {
  it('kills a real local process by pid', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    children.push(child);
    expect(child.pid).toBeTypeOf('number');

    const result = await controlFeedSession('kill', 'runaway-agent', [{
      sessionId: 'session-runaway',
      mailboxId: 'runaway-agent',
      pid: child.pid,
      runtime: 'headless',
    }]);

    expect(result).toBe(`killed pid ${child.pid}`);
    await new Promise((resolve) => child.once('exit', resolve));
    // The process is dead either way; how the death is reported is
    // platform-specific. Windows has no POSIX signals — a terminated process
    // surfaces as an exit code with signalCode null, so only assert the
    // SIGTERM shape where signals actually exist.
    if (process.platform === 'win32') {
      expect(child.exitCode).not.toBeNull();
    } else {
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe('SIGTERM');
    }
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

describe('formatActivityLine', () => {
  it('renders checklist milestone events', () => {
    const base = { v: 1, ts: new Date().toISOString(), sessionId: 's', mailboxId: 's', host: 'zion', runtime: 'headless' } as const;
    const taskCompleted = formatActivityLine({ ...base, event: 'task.completed', tier: 'milestone', agent: 'claude', detail: 'Write tests 2/3 done' });
    expect(taskCompleted).toContain('task completed');
    expect(taskCompleted).toContain('Write tests 2/3 done');

    const checklistCreated = formatActivityLine({ ...base, event: 'checklist.created', tier: 'milestone', agent: 'claude', detail: '3 tasks' });
    expect(checklistCreated).toContain('checklist created');
    expect(checklistCreated).toContain('3 tasks');
  });
});
