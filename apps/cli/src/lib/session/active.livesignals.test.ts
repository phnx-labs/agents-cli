import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearLiveSignalsCacheForTest, computeLiveSignals } from './active.js';

const TESTDATA = path.join(import.meta.dirname, 'testdata');
const tmp: string[] = [];

/** Copy a fixture to a fresh temp path and stamp its mtime to now (a live-scan
 * needs a fresh transcript to read a trailing tool_use as `working`). */
function freshCopy(fixtureRelative: string, basename: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-livesignals-'));
  const dst = path.join(dir, basename);
  fs.copyFileSync(path.join(TESTDATA, fixtureRelative), dst);
  const now = new Date();
  fs.utimesSync(dst, now, now);
  tmp.push(dir);
  return dst;
}

describe('computeLiveSignals wires every tracked harness into real state', () => {
  beforeEach(() => {
    clearLiveSignalsCacheForTest();
  });

  it('a live grok transcript yields working (not an empty signal set)', () => {
    const file = freshCopy('grok-working/chat_history.jsonl', 'chat_history.jsonl');
    const { state } = computeLiveSignals('grok', file, path.dirname(file), true);
    expect(state).toBeDefined();
    expect(state!.activity).toBe('working');
  });

  it('a live grok transcript that ended on a question yields waiting_input', () => {
    const file = freshCopy('grok-waiting/chat_history.jsonl', 'chat_history.jsonl');
    const { state } = computeLiveSignals('grok', file, path.dirname(file), true);
    expect(state!.activity).toBe('waiting_input');
    expect(state!.awaitingReason).toBe('question');
  });

  it('a live droid transcript yields working', () => {
    const file = freshCopy('droid-working.jsonl', 'droid-working.jsonl');
    const { state } = computeLiveSignals('droid', file, path.dirname(file), true);
    expect(state!.activity).toBe('working');
  });

  it('an untracked/opaque kind yields no state (falls back to the live floor upstream)', () => {
    const file = freshCopy('grok-idle/chat_history.jsonl', 'chat_history.jsonl');
    // `amp` is not session-tracked — computeLiveSignals returns {} and the caller's
    // resolveFallbackStatus reports `running` for the live process.
    expect(computeLiveSignals('amp', file, path.dirname(file), true)).toEqual({});
  });

  it('no transcript file yields no state', () => {
    expect(computeLiveSignals('grok', undefined, '/tmp', true)).toEqual({});
  });

  it('reuses signals when the transcript mtime is unchanged (#2047)', () => {
    const file = freshCopy('grok-working/chat_history.jsonl', 'chat_history.jsonl');
    const cwd = path.dirname(file);
    const first = computeLiveSignals('grok', file, cwd, true);
    expect(first.state?.activity).toBe('working');
    // Same path + mtime + pidAlive → identical object from the process memo
    // (not a deep clone). A second parse would allocate a new state object.
    const second = computeLiveSignals('grok', file, cwd, true);
    expect(second).toBe(first);
  });

  it('recomputes when the transcript mtime advances', () => {
    const file = freshCopy('grok-working/chat_history.jsonl', 'chat_history.jsonl');
    const cwd = path.dirname(file);
    const first = computeLiveSignals('grok', file, cwd, true);
    // Bump mtime without rewriting content — the cache key includes mtime, so
    // this must re-enter the parse path and return a fresh object.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    const second = computeLiveSignals('grok', file, cwd, true);
    expect(second).not.toBe(first);
    expect(second.state?.activity).toBe('working');
  });

  it('recomputes when pidAlive flips (lifecycle context)', () => {
    const file = freshCopy('grok-working/chat_history.jsonl', 'chat_history.jsonl');
    const cwd = path.dirname(file);
    const alive = computeLiveSignals('grok', file, cwd, true);
    const dead = computeLiveSignals('grok', file, cwd, false);
    expect(dead).not.toBe(alive);
    expect(dead.state).toBeDefined();
  });

  afterAll(() => {
    for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });
});
