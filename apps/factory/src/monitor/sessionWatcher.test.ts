// SessionWatcher — real-file tests (no mocks).
//
// Mounts the watcher over real temp dirs, writes real session files, and asserts
// it parses + emits the same correlation metadata sessionTracker reads, with
// exactly one fs.watch per root.

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionWatcher } from './sessionWatcher';
import { SessionFactPayload, SessionWarmthPayload } from './protocol';
import { WatcherRoot } from './sessionParse';

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// macOS FSEvents takes a moment to arm a recursive watch (longer for nested
// paths). Real session files always appear well after the watcher mounts; tests
// add a short settle so they don't race the arming window.
const SETTLE_MS = 250;

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('SessionWatcher', () => {
  test('mounts exactly one watch per root and emits a parsed gemini session fact', async () => {
    const root = mkTmp('sw-gemini-');
    const roots: WatcherRoot[] = [{ root, agentType: 'gemini' }];
    const facts: SessionFactPayload[] = [];
    const watcher = new SessionWatcher({
      emit: (f) => facts.push(f),
      emitWarmth: () => {},
      roots,
      debounceMs: 30,
    });

    try {
      watcher.start();
      expect(watcher.watchedRootCount).toBe(1);
      await sleep(SETTLE_MS);

      const sessionId = '6f8f7c61-8b95-4d84-bf52-7ed8a29f33d3';
      const projectHash = 'abc123hash';
      fs.writeFileSync(
        path.join(root, 'session-2026-05-04T01-00-deadbeef.json'),
        JSON.stringify({ sessionId, projectHash, messages: [] }) + '\n',
      );

      await waitFor(() => facts.length > 0, 5000, 'gemini session fact');
      const fact = facts[facts.length - 1];
      expect(fact.agentType).toBe('gemini');
      expect(fact.geminiSessionId).toBe(sessionId);
      expect(fact.geminiProjectHash).toBe(projectHash);
    } finally {
      watcher.stop();
    }
  });

  test('parses a claude fork in a nested subdir and emits warmth on change', async () => {
    const root = mkTmp('sw-claude-');
    // Claude session files live under a per-workspace subdir that already exists
    // before the watcher mounts (~/.claude/projects/<folder>); create it first
    // so the recursive watch is armed over it, then drop a new session file in.
    const sub = path.join(root, '-Users-me-project');
    fs.mkdirSync(sub, { recursive: true });

    const facts: SessionFactPayload[] = [];
    const warmth: SessionWarmthPayload[] = [];
    const watcher = new SessionWatcher({
      emit: (f) => facts.push(f),
      emitWarmth: (w) => warmth.push(w),
      roots: [{ root, agentType: 'claude' }],
      debounceMs: 30,
    });

    try {
      watcher.start();
      await sleep(SETTLE_MS);
      const forkId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      const parentId = '11111111-1111-1111-1111-111111111111';
      const file = path.join(sub, `${forkId}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ forkedFrom: { sessionId: parentId } }) + '\n');

      await waitFor(
        () => facts.some((f) => f.forkedFromId === parentId),
        5000,
        'claude fork fact',
      );
      const fact = facts.find((f) => f.forkedFromId === parentId)!;
      expect(fact.agentType).toBe('claude');
      expect(fact.fileSessionId).toBe(forkId);

      // A subsequent write to the same file should produce a warmth signal.
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant' }) + '\n');
      await waitFor(
        () => warmth.some((w) => path.basename(w.filePath) === `${forkId}.jsonl`),
        5000,
        'warmth on change',
      );
    } finally {
      watcher.stop();
    }
  });

  test('skips non-existent roots without throwing', () => {
    const watcher = new SessionWatcher({
      emit: () => {},
      emitWarmth: () => {},
      roots: [{ root: '/no/such/dir/for/sure/x', agentType: 'codex' }],
      debounceMs: 30,
    });
    // mkdir of an unwritable path fails -> root skipped, not mounted.
    watcher.start();
    expect(watcher.watchedRootCount).toBe(0);
    watcher.stop();
  });
});
