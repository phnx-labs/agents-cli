import { describe, expect, test } from 'bun:test';
import { buildAgentLaunchCommand } from './agents';
import { buildForkSessionRequest } from './forkSession';

describe('buildForkSessionRequest', () => {
  test('builds a local same-harness fork with balanced account selection', () => {
    const request = buildForkSessionRequest({ sessionId: 'session-123', agentKey: 'Codex' });
    expect(request).toEqual({
      ok: true,
      sessionId: 'session-123',
      agentKey: 'codex',
      host: undefined,
      local: true,
      strategy: 'balanced',
      prompt: '/continue session-123',
    });
    if (!request.ok) throw new Error('expected fork request');
    expect(buildAgentLaunchCommand(
      request.agentKey, null, undefined, undefined, undefined, request.strategy, undefined, request.host, request.local,
    )).toBe('agents run codex --interactive --strategy balanced --mode auto');
  });

  test('keeps a remote fork on the source host with balanced account selection', () => {
    const request = buildForkSessionRequest({ sessionId: 'session-remote', agentKey: 'claude', host: 'yosemite-s0' });
    expect(request).toMatchObject({
      ok: true,
      agentKey: 'claude',
      host: 'yosemite-s0',
      local: false,
      strategy: 'balanced',
      prompt: '/continue session-remote',
    });
    if (!request.ok) throw new Error('expected fork request');
    const command = buildAgentLaunchCommand(
      request.agentKey, 'new-session', undefined, undefined, undefined, request.strategy, undefined, request.host, request.local,
    );
    expect(command).toContain("--host 'yosemite-s0'");
    expect(command).toContain('--session-id new-session');
    expect(command).toContain('--strategy balanced');
  });

  test('uses the harness default when account rotation is unsupported', () => {
    expect(buildForkSessionRequest({ sessionId: 'session-123', agentKey: 'droid' })).toMatchObject({
      ok: true,
      agentKey: 'droid',
      strategy: undefined,
    });
  });

  test('rejects a terminal before its session id is available', () => {
    expect(buildForkSessionRequest({ agentKey: 'gemini' })).toEqual({ ok: false, reason: 'no_session' });
  });

  test('rejects a terminal without a recognized agent harness', () => {
    expect(buildForkSessionRequest({ sessionId: 'session-123' })).toEqual({ ok: false, reason: 'no_agent' });
  });
});
