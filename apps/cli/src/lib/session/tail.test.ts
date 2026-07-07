import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { readSessionTail } from './tail.js';
import { inferSessionState } from './state.js';

const FIXTURE = path.join(import.meta.dirname, 'testdata', 'tail-sample-claude.jsonl');

describe('readSessionTail', () => {
  it('parses the tail of a real JSONL into normalized events', () => {
    const events = readSessionTail(FIXTURE, 'claude');
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.type).toBe('message');
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('--tree the default');
  });

  it('drops a partial leading line when starting mid-file', () => {
    // A tiny byte budget forces the read to begin mid-file; the first (partial)
    // line must be discarded rather than producing a garbage event.
    const events = readSessionTail(FIXTURE, 'claude', 400);
    expect(events.length).toBeGreaterThan(0);
    // Every returned event still parsed cleanly (no malformed leftovers).
    for (const e of events) expect(typeof e.type).toBe('string');
  });

  it('returns [] for unsupported agents', () => {
    expect(readSessionTail(FIXTURE, 'gemini')).toEqual([]);
  });

  it('feeds inferSessionState to a waiting verdict on a trailing question', () => {
    const events = readSessionTail(FIXTURE, 'claude');
    const state = inferSessionState(events, {
      cwd: '/home/u/repo/.agents/worktrees/tree-view',
      gitBranch: 'agents/tree-view',
      pidAlive: true,
      mtimeMs: Date.now() - 20 * 60_000,
    });
    expect(state.activity).toBe('waiting_input');
    expect(state.awaitingReason).toBe('question');
    expect(state.worktree?.slug).toBe('tree-view');
  });
});
