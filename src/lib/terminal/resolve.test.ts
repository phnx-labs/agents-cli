/**
 * Tests for the inject-target resolver (RUSH-1415) — the safety choke point.
 *
 * `resolveInjectTargetForSession` is PURE (takes an ActiveSession, returns a
 * resolution), so the whole tmux > iterm > vscodium > pty precedence and the
 * Ghostty refusal are asserted here without touching the process table. The
 * fixtures mirror what active.ts produces: provenance (env-derived rails) + host
 * (detectHost) + sessionId.
 */
import { describe, it, expect } from 'vitest';
import type { ActiveSession } from '../session/active.js';
import type { SessionProvenance, ReplyRail, MuxLocation } from '../session/provenance.js';
import { resolveInjectTargetForSession } from './resolve.js';

/** Minimal ActiveSession with the fields the resolver reads. */
function session(over: {
  sessionId?: string;
  host?: string;
  mux?: MuxLocation;
  reply?: ReplyRail;
}): ActiveSession {
  const provenance: SessionProvenance = {
    host: 'zion',
    transport: 'local',
    mux: over.mux,
    reply: over.reply ?? null,
  };
  return {
    context: 'terminal',
    kind: 'claude',
    host: over.host,
    sessionId: over.sessionId,
    status: 'idle',
    provenance,
  };
}

describe('resolveInjectTargetForSession — tmux (highest precedence)', () => {
  it('resolves a tmux pane regardless of host app', () => {
    const r = resolveInjectTargetForSession(
      session({ host: 'iterm', mux: { kind: 'tmux', pane: '%3', socket: '/tmp/s' }, reply: { rail: 'tmux', target: '%3', socket: '/tmp/s' } }),
    );
    expect(r).toEqual({ addressable: true, rail: 'tmux', target: { backend: 'tmux', pane: '%3', socket: '/tmp/s' } });
  });

  it('tmux wins even when the session is IDE-hosted (works inside VS Code)', () => {
    const r = resolveInjectTargetForSession(
      session({ host: 'codium', sessionId: 'abc', mux: { kind: 'tmux', pane: '%1' }, reply: { rail: 'tmux', target: '%1' } }),
    );
    expect(r.addressable).toBe(true);
    if (r.addressable) expect(r.rail).toBe('tmux');
  });
});

describe('resolveInjectTargetForSession — iterm', () => {
  it('resolves the exact iTerm split by session UUID from the env rail', () => {
    const r = resolveInjectTargetForSession(session({ host: 'iterm', reply: { rail: 'iterm', session: 'UUID-1' } }));
    expect(r).toEqual({ addressable: true, rail: 'iterm', target: { backend: 'iterm', session: 'UUID-1' } });
  });
});

describe('resolveInjectTargetForSession — vscodium', () => {
  it('resolves a codium integrated terminal to the editor CLI + scheme, id = sessionId', () => {
    const r = resolveInjectTargetForSession(session({ host: 'codium', sessionId: 'sess-9' }));
    expect(r).toEqual({
      addressable: true,
      rail: 'vscodium',
      target: { backend: 'vscodium', terminalId: 'sess-9', cli: 'codium', scheme: 'vscodium' },
    });
  });

  it('maps cursor and code hosts to their CLI/scheme', () => {
    const cur = resolveInjectTargetForSession(session({ host: 'cursor', sessionId: 's' }));
    const code = resolveInjectTargetForSession(session({ host: 'code', sessionId: 's' }));
    expect(cur.addressable && cur.target).toMatchObject({ cli: 'cursor', scheme: 'cursor' });
    expect(code.addressable && code.target).toMatchObject({ cli: 'code', scheme: 'vscode' });
  });

  it('refuses an IDE terminal with no session id (nothing to address) rather than guessing', () => {
    const r = resolveInjectTargetForSession(session({ host: 'codium' }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('no session id');
  });
});

describe('resolveInjectTargetForSession — ghostty (honest degradation)', () => {
  it('refuses a Ghostty session with no tmux by default (watchdog skips)', () => {
    const r = resolveInjectTargetForSession(session({ host: 'ghostty', sessionId: 's' }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('un-addressable (ghostty');
  });

  it('emits the coarse window path only under the explicit opt-in, with a not-precise note', () => {
    const r = resolveInjectTargetForSession(session({ host: 'ghostty', sessionId: 's' }), { allowGhosttyFocus: true });
    expect(r.addressable).toBe(true);
    if (r.addressable) {
      expect(r.rail).toBe('ghostty');
      expect(r.target).toEqual({ backend: 'ghostty' });
      expect(r.note).toContain('not split-precise');
    }
  });

  it('a Ghostty session INSIDE tmux is still tmux-addressable (tmux precedence beats the refusal)', () => {
    const r = resolveInjectTargetForSession(
      session({ host: 'ghostty', mux: { kind: 'tmux', pane: '%2' }, reply: { rail: 'tmux', target: '%2' } }),
    );
    expect(r.addressable).toBe(true);
    if (r.addressable) expect(r.rail).toBe('tmux');
  });
});

describe('resolveInjectTargetForSession — pty + refusals', () => {
  it('emits pty only when a sidecar id is supplied (lowest precedence)', () => {
    const r = resolveInjectTargetForSession(session({ host: undefined }), { ptyId: 'pty-7' });
    expect(r).toEqual({ addressable: true, rail: 'pty', target: { backend: 'pty', id: 'pty-7' } });
  });

  it('refuses with an honest reason when no rail exists', () => {
    const r = resolveInjectTargetForSession(session({ host: undefined }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('not inside tmux');
  });

  it('names an unrecognised host in the refusal reason', () => {
    const r = resolveInjectTargetForSession(session({ host: 'warp' }));
    expect(r.addressable).toBe(false);
    if (!r.addressable) expect(r.reason).toContain('warp');
  });
});
