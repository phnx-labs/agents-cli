import { describe, it, expect } from 'vitest';
import { resolveViewingIn, itermTabFromSessionId, type ViewingInDeps } from './viewing-in.js';
import type { ActiveSession } from './active.js';
import type { TmuxClient } from '../tmux/session.js';
import type { GhosttySurface } from './ghostty-tabs.js';

/** A tmux-hosted active session whose pane maps to session `ag-claude-1`. */
function tmuxSession(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    host: 'tmux',
    status: 'running',
    sessionId: 'sess-abc',
    cwd: '/repo',
    provenance: {
      host: 'zion',
      transport: 'local',
      mux: { kind: 'tmux', socket: '/sock', pane: '%3' },
      reply: { rail: 'tmux', target: '%3', socket: '/sock' },
    },
    ...over,
  };
}

/** pane %3 belongs to session `ag-claude-1`, window 0, pane 0. */
const paneToTarget = new Map<string, string>([['%3', 'ag-claude-1:0.0']]);

function client(over: Partial<TmuxClient> = {}): TmuxClient {
  return { tty: '/dev/ttys004', pid: 4242, target: 'ag-claude-1:0.0', ...over };
}

describe('resolveViewingIn', () => {
  it('returns undefined for a non-tmux session', async () => {
    const s = tmuxSession({ provenance: { host: 'z', transport: 'local', reply: null } });
    expect(await resolveViewingIn(s, [client()], { paneToTarget })).toBeUndefined();
  });

  it('returns undefined (detached) when no client is attached to the session', async () => {
    const s = tmuxSession();
    // A client attached to a DIFFERENT session must not count as viewing this one.
    const other = client({ target: 'ag-codex-9:0.0' });
    expect(await resolveViewingIn(s, [other], { paneToTarget })).toBeUndefined();
  });

  it('names the host app of the attached client (no tab for a plain terminal)', async () => {
    const deps: ViewingInDeps = {
      paneToTarget,
      resolveApp: async () => 'iterm',
      readClientEnv: async () => ({}), // no ITERM_SESSION_ID -> no tab
    };
    const v = await resolveViewingIn(tmuxSession(), [client()], deps);
    expect(v).toEqual({ app: 'iterm', tab: undefined });
  });

  it('resolves the iTerm tab from the client ITERM_SESSION_ID', async () => {
    const deps: ViewingInDeps = {
      paneToTarget,
      resolveApp: async () => 'iterm',
      readClientEnv: async () => ({ ITERM_SESSION_ID: 'w0t2p0:UUID-XYZ' }),
    };
    const v = await resolveViewingIn(tmuxSession(), [client()], deps);
    // t2 is iTerm's 0-based tab index -> presented 1-based as tab 3.
    expect(v).toEqual({ app: 'iterm', tab: 3 });
  });

  it('resolves a Ghostty tab by cwd match against the surfaces', async () => {
    const surfaces: GhosttySurface[] = [
      { windowIndex: 1, tabIndex: 5, cwd: '/repo', title: 'claude' },
    ];
    const deps: ViewingInDeps = {
      paneToTarget,
      resolveApp: async () => 'ghostty',
      ghosttySurfaces: surfaces,
    };
    const v = await resolveViewingIn(tmuxSession(), [client()], deps);
    expect(v).toEqual({ app: 'ghostty', tab: 5 });
  });

  it('resolves a VS Code / Codium tab from the extension-published tabIndex', async () => {
    const deps: ViewingInDeps = {
      paneToTarget,
      resolveApp: async () => 'codium',
      tabIndexForSession: (id) => (id === 'sess-abc' ? 2 : undefined),
    };
    const v = await resolveViewingIn(tmuxSession(), [client()], deps);
    expect(v).toEqual({ app: 'codium', tab: 2 });
  });

  it('falls back to session.tmuxTarget when no paneToTarget is provided', async () => {
    const s = tmuxSession({ tmuxTarget: 'ag-claude-1:0.0' });
    const deps: ViewingInDeps = { resolveApp: async () => 'terminal', readClientEnv: async () => ({}) };
    const v = await resolveViewingIn(s, [client()], deps);
    expect(v?.app).toBe('terminal');
  });
});

describe('itermTabFromSessionId', () => {
  it('parses the t<n> field 1-based, tolerating the full w/t/p:UUID shape', () => {
    expect(itermTabFromSessionId('w0t0p0:ABC')).toBe(1);
    expect(itermTabFromSessionId('w1t4p2:ABC')).toBe(5);
  });
  it('returns undefined for empty or unparseable values', () => {
    expect(itermTabFromSessionId(undefined)).toBeUndefined();
    expect(itermTabFromSessionId('')).toBeUndefined();
    expect(itermTabFromSessionId('no-tab-here')).toBeUndefined();
  });
});
