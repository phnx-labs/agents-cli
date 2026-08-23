import { describe, expect, mock, test } from 'bun:test';

mock.module('vscode', () => ({ window: {} }));

const { restoreTerminals } = await import('./prewarm.vscode');

describe('restoreTerminals', () => {
  test('reopens stored crash mappings that remain in the CLI session list', async () => {
    const updates: Array<[string, unknown]> = [];
    const opened: Array<{ id: string; terminalId?: string; agent: string }> = [];
    const values = new Map<string, unknown>([
      ['prewarm.cleanShutdown', false],
      ['prewarm.mappings', [
        {
          terminalId: 'CL42',
          sessionId: 'session-live',
          agentType: 'claude',
          createdAt: Date.now(),
          workingDirectory: '/workspace/project',
        },
        {
          terminalId: 'CD17',
          sessionId: 'session-reaped',
          agentType: 'codex',
          createdAt: 1,
          workingDirectory: '/workspace/old',
        },
      ]],
    ]);
    const context = {
      globalState: {
        get<T>(key: string, fallback?: T): T {
          return (values.has(key) ? values.get(key) : fallback) as T;
        },
        async update(key: string, value: unknown): Promise<void> {
          values.set(key, value);
          updates.push([key, value]);
        },
      },
    } as any;

    const restored = await restoreTerminals(context, {
      async listRestorableSessionIds() {
        return new Set(['session-live']);
      },
      async openAgentSessionTerminal(_context, session) {
        opened.push(session);
        return true;
      },
    });

    expect(restored).toBe(1);
    expect(opened).toEqual([{
      id: 'session-live',
      shortId: 'session-',
      agent: 'claude',
      cwd: '/workspace/project',
      terminalId: 'CL42',
    }]);
    expect(updates).toContainEqual(['prewarm.mappings', []]);
  });
});
