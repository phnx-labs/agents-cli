import { describe, it, expect } from 'vitest';
import { metaFromActive, selectFallback } from './focus.js';
import { refuseFallback } from './go.js';
import { buildResumeCommand } from './sessions.js';
import type { ActiveSession } from '../lib/session/active.js';

function s(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

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

describe('focus resume-in-a-tab command (metaFromActive → buildResumeCommand)', () => {
  it('claude → claude --resume <id>', () => {
    expect(buildResumeCommand(metaFromActive(s({ sessionId: 'abc12345', kind: 'claude' })))).toEqual(['claude', '--resume', 'abc12345']);
  });

  it('codex → codex resume <id>', () => {
    expect(buildResumeCommand(metaFromActive(s({ sessionId: 'def67890', kind: 'codex' })))).toEqual(['codex', 'resume', 'def67890']);
  });

  it('opencode → opencode --session <id>', () => {
    expect(buildResumeCommand(metaFromActive(s({ sessionId: 'ses_9', kind: 'opencode' })))).toEqual(['opencode', '--session', 'ses_9']);
  });

  it('non-resumable agents (gemini/grok/…) → null, so focus refuses cleanly', () => {
    for (const kind of ['gemini', 'grok', 'antigravity', 'droid', 'kimi']) {
      expect(buildResumeCommand(metaFromActive(s({ sessionId: 'x1234567', kind })))).toBeNull();
    }
  });
});
