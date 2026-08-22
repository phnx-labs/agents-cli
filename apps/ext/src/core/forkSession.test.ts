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
      sourceHost: undefined,
      moved: false,
      local: true,
      strategy: 'balanced',
      prompt: '/continue session-123',
    });
    if (!request.ok) throw new Error('expected fork request');
    expect(buildAgentLaunchCommand(
      request.agentKey, null, undefined, undefined, undefined, request.strategy, undefined,
      { host: request.host, local: request.local },
    )).toBe('agents run codex --interactive --strategy balanced --mode auto');
  });

  test('keeps a remote fork on the source host with balanced account selection', () => {
    const request = buildForkSessionRequest({ sessionId: 'session-remote', agentKey: 'claude', host: 'yosemite-s0' });
    expect(request).toMatchObject({
      ok: true,
      agentKey: 'claude',
      host: 'yosemite-s0',
      sourceHost: 'yosemite-s0',
      moved: false,
      local: false,
      strategy: 'balanced',
      prompt: '/continue session-remote',
    });
    if (!request.ok) throw new Error('expected fork request');
    const command = buildAgentLaunchCommand(
      request.agentKey, 'new-session', undefined, undefined, undefined, request.strategy, undefined,
      { host: request.host, local: request.local },
    );
    expect(command).toContain("--device 'yosemite-s0'");
    expect(command).toContain('--session-id new-session');
    expect(command).toContain('--strategy balanced');
  });

  test('a fork is balanced for every runner, including one with no accounts to rotate', () => {
    // droid has no account enumeration, but the launch contract still emits
    // --strategy balanced (a graceful CLI no-op, never an error) so every fork —
    // like every New launch — is uniform. Only 'shell' would carry no strategy.
    expect(buildForkSessionRequest({ sessionId: 'session-123', agentKey: 'droid' })).toMatchObject({
      ok: true,
      agentKey: 'droid',
      strategy: 'balanced',
    });
  });

  test('rejects a terminal before its session id is available', () => {
    expect(buildForkSessionRequest({ agentKey: 'gemini' })).toEqual({ ok: false, reason: 'no_session' });
  });

  test('rejects a terminal without a recognized agent harness', () => {
    expect(buildForkSessionRequest({ sessionId: 'session-123' })).toEqual({ ok: false, reason: 'no_agent' });
  });

  test('builds an active-tab recap as a fresh sibling context prompt', () => {
    expect(buildForkSessionRequest(
      { sessionId: 'session-123', agentKey: 'claude', host: 'yosemite-s0' },
      undefined,
      'recap',
    )).toMatchObject({
      ok: true,
      sessionId: 'session-123',
      agentKey: 'claude',
      host: 'yosemite-s0',
      local: false,
      strategy: 'balanced',
      prompt: '/recap session-123',
    });
  });
});

describe('buildForkSessionRequest with a picked device', () => {
  test('moves a local session onto the picked device and points it back home', () => {
    const request = buildForkSessionRequest(
      { sessionId: 'session-local', agentKey: 'claude', localHost: 'zion' },
      { host: 'yosemite-m0' },
    );
    expect(request).toMatchObject({
      ok: true,
      agentKey: 'claude',
      host: 'yosemite-m0',
      sourceHost: undefined,
      moved: true,
      local: false,
      // The transcript stayed on zion and a single-id lookup does not fan out,
      // so the fork has to be told where to read it from.
      prompt: '/continue session-local --device zion',
    });
    if (!request.ok) throw new Error('expected fork request');
    expect(buildAgentLaunchCommand(
      request.agentKey, 'fork-session', undefined, undefined, undefined, request.strategy, undefined,
      { host: request.host, local: request.local },
    )).toContain("--device 'yosemite-m0'");
  });

  test('keeps the same harness and balanced rotation when the machine changes', () => {
    const request = buildForkSessionRequest(
      { sessionId: 'session-1', agentKey: 'Codex', host: 'yosemite-s0', localHost: 'zion' },
      { host: 'mac-mini' },
    );
    expect(request).toMatchObject({
      ok: true,
      agentKey: 'codex',
      host: 'mac-mini',
      sourceHost: 'yosemite-s0',
      moved: true,
      strategy: 'balanced',
      prompt: '/continue session-1 --device yosemite-s0',
    });
  });

  test('pulls a remote session back to this machine', () => {
    expect(buildForkSessionRequest(
      { sessionId: 'session-2', agentKey: 'claude', host: 'yosemite-s0', localHost: 'zion' },
      {},
    )).toMatchObject({
      ok: true,
      host: undefined,
      sourceHost: 'yosemite-s0',
      moved: true,
      local: true,
      prompt: '/continue session-2 --device yosemite-s0',
    });
  });

  test('picking the machine the session already lives on is not a move', () => {
    expect(buildForkSessionRequest(
      { sessionId: 'session-3', agentKey: 'claude', host: 'yosemite-s0', localHost: 'zion' },
      { host: 'Yosemite-S0' },
    )).toMatchObject({
      ok: true,
      host: 'Yosemite-S0',
      moved: false,
      prompt: '/continue session-3',
    });
  });
});
