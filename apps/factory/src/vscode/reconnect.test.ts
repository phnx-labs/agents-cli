import { describe, expect, mock, test } from 'bun:test';
import type { PersistedSession } from '../core/sessions.persist';
import type { TmuxSessionState } from './tmux';

// reconnect.ts only touches vscode.window.onDidChangeWindowState in
// registerReconnect (not exercised by these unit tests). Stub it so the import
// resolves under bun.
mock.module('vscode', () => ({
  window: { onDidChangeWindowState: () => ({ dispose() {} }) },
}));

const {
  needsReattach,
  scanReattachTargets,
  backoffDelayMs,
  withRetry,
  runReconnectPass,
  hasTmuxMapping,
  NonRetryableError,
  DEFAULT_RETRY,
} = await import('./reconnect');

const LIVE: TmuxSessionState = { exists: true, paneAlive: true, hasClient: false, probeFailed: false };
const ATTACHED: TmuxSessionState = { exists: true, paneAlive: true, hasClient: true, probeFailed: false };
const DEAD: TmuxSessionState = { exists: true, paneAlive: false, hasClient: false, probeFailed: false };
const GONE: TmuxSessionState = { exists: false, paneAlive: false, hasClient: false, probeFailed: false };

function mapping(id: string, tmuxSession: string | undefined): PersistedSession {
  return {
    terminalId: id,
    prefix: 'CL',
    agentType: 'claude',
    createdAt: 0,
    tmuxSession,
    tmuxSocket: tmuxSession ? '/tmp/server.sock' : undefined,
  };
}

describe('needsReattach', () => {
  test('live pane + no client → reattach', () => {
    expect(needsReattach(LIVE)).toBe(true);
  });
  test('already attached → skip (someone is viewing it)', () => {
    expect(needsReattach(ATTACHED)).toBe(false);
  });
  test('dead pane (agent exited) → skip', () => {
    expect(needsReattach(DEAD)).toBe(false);
  });
  test('gone session → skip', () => {
    expect(needsReattach(GONE)).toBe(false);
  });
});

describe('scanReattachTargets', () => {
  test('returns only live + client-less tmux mappings', async () => {
    const persisted = [
      mapping('a', 'agents-a'), // live → reattach
      mapping('b', 'agents-b'), // attached → skip
      mapping('c', 'agents-c'), // dead → skip
      mapping('d', undefined),  // native (no tmux) → skip
    ];
    const states: Record<string, TmuxSessionState> = {
      'agents-a': LIVE, 'agents-b': ATTACHED, 'agents-c': DEAD,
    };
    const query = async (_socket: string, session: string) => states[session] ?? GONE;

    const targets = await scanReattachTargets(persisted, query);
    expect(targets.map((t) => t.session.terminalId)).toEqual(['a']);
    expect(targets[0].tmuxSession).toBe('agents-a');
    expect(targets[0].tmuxSocket).toBe('/tmp/server.sock');
  });
});

describe('backoffDelayMs', () => {
  test('exponential, capped at maxDelayMs', () => {
    const opts = { attempts: 6, baseDelayMs: 500, maxDelayMs: 8_000 };
    expect(backoffDelayMs(0, opts)).toBe(500);
    expect(backoffDelayMs(1, opts)).toBe(1_000);
    expect(backoffDelayMs(2, opts)).toBe(2_000);
    expect(backoffDelayMs(3, opts)).toBe(4_000);
    expect(backoffDelayMs(4, opts)).toBe(8_000); // 8000, at cap
    expect(backoffDelayMs(5, opts)).toBe(8_000); // 16000 clamped to cap
  });
});

describe('withRetry', () => {
  test('retries a transient failure then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('transient SSH failure');
      return 'ok';
    }, DEFAULT_RETRY, async () => {}); // instant sleep
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('rejects with the last error after exhausting attempts', async () => {
    let calls = 0;
    const opts = { attempts: 3, baseDelayMs: 1, maxDelayMs: 4 };
    await expect(
      withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, opts, async () => {}),
    ).rejects.toThrow('fail 3');
    expect(calls).toBe(3);
  });

  test('a NonRetryableError is thrown immediately without burning retries', async () => {
    let calls = 0;
    let slept = 0;
    await expect(
      withRetry(
        async () => { calls++; throw new NonRetryableError('unknown prefix for reattach: ZZ'); },
        DEFAULT_RETRY,
        async () => { slept++; }, // count any backoff sleeps
      ),
    ).rejects.toThrow('unknown prefix for reattach: ZZ');
    // Called exactly once — no retry, no backoff sleep. Without the non-retryable
    // gate this would call DEFAULT_RETRY.attempts (4) times and sleep 3 times.
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });
});

describe('runReconnectPass', () => {
  test('reattaches live client-less mappings, skips already-tracked, resumes polling', async () => {
    const persisted = [
      mapping('a', 'agents-a'), // live, not tracked → reattach
      mapping('b', 'agents-b'), // live, but already open in this window → skip
      mapping('c', 'agents-c'), // dead → skip
    ];
    const states: Record<string, TmuxSessionState> = {
      'agents-a': LIVE, 'agents-b': LIVE, 'agents-c': DEAD,
    };
    const reattached: string[] = [];
    let resumed = 0;

    const attached = await runReconnectPass({
      loadPersisted: () => persisted,
      queryState: async (_s, session) => states[session] ?? GONE,
      trackedTerminalIds: () => new Set(['b']), // 'b' tab is already open
      reattachOne: async (t) => { reattached.push(t.session.terminalId); },
      resumePanelPolling: () => { resumed++; },
    });

    expect(attached).toBe(1);
    expect(reattached).toEqual(['a']);
    expect(resumed).toBe(1); // polling resumes on every reconnect pass
  });

  test('resumes polling even when nothing needs reattaching (unfreeze the grid)', async () => {
    let resumed = 0;
    const attached = await runReconnectPass({
      loadPersisted: () => [mapping('x', 'agents-x')],
      queryState: async () => ATTACHED, // already connected → nothing to attach
      trackedTerminalIds: () => new Set<string>(),
      reattachOne: async () => { throw new Error('should not be called'); },
      resumePanelPolling: () => { resumed++; },
    });
    expect(attached).toBe(0);
    expect(resumed).toBe(1);
  });

  test('a persistent reattach failure does not abort the pass', async () => {
    const reattached: string[] = [];
    let resumed = 0;
    const attached = await runReconnectPass({
      loadPersisted: () => [mapping('a', 'agents-a'), mapping('b', 'agents-b')],
      queryState: async () => LIVE,
      trackedTerminalIds: () => new Set<string>(),
      reattachOne: async (t) => {
        if (t.session.terminalId === 'a') throw new Error('SSH still down');
        reattached.push(t.session.terminalId);
      },
      resumePanelPolling: () => { resumed++; },
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    // 'a' exhausted its retries and was skipped; 'b' still got attached.
    expect(reattached).toEqual(['b']);
    expect(attached).toBe(1);
    expect(resumed).toBe(1);
  });
});
