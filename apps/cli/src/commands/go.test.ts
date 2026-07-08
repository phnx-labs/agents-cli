import { describe, it, expect } from 'vitest';
import { describeWhere, type Where } from './go.js';
import type { ActiveSession } from '../lib/session/active.js';

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
