import { describe, it, expect } from 'vitest';
import { taskMatchesCaller, resolveCallerIdentity, callerIdentityEnv } from './caller-identity.js';

describe('callerIdentityEnv', () => {
  it('forwards both ids when present so the hub resolves the caller', () => {
    expect(callerIdentityEnv({ sessionId: 'sess-a', launchId: 'launch-1' })).toEqual({
      AGENT_SESSION_ID: 'sess-a',
      AGENT_LAUNCH_ID: 'launch-1',
    });
  });

  it('forwards only the fields it has', () => {
    expect(callerIdentityEnv({ launchId: 'agent-pid:4242' })).toEqual({
      AGENT_LAUNCH_ID: 'agent-pid:4242',
    });
    expect(callerIdentityEnv({ sessionId: 'sess-a' })).toEqual({ AGENT_SESSION_ID: 'sess-a' });
  });

  it('forwards nothing for an unidentifiable caller — never an empty string that reads as a real blank identity', () => {
    expect(callerIdentityEnv({})).toEqual({});
  });
});

describe('taskMatchesCaller', () => {
  it('matches on sessionId', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { sessionId: 'sess-a' },
      ),
    ).toBe(true);
  });

  it('matches on launchId when session differs', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { launchId: 'launch-1' },
      ),
    ).toBe(true);
  });

  it('does not match when neither identity overlaps', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { sessionId: 'sess-b', launchId: 'launch-2' },
      ),
    ).toBe(false);
  });

  it('does not match an empty caller against a stamped task', () => {
    expect(
      taskMatchesCaller({ sessionId: 'sess-a' }, {}),
    ).toBe(false);
  });
});

describe('resolveCallerIdentity', () => {
  it('prefers explicit AGENT_SESSION_ID / AGENT_LAUNCH_ID from the env', () => {
    const id = resolveCallerIdentity({
      AGENT_SESSION_ID: 'env-session-1',
      AGENT_LAUNCH_ID: 'env-launch-1',
    } as NodeJS.ProcessEnv);
    expect(id.sessionId).toBe('env-session-1');
    expect(id.launchId).toBe('env-launch-1');
    expect(id.actor).toBeTruthy();
  });

  it('accepts AGENTS_SESSION_ID as the plural form', () => {
    const id = resolveCallerIdentity({
      AGENTS_SESSION_ID: 'plural-session',
      AGENT_LAUNCH_ID: 'launch-x',
    } as NodeJS.ProcessEnv);
    expect(id.sessionId).toBe('plural-session');
  });

  it('never puts a synthetic agent-pid anchor into sessionId', () => {
    // When neither env is set, any process-table fallback must land in
    // launchId (hygiene never session-reaps launchId-only tasks).
    const id = resolveCallerIdentity({} as NodeJS.ProcessEnv);
    if (id.sessionId) {
      expect(id.sessionId.startsWith('agent-pid:')).toBe(false);
    }
    if (id.launchId?.startsWith('agent-pid:')) {
      expect(id.sessionId).toBeUndefined();
    }
  });
});
