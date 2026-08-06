import { describe, it, expect, vi } from 'vitest';
import {
  metaFromActive,
  selectFallback,
  mergeFocusHosts,
  focusHeader,
  tmuxAttachScript,
  planFocusSurface,
  openFocusTabs,
  isAttachableLiveSession,
} from './focus.js';
import { refuseFallback } from './go.js';
import { buildCanonicalResumeCommand } from '../lib/session/resume-command.js';
import type { ActiveSession } from '../lib/session/active.js';
import type { SurfaceItem, LaunchResult } from '../lib/terminal/index.js';

function s(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

/** The local version-pinned resume command a `focus` tab would run (rail-less fallback). */
const localResume = (sess: ActiveSession): string[] | null =>
  sess.sessionId ? buildCanonicalResumeCommand(sess.sessionId) : null;

describe('selectFallback — --attach-only (old `go`) vs default resume', () => {
  it('--attach-only picks refuseFallback (attach or refuse, never fork)', () => {
    expect(selectFallback(true)).toBe(refuseFallback);
  });

  it('default (undefined/false) picks resume-in-new-tab, not refuseFallback', () => {
    expect(selectFallback(undefined)).not.toBe(refuseFallback);
    expect(selectFallback(false)).not.toBe(refuseFallback);
  });
});

describe('metaFromActive — the resume fallback input', () => {
  it('carries id, short id, agent, and cwd through', () => {
    const m = metaFromActive(s({ sessionId: '019e30a2-cd76-7702', kind: 'codex', cwd: '/tmp/x' }));
    expect(m.id).toBe('019e30a2-cd76-7702');
    expect(m.shortId).toBe('019e30a2');
    expect(m.agent).toBe('codex');
    expect(m.cwd).toBe('/tmp/x');
  });

  it('missing session id degrades to "-" short id, empty id', () => {
    const m = metaFromActive(s({}));
    expect(m.shortId).toBe('-');
    expect(m.id).toBe('');
  });
});

describe('focus resume-in-a-tab command', () => {
  it('delegates every harness to the canonical agents resume command', () => {
    for (const kind of ['claude', 'codex', 'opencode', 'grok', 'kimi']) {
      expect(localResume(s({ sessionId: 'abc12345', kind }))).toEqual(['agents', 'resume', 'abc12345']);
    }
  });
});

describe('isAttachableLiveSession', () => {
  it('rejects retained panes whose process exited', () => {
    expect(isAttachableLiveSession(s({ pidAlive: false, status: 'closed' }))).toBe(false);
    expect(isAttachableLiveSession(s({ pidAlive: false, status: 'crashed' }))).toBe(false);
  });

  it('accepts a running live pane', () => {
    expect(isAttachableLiveSession(s({ pidAlive: true, status: 'running' }))).toBe(true);
  });
});

describe('mergeFocusHosts — --device is an alias of --host, both repeatable', () => {
  it('unions --host and --device into one list', () => {
    expect(mergeFocusHosts({ host: ['a'], device: ['b', 'c'] })).toEqual(['a', 'b', 'c']);
  });
  it('empty when neither is set (bare focus)', () => {
    expect(mergeFocusHosts({})).toEqual([]);
  });
});

describe('focusHeader — reflects the filter + device', () => {
  it('status + device → "Focus orphaned sessions on <host>:"', () => {
    expect(focusHeader(['orphaned'], ['yosemite-s0'])).toBe('Focus orphaned sessions on yosemite-s0:');
  });
  it('status only', () => {
    expect(focusHeader(['working'], [])).toBe('Focus working sessions:');
  });
  it('no filter, no device → the original bare header', () => {
    expect(focusHeader([], [])).toBe('Focus a live session:');
  });
});

describe('tmuxAttachScript — resolve pane → attach (join, no fork)', () => {
  it('attaches the pane, defaulting to the pane id if the session lookup is empty', () => {
    const script = tmuxAttachScript({ pane: '%3' });
    expect(script).toContain('attach-session');
    expect(script).toContain('%3');
  });
  it('threads the socket flag when the pane lives on a non-default socket', () => {
    expect(tmuxAttachScript({ socket: '/tmp/tmux-1/agents', pane: '%9' })).toContain('-S');
  });
});

describe('planFocusSurface — attach a live pane, or resume a copy (never a silent drop)', () => {
  const self = 'zion';

  it('local tmux → sh -c that attaches the live pane (a second client, no fork)', () => {
    const plan = planFocusSurface(s({ machine: self, provenance: { mux: { kind: 'tmux', pane: '%3' } } as never }), self, localResume);
    expect(plan.kind).toBe('attach');
    if (plan.kind !== 'attach') return;
    expect(plan.command[0]).toBe('sh');
    expect(plan.command.join(' ')).toContain('attach-session');
    expect(plan.note).toContain('%3');
  });

  it('remote tmux → ssh -tt <host> attaching the peer pane over SSH', () => {
    const plan = planFocusSurface(s({ machine: 'yosemite-s0', provenance: { mux: { kind: 'tmux', pane: '%117' } } as never }), self, localResume);
    expect(plan.kind).toBe('attach');
    if (plan.kind !== 'attach') return;
    expect(plan.command.slice(0, 3)).toEqual(['ssh', '-tt', 'yosemite-s0']);
    expect(plan.note).toContain('yosemite-s0');
  });

  it('local rail-less (Ghostty, no tmux) → resume a copy in the tab, version-pinned', () => {
    const plan = planFocusSurface(s({ machine: self, host: 'ghostty', sessionId: 'abc12345', kind: 'claude' }), self, localResume);
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command).toEqual(['agents', 'resume', 'abc12345']);
    expect(plan.note).toContain('resume a copy');
  });

  it('remote rail-less → canonical resume resolves the owning peer', () => {
    const plan = planFocusSurface(s({ machine: 'yosemite-s0', sessionId: 'def67890', kind: 'claude' }), self, localResume);
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command).toEqual(['agents', 'resume', 'def67890']);
  });

  it('an id-less rail-less row → skip, reported (not dropped)', () => {
    const plan = planFocusSurface(s({ machine: self, host: 'terminal', kind: 'grok' }), self, localResume);
    expect(plan.kind).toBe('skip');
    if (plan.kind !== 'skip') return;
    expect(plan.note).toContain('grok');
  });
});

describe('openFocusTabs — N selected sessions → N tab requests through the engine', () => {
  /** Record every openSurfaces call so the engine boundary is asserted, not mocked away. */
  function recorder() {
    const calls: Array<{ items: SurfaceItem[]; opts: { backend: string; host?: string; packing?: string } }> = [];
    const open = vi.fn(async (items: SurfaceItem[], opts: never): Promise<LaunchResult[]> => {
      calls.push({ items, opts: opts as { backend: string; host?: string; packing?: string } });
      return items.map((it) => ({ ok: true, request: { backend: 'tmux', layout: 'tab', cwd: it.cwd, command: it.command } })) as LaunchResult[];
    });
    return { calls, open };
  }

  it('opens each selected session as its own tab (layout+host asserted)', async () => {
    const { calls, open } = recorder();
    const targets = [
      s({ machine: 'zion', sessionId: 'aaaa1111', kind: 'claude', cwd: '/tmp' }),
      s({ machine: 'zion', sessionId: 'bbbb2222', kind: 'claude', cwd: '/tmp' }),
    ];
    await openFocusTabs(targets, 'zion', { open, backend: 'tmux' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls[0].items).toHaveLength(2);
    // Tabs open locally (no host) — the remote join, when any, rides inside the command.
    expect(calls[0].opts.packing).toBe('tabs');
    expect(calls[0].opts.host).toBeUndefined();
    expect(calls[0].items.map((i) => i.command)).toEqual([
      ['agents', 'resume', 'aaaa1111'],
      ['agents', 'resume', 'bbbb2222'],
    ]);
  });

  it('remote tmux selections attach over SSH in each tab (the mockup path)', async () => {
    const { calls, open } = recorder();
    const targets = [
      s({ machine: 'yosemite-s0', sessionId: 'r1', provenance: { mux: { kind: 'tmux', pane: '%1' } } as never }),
      s({ machine: 'yosemite-s0', sessionId: 'r2', provenance: { mux: { kind: 'tmux', pane: '%2' } } as never }),
    ];
    await openFocusTabs(targets, 'zion', { open, backend: 'tmux' });
    expect(calls[0].items).toHaveLength(2);
    for (const it of calls[0].items) expect(it.command.slice(0, 3)).toEqual(['ssh', '-tt', 'yosemite-s0']);
  });

  it('a rail-less id-less row is reported and skipped, never fed to the engine as a broken tab', async () => {
    const { calls, open } = recorder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const targets = [
      s({ machine: 'zion', host: 'terminal', sessionId: 'ok123456', kind: 'claude', cwd: '/tmp' }),
      s({ machine: 'zion', host: 'terminal', kind: 'grok' }),
    ];
    await openFocusTabs(targets, 'zion', { open, backend: 'tmux' });
    // Only the resumable one reaches the engine; the grok one is reported (skip line), not dropped silently.
    expect(calls[0].items.map((i) => i.command)).toEqual([['agents', 'resume', 'ok123456']]);
    expect(log.mock.calls.flat().join('\n')).toContain('skip');
    log.mockRestore();
  });
});
