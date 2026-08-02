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
  text: 'PR #1690 open, CI green, merging',
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
      '--comment', 'agents-cli: PR #1690 open, CI green, merging',
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
  it('leads with the project and appends the link', () => {
    expect(composeBroadcastMessage(ctx({ links: ['https://github.com/phnx-labs/agents-cli/pull/1690'] })))
      .toBe('agents-cli · PR #1690 open, CI green, merging\nhttps://github.com/phnx-labs/agents-cli/pull/1690');
  });

  it('omits the link line when no URL is attached', () => {
    expect(composeBroadcastMessage(ctx())).toBe('agents-cli · PR #1690 open, CI green, merging');
  });

  it('ignores a local file attachment as a link target', () => {
    expect(composeBroadcastMessage(ctx({ links: [] }))).not.toContain('\n');
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
    expect(planned[1].argv).toEqual([
      'rush', 'message', 'send', '--text', 'agents-cli · PR #1690 open, CI green, merging',
    ]);
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
  it('runs a real command and reports success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-broadcast-'));
    const out = path.join(dir, 'sink.txt');
    const planned = planFeedBroadcast(
      { file: { command: ['sh', '-c', `printf '%s' "$1" > ${out}`, 'sh', '{text}'] } },
      ctx(),
    );
    expect(runFeedBroadcast(planned)).toEqual([{ name: 'file', ok: true }]);
    expect(fs.readFileSync(out, 'utf8')).toBe('PR #1690 open, CI green, merging');
  });

  it('reports a failing sink without throwing — the post already stands', () => {
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
