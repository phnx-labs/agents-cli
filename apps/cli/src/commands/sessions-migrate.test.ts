import { describe, it, expect } from 'vitest';
import { effectiveMode } from './sessions-migrate.js';
import { buildResumeCommand } from './sessions.js';
import { SESSION_AGENTS, type SessionMeta, type SessionAgentId } from '../lib/session/types.js';

/** Minimal SessionMeta with a resolvable version, for the harness-parity gate. */
function meta(agent: SessionAgentId): SessionMeta {
  return {
    id: '2026-07-31T00-00-00-000Z',
    shortId: 'abcd1234',
    agent,
    timestamp: '2026-07-31T00:00:00.000Z',
    filePath: `/tmp/${agent}.jsonl`,
    version: '1.0.0',
    cwd: '/tmp',
  };
}

describe('effectiveMode — harness parity gate', () => {
  it('keeps resume for agents buildResumeCommand can resume (claude, codex, opencode)', () => {
    for (const agent of ['claude', 'codex', 'opencode'] as SessionAgentId[]) {
      const r = effectiveMode(meta(agent), 'resume');
      expect(r).toEqual({ mode: 'resume', downgraded: false });
    }
  });

  it('downgrades resume→rehydrate for every non-resumable agent (no silent skip)', () => {
    const nonResumable: SessionAgentId[] = ['gemini', 'antigravity', 'openclaw', 'rush', 'hermes', 'grok', 'kimi', 'droid'];
    for (const agent of nonResumable) {
      const r = effectiveMode(meta(agent), 'resume');
      expect(r).toEqual({ mode: 'rehydrate', downgraded: true });
    }
  });

  it('honors an explicit rehydrate request for a resumable agent (no forced downgrade flag)', () => {
    const r = effectiveMode(meta('claude'), 'rehydrate');
    expect(r).toEqual({ mode: 'rehydrate', downgraded: false });
  });

  it('stays in lockstep with buildResumeCommand for EVERY session agent (the parity invariant)', () => {
    // The gate must downgrade exactly when buildResumeCommand returns null — if a
    // new agent gains/loses resume support, this pins the two together.
    for (const agent of SESSION_AGENTS) {
      const m = meta(agent);
      const resumable = buildResumeCommand(m) !== null;
      const { mode, downgraded } = effectiveMode(m, 'resume');
      if (resumable) {
        expect(mode).toBe('resume');
        expect(downgraded).toBe(false);
      } else {
        expect(mode).toBe('rehydrate');
        expect(downgraded).toBe(true);
      }
    }
  });
});
