import { describe, it, expect } from 'vitest';
import { injectTargetFromReplyRail } from './inject.js';
import type { ReplyRail } from './provenance.js';

describe('injectTargetFromReplyRail', () => {
  it('maps a tmux rail to a tmux InjectTarget, carrying the pane + socket', () => {
    const rail: ReplyRail = { rail: 'tmux', target: '%3', socket: '/tmp/srv.sock' };
    expect(injectTargetFromReplyRail(rail)).toEqual({ backend: 'tmux', pane: '%3', socket: '/tmp/srv.sock' });
  });

  it('carries an undefined socket through (tmux falls back to its default)', () => {
    const rail: ReplyRail = { rail: 'tmux', target: '%0' };
    expect(injectTargetFromReplyRail(rail)).toEqual({ backend: 'tmux', pane: '%0', socket: undefined });
  });

  it('yields null for a null rail (no addressable terminal today)', () => {
    expect(injectTargetFromReplyRail(null)).toBeNull();
  });
});
