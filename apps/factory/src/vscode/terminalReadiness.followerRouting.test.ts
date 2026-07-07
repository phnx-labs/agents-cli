// terminalReadiness follower-routing — broadcast facts drive waitFor (#68).
//
// Mocks only the vscode module surface terminalReadiness touches (there is no
// real extension host in bun); everything else is the real state machine. With
// the monitor "connected", local ps/pgrep probing is suppressed and ingested
// broadcast facts must satisfy the existing waitFor API unchanged.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type * as vscode from 'vscode';

mock.module('vscode', () => ({
  window: {
    onDidChangeTerminalShellIntegration: () => ({ dispose: () => {} }),
    onDidCloseTerminal: () => ({ dispose: () => {} }),
  },
}));

const readiness = await import('./terminalReadiness');

function fakeTerminal(name: string, pid: number | undefined): vscode.Terminal {
  return { name, processId: Promise.resolve(pid) } as unknown as vscode.Terminal;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  readiness.__clearRegistryForTests();
  readiness.setMonitorConnectivity(() => true);
  readiness.setMonitorArmSink({ armAgent: () => {}, armShellAdoption: () => {} });
});

afterEach(() => {
  readiness.__clearRegistryForTests();
  readiness.setMonitorConnectivity(() => false);
  readiness.setMonitorArmSink(undefined);
});

describe('terminalReadiness follower routing', () => {
  test('ingestReadinessFact resolves waitFor(agentReady) for the matching pid', async () => {
    const pid = 4242;
    const term = fakeTerminal('CC-broadcast', pid);
    readiness.registerTerminal(term);

    // Let tabReady (processId) resolve; with the monitor connected no local
    // probes start.
    await waitMs(20);

    let resolved = false;
    const wait = readiness.waitFor(term, 'agentReady', { timeoutMs: 2000 }).then(() => {
      resolved = true;
    });

    // The leader broadcasts agentReady for this pid; the follower ingests it.
    readiness.ingestReadinessFact(pid, 'agentReady');
    await wait;
    expect(resolved).toBe(true);

    // markEvent cascades, so lower milestones resolve immediately too.
    await readiness.waitFor(term, 'shellReady', { timeoutMs: 100 });
    await readiness.waitFor(term, 'promptReady', { timeoutMs: 100 });
  });

  test('ingestReadinessFact ignores pids this window does not own', async () => {
    const term = fakeTerminal('CC-mine', 1000);
    readiness.registerTerminal(term);
    await waitMs(20);

    readiness.ingestReadinessFact(9999, 'agentReady'); // a different window's pid

    await expect(
      readiness.waitFor(term, 'agentReady', { timeoutMs: 150 }),
    ).rejects.toThrow();
  });

  test('ingestShellAdoptionFact fires the armed adoption callback for the pid', async () => {
    const pid = 5151;
    const term = fakeTerminal('SH-adopt', pid);
    readiness.registerTerminal(term);
    await waitMs(20);

    let adopted: { agentKey: string; sessionId: string | undefined; childPid: number } | undefined;
    readiness.armShellAdoption(term, (info) => {
      adopted = info;
    });

    readiness.ingestShellAdoptionFact(pid, {
      agentKey: 'claude',
      sessionId: 'sess-123',
      childPid: 6262,
    });

    expect(adopted).toBeDefined();
    expect(adopted!.agentKey).toBe('claude');
    expect(adopted!.sessionId).toBe('sess-123');
    expect(adopted!.childPid).toBe(6262);
  });
});
