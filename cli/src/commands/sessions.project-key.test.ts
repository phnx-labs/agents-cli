/**
 * RUSH-2688 — the single project/group key derivation for an active session row.
 *
 * A session must group under a real project, never under its harness name
 * ('codex') or the machine it runs on. The regression: a Codex cloud task with
 * no local cwd (repo === null, provider === 'codex') surfaced in the menubar
 * under a 'codex' group. `activeSessionProjectKey` is the one place that rule
 * lives, so these pin it: a cwd → its basename; a cloud row with no cwd → the
 * explicit 'cloud' bucket; any other cwd-less row → 'other'; never the harness.
 */

import { describe, it, expect } from 'vitest';

import { activeSessionProjectKey } from './sessions.js';
import type { ActiveSession } from '../lib/session/active.js';

function s(overrides: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...overrides };
}

describe('activeSessionProjectKey', () => {
  it('a normal repo session groups under its repo basename', () => {
    expect(activeSessionProjectKey(s({ cwd: '/home/me/repos/agents-cli' }))).toBe('agents-cli');
  });

  it('routes a cloud session with no local cwd to the explicit "cloud" bucket', () => {
    // The exact shape that leaked: a queued Codex cloud task, repo unknown, so
    // no cwd — it must NOT borrow the harness/provider name as its group.
    const key = activeSessionProjectKey(s({ context: 'cloud', kind: 'codex', cwd: undefined }));
    expect(key).toBe('cloud');
    expect(key).not.toBe('codex');
  });

  it('routes any other cwd-less row to the single "other" bucket, not its harness', () => {
    const key = activeSessionProjectKey(s({ context: 'headless', kind: 'codex', cwd: undefined }));
    expect(key).toBe('other');
    expect(key).not.toBe('codex');
  });

  it('is worktree-agnostic: a cwd inside a worktree still yields a repo-shaped key', () => {
    // basename of the leaf dir — the same key SessionMeta uses, so the active
    // and history views join identically (RUSH-1981).
    expect(activeSessionProjectKey(s({ cwd: '/home/me/repos/agents-cli/.agents/worktrees/rush-2688' })))
      .toBe('rush-2688');
  });
});
