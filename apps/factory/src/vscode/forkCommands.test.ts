import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildAgentLaunchCommand, usesManagedAgentLaunch } from '../core/agents';
import {
  handleForkPickHost,
  remoteForkSessionId,
  registerForkPickHostCommand,
  resolveForkSessionId,
} from './forkCommands.vscode';

/**
 * A palette entry and its `registerCommand` are two halves of one contract, in two
 * files that nothing else keeps in step. Contribute without registering and the
 * command is in the palette but throws "command not found" on pick; register
 * without contributing and it is unreachable. Read both real files and pin them
 * to each other.
 */
const factoryRoot = path.resolve(import.meta.dir, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(factoryRoot, 'package.json'), 'utf8'));

const contributed = (id: string) =>
  (manifest.contributes.commands as Array<{ command: string; title: string }>).find(c => c.command === id);

describe('fork command contributions', () => {
  test('Agents: Fork (Pick Host) is contributed under its stable command id', () => {
    expect(contributed('agents.forkPickHost')?.title).toBe('Agents: Fork (Pick Host)');
  });

  test('registered Agents: Fork (Pick Host) creates a sibling on the picked host', async () => {
    let command = '';
    let callback!: () => Promise<void>;
    let launch: unknown;
    let queuedCommand = '';
    let edge: unknown;
    let rejection: unknown;

    registerForkPickHostCommand((id, run) => {
      command = id;
      callback = run;
      return {};
    }, () => handleForkPickHost({
      source: { sessionId: 'source-id', agentKey: 'claude', localHost: 'source-machine' },
      pickHost: async () => ({ host: 'chosen-host', cancelled: false }),
      openFork: async (value) => {
        launch = value;
        // `openSingleAgentWithQueue` gives ordinary remote launches the portable
        // workspace cwd; the launch builder must preserve that form, not turn it
        // into an exact path that belongs to another machine.
        queuedCommand = `${buildAgentLaunchCommand(
          'claude',
          'sibling-id',
          undefined,
          undefined,
          undefined,
          value.strategy,
          undefined,
          { host: value.host, local: value.local, cwd: '/Users/muqsit/src/agents-cli' },
        )} && queue ${value.prompt}`;
        return { terminalId: 'sibling-terminal', sessionId: 'sibling-id' };
      },
      recordFork: (value) => { edge = value; },
      showRejection: (value) => { rejection = value; },
      viewColumn: 'Beside',
      now: () => 123,
    }));

    await callback();

    expect(command).toBe('agents.forkPickHost');
    expect(launch).toEqual({
      prompt: '/continue source-id --device source-machine',
      strategy: 'balanced',
      host: 'chosen-host',
      local: false,
      viewColumn: 'Beside',
    });
    expect(queuedCommand).toContain("--host 'chosen-host' --cwd '/Users/muqsit/src/agents-cli'");
    expect(queuedCommand).not.toContain('--remote-cwd');
    expect(queuedCommand).toEndWith('queue /continue source-id --device source-machine');
    expect(edge).toEqual({
      sourceSessionId: 'source-id',
      sourceHost: 'source-machine',
      forkSessionId: 'sibling-id',
      forkHost: 'chosen-host',
      agentKey: 'claude',
      forkedAt: 123,
      terminalId: 'sibling-terminal',
    });
    expect(rejection).toBeUndefined();
  });

  test('a remote Grok source brought back local keeps the managed balanced launch', async () => {
    let launch: unknown;
    await handleForkPickHost({
      source: { sessionId: 'source-id', agentKey: 'grok', host: 'source-host', localHost: 'this-host' },
      pickHost: async () => ({ host: undefined, cancelled: false }),
      openFork: async (value) => {
        launch = value;
        expect(usesManagedAgentLaunch('grok', value.host)).toBe(true);
        expect(buildAgentLaunchCommand(
          'grok', null, undefined, undefined, undefined, value.strategy, undefined,
          { host: value.host, local: value.local },
        )).toBe('agents run grok --interactive --strategy balanced --mode auto');
        return { terminalId: 'GR-remote-to-local', sessionId: null };
      },
      recordFork: () => {},
      showRejection: () => {},
      viewColumn: 'Beside',
      now: () => 123,
    });
    expect(launch).toEqual({
      prompt: '/continue source-id --device source-host',
      strategy: 'balanced',
      host: undefined,
      local: true,
      viewColumn: 'Beside',
    });
  });

  test('a remote non-Claude fork resolves its child id by AGENT_TERMINAL_ID', async () => {
    const active = JSON.stringify([
      { terminalId: 'CX-sibling-terminal', sessionId: 'sibling-session-id' },
    ]);
    const calls: string[] = [];
    const resolved = await resolveForkSessionId({
      initialSessionId: null,
      terminalId: 'CX-sibling-terminal',
      forkHost: 'chosen-host',
      localHost: 'source-host',
      attempts: 2,
      wait: async () => {},
      readLocal: () => { throw new Error('remote fork must not use the local terminal registry'); },
      readRemote: async (host, terminalId) => {
        calls.push(`${host}:${terminalId}`);
        if (calls.length === 1) return null;
        return remoteForkSessionId(
          async (args, options) => {
            expect(args).toBe("sessions --active --json --host 'chosen-host'");
            expect(options).toEqual({ maxBuffer: 16 * 1024 * 1024, timeout: 45_000 });
            return { stdout: active };
          },
          host,
          terminalId,
          value => `'${value}'`,
        );
      },
    });
    expect(calls).toEqual([
      'chosen-host:CX-sibling-terminal',
      'chosen-host:CX-sibling-terminal',
    ]);
    expect(resolved).toBe('sibling-session-id');
  });
});
