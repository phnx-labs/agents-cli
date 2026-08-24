import { describe, expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble({ window: {} }));

const { restoreTerminals } = await import('./prewarm.vscode');

describe('restoreTerminals', () => {
  test('reopens only the residual crash mappings — skips reaped and already-restored sessions', async () => {
    const updates: Array<[string, unknown]> = [];
    const opened: Array<{ id: string; terminalId?: string; agent: string }> = [];
    const values = new Map<string, unknown>([
      ['prewarm.cleanShutdown', false],
      ['prewarm.mappings', [
        // Residual: in the CLI list, and NOT already reopened by restoreAgentTerminals.
        {
          terminalId: 'CL42',
          sessionId: 'session-live',
          agentType: 'claude',
          createdAt: 100,
          workingDirectory: '/workspace/project',
        },
        // Reaped: no longer in the CLI session list -> must not be resurrected.
        {
          terminalId: 'CD17',
          sessionId: 'session-reaped',
          agentType: 'codex',
          createdAt: 1,
          workingDirectory: '/workspace/old',
        },
        // Already restored by restoreAgentTerminals (its terminalId is tracked)
        // -> must be skipped so we don't double-open + double-resume it.
        {
          terminalId: 'CL08',
          sessionId: 'session-doubled-by-tid',
          agentType: 'claude',
          createdAt: 50,
          workingDirectory: '/workspace/a',
        },
        // Already restored under a different terminalId, same session id
        // -> the sessionId guard must still skip it.
        {
          terminalId: 'CL99',
          sessionId: 'session-doubled-by-sid',
          agentType: 'claude',
          createdAt: 60,
          workingDirectory: '/workspace/b',
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
        // Every candidate except the reaped one is still a real session.
        return new Set(['session-live', 'session-doubled-by-tid', 'session-doubled-by-sid']);
      },
      trackedKeys() {
        return {
          terminalIds: new Set(['CL08']),
          sessionIds: new Set(['session-doubled-by-sid']),
        };
      },
      async openAgentSessionTerminal(_context, session) {
        opened.push(session);
        return true;
      },
    });

    // Only the residual session opens; reaped + both already-tracked are skipped.
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
