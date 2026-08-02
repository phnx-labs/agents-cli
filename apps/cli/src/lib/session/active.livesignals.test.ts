import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeLiveSignals } from './active.js';

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

  afterAll(() => {
    for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });
});
