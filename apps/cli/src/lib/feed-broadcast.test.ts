import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  composeBroadcastMessage,
  parseFeedPostLevel,
  planFeedBroadcast,
  renderSinkArgv,
  runFeedBroadcast,
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

  it('appends focus after the Sent from footer for blocks', () => {
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
        'agents focus c854ae60\n' +
        'https://example.com/p',
    );
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
  it.skipIf(process.platform === 'win32')('runs a real command and reports success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-broadcast-'));
    const out = path.join(dir, 'sink.txt');
    const planned = planFeedBroadcast(
      { file: { command: ['sh', '-c', `printf '%s' "$1" > ${out}`, 'sh', '{text}'] } },
      ctx(),
    );
    expect(runFeedBroadcast(planned)).toEqual([{ name: 'file', ok: true }]);
    expect(fs.readFileSync(out, 'utf8')).toBe('PR #1690 open, waiting on prix-cloud');
  });

  it.skipIf(process.platform === 'win32')('reports a failing sink without throwing — the post already stands', () => {
    const [outcome] = runFeedBroadcast([{ name: 'nope', argv: ['sh', '-c', 'echo boom >&2; exit 3'] }]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('boom');
  });

  it('reports a sink whose program is not installed', () => {
    const [outcome] = runFeedBroadcast([
      { name: 'missing', argv: ['agents-cli-no-such-binary-42', 'x'] },
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/ENOENT|not found|spawnSync/i);
  });
});
