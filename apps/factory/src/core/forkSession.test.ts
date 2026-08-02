import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildForkSessionRequest } from './forkSession';

describe('buildForkSessionRequest', () => {
  test('the command is contributed and registered under the same id', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'));
    const contributed = packageJson.contributes.commands.find(
      (command: { command: string }) => command.command === 'agents.forkCurrentSession',
    );
    const extensionSource = readFileSync(resolve(import.meta.dir, '../vscode/extension.ts'), 'utf8');

    expect(contributed?.title).toBe('Agents: Fork Current Session');
    expect(extensionSource).toContain("registerCommand('agents.forkCurrentSession'");
  });

  test('continues the source transcript with the same harness and local device', () => {
    expect(buildForkSessionRequest({ sessionId: 'session-123', agentKey: 'Codex' })).toEqual({
      ok: true,
      sessionId: 'session-123',
      agentKey: 'codex',
      host: undefined,
      prompt: '/continue session-123',
    });
  });

  test('preserves the source host for a remote session', () => {
    expect(buildForkSessionRequest({
      sessionId: 'session-remote',
      agentKey: 'claude',
      host: 'yosemite-s0',
    })).toMatchObject({ ok: true, agentKey: 'claude', host: 'yosemite-s0' });
  });

  test('rejects a terminal before its session id is available', () => {
    expect(buildForkSessionRequest({ agentKey: 'gemini' })).toEqual({
      ok: false,
      reason: 'no_session',
    });
  });

  test('rejects a terminal without a recognized agent harness', () => {
    expect(buildForkSessionRequest({ sessionId: 'session-123' })).toEqual({
      ok: false,
      reason: 'no_agent',
    });
  });
});
