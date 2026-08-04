import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { describeWhere, refuseFallback, type Where } from './go.js';
import type { ActiveSession } from '../lib/session/active.js';
import { NO_SHELL_FALLBACK_ENV, NO_ATTACH_RAIL_EXIT_CODE } from '../lib/hosts/reconnect.js';

const sshStreamMock = vi.hoisted(() => vi.fn(() => 0));
vi.mock('../lib/ssh-exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ssh-exec.js')>();
  return { ...actual, sshStream: sshStreamMock };
});

/** Minimal ActiveSession builder — only the fields describeWhere reads. */
function s(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

describe('describeWhere — which jump path a live session takes', () => {
  const self = 'zion';

  it('local tmux → attach its tmux, label carries the pane', () => {
    const w = describeWhere(s({ machine: self, provenance: { mux: { kind: 'tmux', pane: '%3' } } as never }), self);
    expect(w.label).toContain('%3');
    expect(w.action).toBe('attach its tmux');
  });

  it('remote tmux → ssh + attach on the host', () => {
    const w = describeWhere(s({ machine: 'yosemite-s0', provenance: { mux: { kind: 'tmux', pane: '%117' } } as never }), self);
    expect(w.label).toContain('yosemite-s0');
    expect(w.action).toContain('ssh');
    expect(w.action).toContain('yosemite-s0');
  });

  it('local Ghostty (no mux) → focus its tab', () => {
    const w = describeWhere(s({ machine: self, host: 'ghostty' }), self);
    expect(w.action).toBe('focus its Ghostty tab');
  });

  it('remote non-tmux → open a shell on the host', () => {
    const w = describeWhere(s({ machine: 'yosemite-s1', host: 'bash' }), self);
    expect(w.action).toContain('shell');
    expect(w.action).toContain('yosemite-s1');
  });

  it('local, no attach rail → refuse (resume)', () => {
    const w: Where = describeWhere(s({ machine: self, host: 'terminal' }), self);
    expect(w.action).toContain('resume');
  });

  it('remote tmux beats the host check (a remote ghostty-hosted session still ssh-attaches)', () => {
    const w = describeWhere(s({ machine: 'box', host: 'ghostty', provenance: { mux: { kind: 'tmux', pane: '%9' } } as never }), self);
    expect(w.action).toContain('ssh');
  });
});

describe('refuseFallback — remote, no attach rail', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);

  beforeEach(() => {
    sshStreamMock.mockClear();
    delete process.env[NO_SHELL_FALLBACK_ENV];
  });
  afterEach(() => {
    delete process.env[NO_SHELL_FALLBACK_ENV];
  });

  it('by default (a human running `sessions go`/`focus --attach-only`) opens a login shell on the remote', async () => {
    await expect(refuseFallback(s({}), 'yosemite-s1')).rejects.toThrow(/^exit:0$/);
    expect(sshStreamMock).toHaveBeenCalledTimes(1);
    expect(sshStreamMock.mock.calls[0][0]).toBe('yosemite-s1');
  });

  it('the regression this fixes: the automated reconnect loop sets NO_SHELL_FALLBACK_ENV=1, so no shell opens — reproduces the hairpin-into-a-third-host bug from the "attempt 1/6 forever" incident', async () => {
    process.env[NO_SHELL_FALLBACK_ENV] = '1';
    await expect(refuseFallback(s({}), 'yosemite-s1')).rejects.toThrow(`exit:${NO_ATTACH_RAIL_EXIT_CODE}`);
    // No shell was opened — the whole point: `reconnectStep` never sees this
    // refusal's exit code as SSH_CONN_FAILURE (255), so it treats a genuinely
    // unreachable session as a terminal state instead of retrying forever.
    expect(sshStreamMock).not.toHaveBeenCalled();
    expect(NO_ATTACH_RAIL_EXIT_CODE).not.toBe(255);
  });

  it('a strict "1" check, not a truthy one — an unrelated non-empty value (e.g. "0") must NOT trip the guard', async () => {
    // Every other env-var guard in the CLI compares strictly to '1' (e.g.
    // sessions.ts's `AGENTS_SESSIONS_LOCAL === '1'`). A bare truthy check on
    // process.env[VAR] would treat "0"/"false"/any set-but-wrong value as "on",
    // silently refusing instead of opening the human's shell.
    process.env[NO_SHELL_FALLBACK_ENV] = '0';
    await expect(refuseFallback(s({}), 'yosemite-s1')).rejects.toThrow(/^exit:0$/);
    expect(sshStreamMock).toHaveBeenCalledTimes(1);
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });
});
