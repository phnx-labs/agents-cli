// #5b: a genuine user close (Cmd+W) tears down the agent + its mux; a window
// RELOAD (Shutdown) — which fires the SAME onDidCloseTerminal — must NOT, or
// crash-restore (which re-registers the closed session) would kill it. The one
// clean signal is `terminal.exitStatus.reason` (TerminalExitReason). These tests
// pin the decision and the injected-stop wiring without a real extension host.

import { describe, expect, mock, test } from 'bun:test';

// Only the vscode surface these functions touch. TerminalExitReason mirrors the
// real enum values (stable since API 1.77): Unknown 0, Shutdown 1, Process 2,
// User 3, Extension 4.
mock.module('vscode', () => ({
  window: {
    onDidChangeTerminalShellIntegration: () => ({ dispose: () => {} }),
    onDidCloseTerminal: () => ({ dispose: () => {} }),
  },
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
}));

const vscode = await import('vscode');
const { shouldTearDownAgentOnClose, maybeTearDownAgentOnClose } = await import('./terminalReadiness');

const R = (vscode as unknown as { TerminalExitReason: Record<string, number> }).TerminalExitReason;

describe('shouldTearDownAgentOnClose', () => {
  test('true ONLY for a genuine user close', () => {
    expect(shouldTearDownAgentOnClose(R.User)).toBe(true);
  });

  test('false for a reload/shutdown, a programmatic close, a natural exit, unknown, and absent', () => {
    expect(shouldTearDownAgentOnClose(R.Shutdown)).toBe(false);
    expect(shouldTearDownAgentOnClose(R.Extension)).toBe(false);
    expect(shouldTearDownAgentOnClose(R.Process)).toBe(false);
    expect(shouldTearDownAgentOnClose(R.Unknown)).toBe(false);
    expect(shouldTearDownAgentOnClose(undefined)).toBe(false);
  });
});

describe('maybeTearDownAgentOnClose', () => {
  test('user close of a local tab stops the session with --local', async () => {
    const calls: Array<{ id: string; local: boolean }> = [];
    await maybeTearDownAgentOnClose({
      reason: R.User,
      sessionId: 'abcd1234',
      host: undefined,
      stop: async (id, o) => { calls.push({ id, local: o.local }); },
    });
    expect(calls).toEqual([{ id: 'abcd1234', local: true }]);
  });

  test('user close of an offloaded tab (host set) stops WITHOUT --local so the CLI hops to the box', async () => {
    const calls: Array<{ id: string; local: boolean }> = [];
    await maybeTearDownAgentOnClose({
      reason: R.User,
      sessionId: 'abcd1234',
      host: 'yosemite-s0',
      stop: async (id, o) => { calls.push({ id, local: o.local }); },
    });
    expect(calls).toEqual([{ id: 'abcd1234', local: false }]);
  });

  test('a window RELOAD (Shutdown) does NOT stop the session — restore reattaches it', async () => {
    let called = false;
    await maybeTearDownAgentOnClose({
      reason: R.Shutdown,
      sessionId: 'abcd1234',
      host: undefined,
      stop: async () => { called = true; },
    });
    expect(called).toBe(false);
  });

  test('a user close of a tab with no bound session id is a no-op (nothing to stop)', async () => {
    let called = false;
    await maybeTearDownAgentOnClose({
      reason: R.User,
      sessionId: undefined,
      host: undefined,
      stop: async () => { called = true; },
    });
    expect(called).toBe(false);
  });
});
