import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import {
  metaFromActive,
  selectFallback,
  mergeFocusHosts,
  focusHeader,
  tmuxAttachScript,
  planFocusSurface,
  openFocusTabs,
  isAttachableLiveSession,
  inheritFocusOptions,
} from './focus.js';
import { refuseFallback } from './go.js';
import type { ActiveSession } from '../lib/session/active.js';
import type { SurfaceItem, LaunchResult } from '../lib/terminal/index.js';

function s(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

describe('inheritFocusOptions — parent sessions flags reach focus', () => {
  it('inherits explicit overlapping flags without replacing child defaults', () => {
    const parent = new Command('sessions')
      .option('--device <target...>')
      .option('--active')
      .option('--orphan')
      .option('--limit <n>', '', '50')
      .option('--sort <field>');
    parent.parseOptions(['--device', 'yosemite-s0', '--active', '--orphan']);
    expect(inheritFocusOptions({ attachOnly: true, limit: '500', sort: 'recent' }, parent)).toMatchObject({
      attachOnly: true,
      device: ['yosemite-s0'],
      active: true,
      orphan: true,
      limit: '500',
      sort: 'recent',
    });
  });

  it('lets an explicitly provided parent limit override the child default', () => {
    const parent = new Command('sessions').option('--limit <n>', '', '50');
    parent.parseOptions(['--limit', '25']);
    expect(inheritFocusOptions({ limit: '500' }, parent).limit).toBe('25');
  });
});

/** Portable recovery command a focus tab can execute locally or over SSH. */
const localResume = (sess: ActiveSession): string[] => [
  'agents', 'run', 'auto', '--resume', sess.sessionId ?? '', '--interactive',
];

describe('selectFallback — --attach-only (old `go`) vs default resume', () => {
  it('--attach-only picks refuseFallback (attach or refuse, never fork)', () => {
    expect(selectFallback(true)).toBe(refuseFallback);
  });

  it('default (undefined/false) picks resume-in-new-tab, not refuseFallback', () => {
    expect(selectFallback(undefined)).not.toBe(refuseFallback);
    expect(selectFallback(false)).not.toBe(refuseFallback);
  });

  it('strict remote fallback refuses instead of opening a login shell', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.exitCode;
    process.exitCode = undefined;
    await refuseFallback(s({ sessionId: 'dead1234', machine: 'yosemite-s0' }), 'yosemite-s0');
    expect(log.mock.calls.flat().join('\n')).toContain('no living tmux pane');
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
    log.mockRestore();
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
  it('delegates every harness to centralized run --resume recovery', () => {
    for (const kind of ['claude', 'codex', 'opencode', 'grok', 'kimi']) {
      expect(localResume(s({ sessionId: 'abc12345', kind }))).toEqual([
        'agents', 'run', 'auto', '--resume', 'abc12345', '--interactive',
      ]);
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
    expect(script).toContain('#{pane_dead}');
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

  it('local rail-less (Ghostty, no tmux) → centralized recovery in the tab', () => {
    const plan = planFocusSurface(s({ machine: self, host: 'ghostty', sessionId: 'abc12345', kind: 'claude' }), self, localResume);
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command).toEqual(['agents', 'run', 'auto', '--resume', 'abc12345', '--interactive']);
    expect(plan.note).toContain('resume a copy');
  });

  it('remote rail-less → canonical resume resolves the owning peer', () => {
    const plan = planFocusSurface(s({ machine: 'yosemite-s0', sessionId: 'def67890', kind: 'claude' }), self, localResume);
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command.slice(0, 3)).toEqual(['ssh', '-tt', 'yosemite-s0']);
    expect(plan.command.join(' ')).toContain('run auto --resume def67890');
  });

  it('an indexed Grok session recovers through the universal /continue path', () => {
    const plan = planFocusSurface(s({ machine: self, host: 'terminal', sessionId: 'z1234567', kind: 'grok' }), self, localResume);
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command.join(' ')).toContain('run auto --resume z1234567');
  });

  it('a retained dead pane recovers instead of attaching', () => {
    const plan = planFocusSurface(
      s({ machine: self, sessionId: 'dead1234', provenance: { mux: { kind: 'tmux', pane: '%9' } } as never }),
      self,
      localResume,
      { state: 'dead', exitStatus: 0 },
    );
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command.join(' ')).toContain('--resume dead1234');
  });

  it('an id-less rail-less row is reported and skipped', () => {
    const plan = planFocusSurface(s({ machine: self, host: 'terminal', kind: 'grok' }), self, () => null);
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
    await openFocusTabs(targets, 'zion', {
      open,
      backend: 'tmux',
      metas: targets.map(metaFromActive),
      probe: async () => ({ state: 'missing' }),
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls[0].items).toHaveLength(2);
    // Tabs open locally (no host) — the remote join, when any, rides inside the command.
    expect(calls[0].opts.packing).toBe('tabs');
    expect(calls[0].opts.host).toBeUndefined();
    for (const command of calls[0].items.map((i) => i.command)) {
      expect(command.join(' ')).toContain('run auto --resume');
    }
  });

  it('remote tmux selections attach over SSH in each tab (the mockup path)', async () => {
    const { calls, open } = recorder();
    const targets = [
      s({ machine: 'yosemite-s0', sessionId: 'r1', provenance: { mux: { kind: 'tmux', pane: '%1' } } as never }),
      s({ machine: 'yosemite-s0', sessionId: 'r2', provenance: { mux: { kind: 'tmux', pane: '%2' } } as never }),
    ];
    await openFocusTabs(targets, 'zion', {
      open,
      backend: 'tmux',
      metas: targets.map(metaFromActive),
      probe: async () => ({ state: 'alive' }),
    });
    expect(calls[0].items).toHaveLength(2);
    for (const it of calls[0].items) expect(it.command.slice(0, 3)).toEqual(['ssh', '-tt', 'yosemite-s0']);
  });

  it('rail-less Claude and Grok sessions both enter centralized recovery', async () => {
    const { calls, open } = recorder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const targets = [
      s({ machine: 'zion', host: 'terminal', sessionId: 'ok123456', kind: 'claude', cwd: '/tmp' }),
      s({ machine: 'zion', host: 'terminal', sessionId: 'no123456', kind: 'grok' }),
    ];
    await openFocusTabs(targets, 'zion', {
      open,
      backend: 'tmux',
      metas: targets.map(metaFromActive),
      probe: async () => ({ state: 'missing' }),
    });
    expect(calls[0].items).toHaveLength(2);
    expect(calls[0].items[0].command.join(' ')).toContain('--resume ok123456');
    expect(calls[0].items[1].command.join(' ')).toContain('--resume no123456');
    log.mockRestore();
  });

  it('--attach-only skips dead and missing panes instead of recovering them', async () => {
    const { calls, open } = recorder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const targets = [
      s({ machine: 'zion', sessionId: 'dead1234', provenance: { mux: { kind: 'tmux', pane: '%9' } } as never }),
      s({ machine: 'zion', sessionId: 'gone1234', host: 'terminal' }),
    ];
    await openFocusTabs(targets, 'zion', {
      open,
      backend: 'tmux',
      metas: targets.map(metaFromActive),
      attachOnly: true,
      probe: async (target) => target.sessionId === 'dead1234'
        ? { state: 'dead', exitStatus: 0 }
        : { state: 'missing' },
    });
    expect(calls).toHaveLength(0);
    expect(log.mock.calls.flat().join('\n')).toContain('Nothing to open');
    log.mockRestore();
  });
});
