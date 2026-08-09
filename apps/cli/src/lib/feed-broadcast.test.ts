import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Meta } from './types.js';
import { mailboxDir, peek } from './mailbox.js';
import {
  composeBroadcastMessage,
  effectiveBroadcastConfig,
  parseFeedPostLevel,
  planFeedBroadcast,
  renderSinkArgv,
  runFeedBroadcast,
  withDesktopNotify,
  DESKTOP_NOTIFY_SINK,
  type FeedBroadcastConfig,
  type FeedBroadcastContext,
} from './feed-broadcast.js';

const ctx = (over: Partial<FeedBroadcastContext> = {}): FeedBroadcastContext => ({
  title: 'CI green, merging',
  text: 'PR #1690 open, waiting on prix-cloud',
  level: 'milestone',
  project: 'agents-cli',
  agent: 'claude',
  host: 'yosemite-s1',
  session: 'c854ae60-0bde-4049-bc8a-0b9674aeabd0',
  ...over,
});

/** The config an operator would actually write for this stack. */
const CONFIG: FeedBroadcastConfig = {
  ticket: { command: ['linear', 'update', '{ticket}', '--comment', '{text}'] },
  message: { command: ['rush', 'message', 'send', '--text', '{message}'], minLevel: 'important' },
};

const metaEmpty = {} as Meta;

describe('feed post level', () => {
  it('defaults to milestone and accepts important', () => {
    expect(parseFeedPostLevel(undefined)).toBe('milestone');
    expect(parseFeedPostLevel('important')).toBe('important');
  });

  it('rejects an unknown level instead of silently downgrading it', () => {
    expect(() => parseFeedPostLevel('urgent')).toThrow(/Unknown --level 'urgent'/);
  });
});

describe('sink argv rendering', () => {
  it('substitutes every placeholder the post can supply', () => {
    const argv = renderSinkArgv(
      ['linear', 'update', '{ticket}', '--comment', '{project}: {text}'],
      ctx({ ticket: 'RUSH-2081' }),
    );
    expect(argv).toEqual([
      'linear', 'update', 'RUSH-2081',
      '--comment', 'agents-cli: PR #1690 open, waiting on prix-cloud',
    ]);
  });

  it('skips a template whose placeholder this post cannot fill', () => {
    // No ticket on the session — commenting on nothing is worse than not
    // commenting, so the sink does not run at all.
    expect(renderSinkArgv(['linear', 'update', '{ticket}', '--comment', '{text}'], ctx())).toBeUndefined();
  });

  it('keeps post text as one argv element, never shell syntax', () => {
    const argv = renderSinkArgv(['echo', '{text}'], ctx({ text: 'done; rm -rf / && echo pwned' }));
    expect(argv).toEqual(['echo', 'done; rm -rf / && echo pwned']);
  });
});

describe('message composition', () => {
  it('title, blank line, body, Sent from footer, then link', () => {
    expect(composeBroadcastMessage(ctx({ links: ['https://github.com/phnx-labs/agents-cli/pull/1690'] })))
      .toBe(
        'CI green, merging\n' +
          '\n' +
          'PR #1690 open, waiting on prix-cloud\n' +
          '\n' +
          'Sent from claude/c854ae60 on yosemite-s1\n' +
          'https://github.com/phnx-labs/agents-cli/pull/1690',
      );
  });

  it('scrubs em-dashes from title and body', () => {
    const msg = composeBroadcastMessage(
      ctx({
        title: 'Halfway done — CI',
        text: 'watching merge — then ship',
        agent: 'grok',
        host: 'mac-mini',
        session: 'a02da0e2-a8c0-455f-95c3-12f75f16579f',
      }),
    );
    expect(msg).not.toMatch(/\u2014|\u2013/);
    expect(msg).toContain('Halfway done - CI');
    expect(msg).toContain('watching merge - then ship');
    expect(msg).toContain('Sent from grok/a02da0e2 on mac-mini');
  });

  it('falls back to body-only when there is no title', () => {
    expect(
      composeBroadcastMessage(
        ctx({ title: undefined, text: 'legacy body only', agent: undefined, host: undefined, session: undefined }),
      ),
    ).toBe('legacy body only');
  });

  it('footer skips the uninformative default agent label', () => {
    const msg = composeBroadcastMessage(
      ctx({ agent: 'agent', host: 'mac-mini', session: 'aabbccdd-1111-2222-3333-444444444444' }),
    );
    expect(msg).toContain('Sent from aabbccdd on mac-mini');
    expect(msg).not.toContain('Sent from agent/');
  });

  it('does NOT put the focus CLI command in the phone message (unusable from a phone)', () => {
    const msg = composeBroadcastMessage(
      ctx({
        focus: 'agents focus c854ae60',
        links: ['https://example.com/p'],
      }),
    );
    expect(msg).toBe(
      'CI green, merging\n' +
        '\n' +
        'PR #1690 open, waiting on prix-cloud\n' +
        '\n' +
        'Sent from claude/c854ae60 on yosemite-s1\n' +
        'https://example.com/p',
    );
    expect(msg).not.toContain('agents focus');
  });

  it('renders options + default as the phone-actionable reply for a block', () => {
    const msg = composeBroadcastMessage(
      ctx({ options: ['publish', 'wait'], safeDefault: 'wait', timeoutMinutes: 15 }),
    );
    expect(msg).toContain('Options: publish / wait');
    expect(msg).toContain('Default in 15 min: wait');
    expect(msg).not.toContain('agents focus');
  });

  it('truncates a many-line body to a phone excerpt, keeping the title', () => {
    const wall = Array.from({ length: 18 }, (_, i) => `line ${i + 1} of the session summary`).join('\n');
    const msg = composeBroadcastMessage(ctx({ title: 'Session summary', text: wall }));
    expect(msg).toContain('Session summary'); // title (headline) preserved
    expect(msg).toContain('line 1 of the session summary');
    expect(msg).toContain('line 8 of the session summary');
    expect(msg).not.toContain('line 9 of the session summary'); // capped at 8 body lines
    expect(msg).toContain('… (full in feed)'); // plain pointer, not a CLI command
    expect(msg).not.toContain('agents focus');
  });

  it('truncates a very long single-line body by character count', () => {
    const wall = 'x'.repeat(900);
    const msg = composeBroadcastMessage(ctx({ title: 'Big update', text: wall }));
    expect(msg).toContain('Big update');
    expect(msg).toContain('… (full in feed)');
    // The forwarded copy is far shorter than the 900-char body.
    expect(msg.length).toBeLessThan(700);
  });

  it('truncates a no-title long body too (body becomes the head)', () => {
    const wall = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join('\n');
    const msg = composeBroadcastMessage(
      ctx({ title: undefined, text: wall, agent: undefined, host: undefined, session: undefined }),
    );
    expect(msg).toContain('row 1');
    expect(msg).toContain('row 8');
    expect(msg).not.toContain('row 9');
    expect(msg).toContain('… (full in feed)');
  });

  it('leaves a short body untouched (no truncation marker)', () => {
    const msg = composeBroadcastMessage(ctx({ title: 'CI green', text: 'PR #1690 merged, no action.' }));
    expect(msg).toContain('PR #1690 merged, no action.');
    expect(msg).not.toContain('full in feed');
  });
});

describe('broadcast planning', () => {
  it('plans nothing when no sinks are configured', () => {
    expect(planFeedBroadcast(undefined, ctx())).toEqual([]);
    expect(planFeedBroadcast({}, ctx())).toEqual([]);
  });

  it('holds an important-only sink back from a routine post', () => {
    const planned = planFeedBroadcast(CONFIG, ctx({ ticket: 'RUSH-2081' }));
    expect(planned.map((p) => p.name)).toEqual(['ticket']);
  });

  it('reaches the messaging sink once the post is important', () => {
    const planned = planFeedBroadcast(CONFIG, ctx({ ticket: 'RUSH-2081', level: 'important' }));
    expect(planned.map((p) => p.name)).toEqual(['ticket', 'message']);
    expect(planned[1].argv[0]).toBe('rush');
    expect(planned[1].argv[3]).toBe('--text');
    expect(planned[1].argv[4]).toContain('CI green, merging');
    expect(planned[1].argv[4]).toContain('Sent from claude/c854ae60 on yosemite-s1');
  });

  it('ignores a malformed sink rather than crashing the post', () => {
    const planned = planFeedBroadcast(
      { broken: { command: [] }, ok: { command: ['true'] } } as FeedBroadcastConfig,
      ctx(),
    );
    expect(planned.map((p) => p.name)).toEqual(['ok']);
  });
});

describe('running sinks', () => {
  it.skipIf(process.platform === 'win32')('runs a real command and reports success', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-broadcast-'));
    const out = path.join(dir, 'sink.txt');
    const planned = planFeedBroadcast(
      { file: { command: ['sh', '-c', `printf '%s' "$1" > ${out}`, 'sh', '{text}'] } },
      ctx(),
    );
    expect(await runFeedBroadcast(planned, metaEmpty)).toEqual([{ name: 'file', ok: true }]);
    expect(fs.readFileSync(out, 'utf8')).toBe('PR #1690 open, waiting on prix-cloud');
  });

  it.skipIf(process.platform === 'win32')('reports a failing sink without throwing — the post already stands', async () => {
    const [outcome] = await runFeedBroadcast(
      [{ name: 'nope', argv: ['sh', '-c', 'echo boom >&2; exit 3'] }],
      metaEmpty,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('boom');
  });

  it('reports a sink whose program is not installed', async () => {
    const [outcome] = await runFeedBroadcast(
      [{ name: 'missing', argv: ['agents-cli-no-such-binary-42', 'x'] }],
      metaEmpty,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/ENOENT|not found|spawnSync/i);
  });
});

describe('channel sink planning', () => {
  it('plans the owner alias without requiring `to`', () => {
    const planned = planFeedBroadcast({ owner: { channel: 'owner' } }, ctx());
    expect(planned).toEqual([
      { name: 'owner', channel: 'owner', to: undefined, text: composeBroadcastMessage(ctx()) },
    ]);
  });

  it('skips a non-owner channel sink with no recipient rather than sending with a hole in it', () => {
    expect(planFeedBroadcast({ tg: { channel: 'telegram' } }, ctx())).toEqual([]);
  });

  it('plans an explicit channel + recipient', () => {
    const planned = planFeedBroadcast({ tg: { channel: 'telegram', to: '12345' } }, ctx());
    expect(planned).toEqual([
      { name: 'tg', channel: 'telegram', to: '12345', text: composeBroadcastMessage(ctx()) },
    ]);
  });

  it('gates a channel sink by minLevel exactly like a command sink', () => {
    const config: FeedBroadcastConfig = { owner: { channel: 'owner', minLevel: 'important' } };
    expect(planFeedBroadcast(config, ctx())).toEqual([]);
    expect(planFeedBroadcast(config, ctx({ level: 'important' })).map((p) => p.name)).toEqual(['owner']);
  });
});

describe('effectiveBroadcastConfig — the implicit owner fallback', () => {
  const ownerMeta = { notify: { owner: { channel: 'mailbox', to: 'agents-feed-fallback-test' } } } as Meta;

  it('falls back to notify.owner when feed.broadcast is unset/empty and the post is important', () => {
    expect(effectiveBroadcastConfig(undefined, 'important', ownerMeta)).toEqual({ owner: { channel: 'owner' } });
    expect(effectiveBroadcastConfig({}, 'important', ownerMeta)).toEqual({ owner: { channel: 'owner' } });
  });

  it('stays record-only for a routine milestone post even with notify.owner configured', () => {
    expect(effectiveBroadcastConfig(undefined, 'milestone', ownerMeta)).toBeUndefined();
  });

  it('does not fall back when notify.owner is not configured either', () => {
    expect(effectiveBroadcastConfig(undefined, 'important', metaEmpty)).toBeUndefined();
  });

  it('never layers on top of an operator-declared feed.broadcast — the config always wins outright', () => {
    expect(effectiveBroadcastConfig(CONFIG, 'important', ownerMeta)).toBe(CONFIG);
  });
});

describe('withDesktopNotify — feed post --notify', () => {
  const desktopSink = { channel: 'desktop', to: 'local' };

  it('is a no-op when --notify is off — returns the config unchanged, undefined included', () => {
    expect(withDesktopNotify(undefined, false)).toBeUndefined();
    expect(withDesktopNotify(CONFIG, false)).toBe(CONFIG);
  });

  it('adds a desktop sink from nothing when the post has no other broadcast', () => {
    expect(withDesktopNotify(undefined, true)).toEqual({ [DESKTOP_NOTIFY_SINK]: desktopSink });
  });

  it('layers the desktop sink ON TOP of configured sinks — never replaces them', () => {
    const merged = withDesktopNotify(CONFIG, true);
    expect(merged).toEqual({ ...CONFIG, [DESKTOP_NOTIFY_SINK]: desktopSink });
    // The operator's own sinks survive intact.
    expect(merged?.ticket).toEqual(CONFIG.ticket);
    expect(merged?.message).toEqual(CONFIG.message);
  });

  it('never clobbers an operator sink that shares the reserved name — both fire', () => {
    const operatorNotify = { command: ['my-notifier', '{message}'] };
    const merged = withDesktopNotify({ [DESKTOP_NOTIFY_SINK]: operatorNotify }, true);
    // The operator's `notify` sink is untouched; the banner lands under `notify-2`.
    expect(merged?.[DESKTOP_NOTIFY_SINK]).toEqual(operatorNotify);
    expect(merged?.[`${DESKTOP_NOTIFY_SINK}-2`]).toEqual(desktopSink);
  });

  it('fires on a milestone post — the desktop banner carries no minLevel, so it plans at any level', () => {
    const planned = planFeedBroadcast(withDesktopNotify(undefined, true), ctx({ level: 'milestone' }));
    expect(planned.map((p) => p.name)).toEqual([DESKTOP_NOTIFY_SINK]);
    expect(planned[0]).toMatchObject({ channel: 'desktop', to: 'local' });
    expect(planned[0].text).toBe(composeBroadcastMessage(ctx({ level: 'milestone' })));
  });

  it('banners locally without buzzing the phone on a milestone — the important-gated owner sink stays skipped', () => {
    // An operator with an important-only phone sink, plus --notify on a milestone.
    const config = withDesktopNotify(
      { phone: { channel: 'mailbox', to: 'x', minLevel: 'important' } },
      true,
    );
    const planned = planFeedBroadcast(config, ctx({ level: 'milestone' }));
    // Only the desktop banner plans; the phone sink is gated out at milestone.
    expect(planned.map((p) => p.name)).toEqual([DESKTOP_NOTIFY_SINK]);
  });
});

describe('channel delivery — real provider registry, no mocking', () => {
  // Unique throwaway mailbox box in the real spool (repo rule: real services,
  // no mocking — same pattern as channels/providers/mailbox.test.ts).
  const BOX = `agents-feed-broadcast-test-${process.pid}`;

  afterEach(() => {
    try {
      fs.rmSync(mailboxDir(BOX), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('delivers an owner-alias channel sink through the real mailbox provider', async () => {
    const meta = { notify: { owner: { channel: 'mailbox', to: BOX } } } as Meta;
    const postCtx = ctx({ level: 'important' });
    const planned = planFeedBroadcast({ owner: { channel: 'owner' } }, postCtx);
    const outcomes = await runFeedBroadcast(planned, meta);
    expect(outcomes).toEqual([{ name: 'owner', ok: true }]);

    const pending = peek(mailboxDir(BOX), BOX);
    expect(pending.map((m) => m.text)).toContain(composeBroadcastMessage(postCtx));
  });

  // RUSH-2123: before effectiveBroadcastConfig, this exact scenario
  // (notify.owner set, feed.broadcast never written) returned [] from
  // broadcastBlock and the block reached nobody, even though blockDeliveryFailure
  // would have reported it undelivered — nothing in the outbound stack knew
  // notify.owner existed. Now it delivers.
  it('was silent before RUSH-2123: --blocked with notify.owner set and no feed.broadcast now delivers', async () => {
    const meta = { notify: { owner: { channel: 'mailbox', to: BOX } } } as Meta;
    const postCtx = ctx({ level: 'important' });
    const config = effectiveBroadcastConfig(undefined, 'important', meta);
    expect(config).toBeDefined();

    const outcomes = await runFeedBroadcast(planFeedBroadcast(config!, postCtx), meta);
    expect(outcomes).toEqual([{ name: 'owner', ok: true }]);
    expect(peek(mailboxDir(BOX), BOX)).toHaveLength(1);
  });

  it('reports an unregistered channel provider without throwing — a bad config must not kill the fan-out', async () => {
    const planned = planFeedBroadcast(
      { tg: { channel: 'not-a-real-channel-42', to: 'x' } },
      ctx({ level: 'important' }),
    );
    const outcomes = await runFeedBroadcast(planned, metaEmpty);
    expect(outcomes).toEqual([
      { name: 'tg', ok: false, error: expect.stringContaining('No channel provider') },
    ]);
  });
});
