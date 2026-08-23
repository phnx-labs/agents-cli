import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const extensionSource = readFileSync(join(import.meta.dir, 'extension.ts'), 'utf8');
const settingsSource = readFileSync(join(import.meta.dir, 'settings.vscode.ts'), 'utf8');

describe('agent session editor-tab routing', () => {
  test('the shared resume helper creates an editor tab and registers its identity', () => {
    const helper = extensionSource.slice(
      extensionSource.indexOf('export async function openAgentSessionTerminal'),
      extensionSource.indexOf('export async function openAgentSessionById'),
    );

    expect(helper).toContain('location: { viewColumn: vscode.ViewColumn.Active }');
    expect(helper).toContain('await registerAgentTerminal(terminal, context');
    expect(helper).toContain('terminalId = session.terminalId || terminals.nextId');
  });

  test('Fleet focus and remote attach both use the shared registered path', () => {
    const focusRemote = settingsSource.slice(
      settingsSource.indexOf("case 'focusRemoteSession':"),
      settingsSource.indexOf("case 'revealWorktree':"),
    );
    const focusSession = settingsSource.slice(
      settingsSource.indexOf("case 'focusSession':"),
      settingsSource.indexOf("case 'stopSession':"),
    );

    expect(focusRemote).toContain('await openAgentSessionById(context, sessionId, host)');
    expect(focusSession).toContain('await openAgentSessionById(context, sessionId');
    expect(focusRemote).not.toContain('createTerminal');
    expect(focusSession).not.toContain('createTerminal');
  });
});
