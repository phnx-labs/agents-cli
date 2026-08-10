import { describe, expect, test } from 'bun:test';
import {
  detectNewlyWaiting,
  formatWaitingMessage,
  type WaitingSessionInput,
} from './waitingNotifier';

function s(sessionId: string, waiting: boolean, extra?: Partial<WaitingSessionInput>): WaitingSessionInput {
  return { sessionId, agentType: 'codex', waitingForInput: waiting, ...extra };
}

describe('detectNewlyWaiting (RUSH-2039)', () => {
  test('fires on the rising edge — a session entering the waiting state', () => {
    const { newlyWaiting, nextWaiting } = detectNewlyWaiting(new Set(), [s('codex-1', true)]);
    expect(newlyWaiting.map((n) => n.sessionId)).toEqual(['codex-1']);
    expect(nextWaiting.has('codex-1')).toBe(true);
  });

  test('does not re-fire while a session stays waiting', () => {
    const first = detectNewlyWaiting(new Set(), [s('codex-1', true)]);
    const second = detectNewlyWaiting(first.nextWaiting, [s('codex-1', true)]);
    expect(second.newlyWaiting).toEqual([]);
    expect(second.nextWaiting.has('codex-1')).toBe(true);
  });

  test('re-fires after a session leaves and re-enters the waiting state', () => {
    const enter = detectNewlyWaiting(new Set(), [s('codex-1', true)]);
    const leave = detectNewlyWaiting(enter.nextWaiting, [s('codex-1', false)]);
    expect(leave.newlyWaiting).toEqual([]);
    expect(leave.nextWaiting.has('codex-1')).toBe(false);
    const reenter = detectNewlyWaiting(leave.nextWaiting, [s('codex-1', true)]);
    expect(reenter.newlyWaiting.map((n) => n.sessionId)).toEqual(['codex-1']);
  });

  test('a Claude session waiting fires too (no regression, harness parity)', () => {
    const { newlyWaiting } = detectNewlyWaiting(new Set(), [
      s('claude-1', true, { agentType: 'claude' }),
      s('codex-1', true),
    ]);
    expect(newlyWaiting.map((n) => n.sessionId).sort()).toEqual(['claude-1', 'codex-1']);
  });

  test('ignores non-waiting and session-less rows', () => {
    const { newlyWaiting } = detectNewlyWaiting(new Set(), [
      s('idle', false),
      { sessionId: null, agentType: 'codex', waitingForInput: true },
    ]);
    expect(newlyWaiting).toEqual([]);
  });

  test('label falls back to "<agentType> session" when unlabeled', () => {
    const { newlyWaiting } = detectNewlyWaiting(new Set(), [s('codex-1', true, { label: '   ' })]);
    expect(newlyWaiting[0].label).toBe('codex session');
    const labeled = detectNewlyWaiting(new Set(), [s('codex-1', true, { label: 'refactor-auth' })]);
    expect(labeled.newlyWaiting[0].label).toBe('refactor-auth');
  });

  test('formatWaitingMessage names the session and asks for approval', () => {
    expect(formatWaitingMessage({ sessionId: 'codex-1', agentType: 'codex', label: 'refactor-auth' }))
      .toBe('refactor-auth is waiting for your approval.');
  });
});
