import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type * as vscode from 'vscode';

// Minimal vscode mock
mock.module('vscode', () => ({
  window: {
    terminals: [],
    onDidCloseTerminal: () => ({ dispose: () => {} }),
    onDidOpenTerminal: () => ({ dispose: () => {} }),
    onDidChangeActiveTerminal: () => ({ dispose: () => {} }),
    onDidChangeTabs: () => ({ dispose: () => {} }),
  },
  workspace: { workspaceFolders: undefined },
  TabInputTerminal: class {},
  window2: undefined,
}));

mock.module('./agents.vscode', () => ({
  getBuiltInByKey: () => undefined,
}));

mock.module('./sessions.vscode', () => ({
  getSessionPathBySessionId: () => undefined,
  getSessionPreviewInfo: () => Promise.resolve(null),
  getOpenCodeSessionPreviewInfo: () => Promise.resolve(null),
  getCursorSessionPreviewInfo: () => Promise.resolve(null),
  readTailLines: () => Promise.resolve(''),
}));

mock.module('../core/sessions.persist', () => ({
  buildPersistedSessions: () => [],
  savePersistedSessions: () => {},
  loadPersistedSessions: () => [],
  clearPersistedSessions: () => {},
  getWorkspaceSessions: () => [],
  persistWorkspaceSessions: () => {},
  updatePersistedSession: () => {},
  PersistedSession: {},
}));

mock.module('../core/session.activity', () => ({
  extractCurrentActivity: () => null,
  formatActivity: () => '',
  detectWaitingForInput: () => false,
}));

mock.module('../core/session.summary', () => ({
  extractSessionQuickDetails: () => Promise.resolve(null),
}));

const t = await import('./terminals.vscode');

function fakeTerm(name: string): vscode.Terminal {
  return { name, processId: Promise.resolve(undefined) } as unknown as vscode.Terminal;
}

function fakeAgentConfig() {
  return {
    title: 'Claude',
    command: 'claude',
    icon: undefined,
    prefix: 'CC',
    iconPath: undefined,
  } as any;
}

beforeEach(() => {
  t.clear();
});

// ─── Bug proofs ───────────────────────────────────────────────────────────────

describe('BUG C: setSessionId clears autoLabel on session change', () => {
  test('autoLabel is cleared by setSessionId when an existing session changes', () => {
    const term = fakeTerm('CC-bug-c');
    t.register(term, 'CC-001', fakeAgentConfig(), undefined);
    t.setSessionId(term, 'old-session-id-aaaa');

    // Simulate a label being set after first session adoption
    t.setAutoLabel(term, 'fix the auth bug');

    const before = t.getByTerminal(term);
    expect(before?.autoLabel).toBe('fix the auth bug');

    // Session changes (e.g. /continue creates a new session)
    t.setSessionId(term, 'new-session-id-aaaa');

    const after = t.getByTerminal(term);
    expect(after?.autoLabel).toBeUndefined();
    expect(after?.sessionId).toBe('new-session-id-aaaa');
  });
});

describe('BUG A: startAutoLabelPoller guard blocks restart once autoLabel is set', () => {
  test('pollFn is never called when autoLabel is already set', async () => {
    const term = fakeTerm('CC-bug-a');
    t.register(term, 'CC-002', fakeAgentConfig(), undefined);

    // Label was set from a previous session
    t.setAutoLabel(term, 'old label from session 1');

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => { pollCount++; });

    // Give the poller time to fire if it were running
    await new Promise(r => setTimeout(r, 50));

    // BUG: pollFn never called — guard `if (entry.autoLabel || entry.label) return` fires
    expect(pollCount).toBe(0);
  });

  test('pollFn IS called when autoLabel is not set', async () => {
    const term = fakeTerm('CC-no-bug');
    t.register(term, 'CC-003', fakeAgentConfig(), undefined);

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => { pollCount++; });

    await new Promise(r => setTimeout(r, 50));

    // Without a label, the poller starts and fires immediately
    expect(pollCount).toBeGreaterThan(0);

    t.stopAutoLabelPoller(term);
  });
});

describe('BUG A+B+C: full chain — session changes allow label refresh', () => {
  test('after onSessionChanged fires, label poller can restart because autoLabel is cleared', async () => {
    const term = fakeTerm('CC-full-chain');
    t.register(term, 'CC-004', fakeAgentConfig(), undefined);

    // Session 1 is adopted and labelled
    t.setSessionId(term, 'session-1');
    t.setAutoLabel(term, 'label from session 1');

    // Session changes (simulating onSessionChanged handler in extension.ts:596-600)
    t.setSessionId(term, 'session-2');
    // setSessionId clears autoLabel so startAutoLabelPoller is not blocked by the old label

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => { pollCount++; });
    await new Promise(r => setTimeout(r, 50));

    expect(pollCount).toBeGreaterThan(0);

    const entry = t.getByTerminal(term);
    expect(entry?.sessionId).toBe('session-2');      // session updated
    expect(entry?.autoLabel).toBeUndefined();
  });
});

describe('live tmux detach (SSH drop): entry + mapping survive for the reconnect pass', () => {
  const COORDS = { session: 'agents-1712345678901', socket: '/tmp/server.sock', pane: '%3' };

  test('markDetached keeps the entry, stamps coords, and buildPersistedSessions still emits the tmux mapping', () => {
    const term = fakeTerm('CC-detach');
    t.register(term, 'CC-detach-1', fakeAgentConfig(), undefined);
    t.setSessionId(term, 'sess-detach');
    t.setAgentType(term, 'claude' as any);

    // The client tab closed on a live tmux detach — the live tmux map is already
    // cleared, so the close handler passes the coords it snapshotted first.
    t.markDetached(term, COORDS);

    // The entry is KEPT (not unregistered) and flagged detached.
    const entry = t.getAllTerminals().find((e) => e.id === 'CC-detach-1');
    expect(entry).toBeDefined();
    expect(entry?.detached).toBe(true);

    // The durable mapping still lands in every persistence snapshot — sourced from
    // the stamped coords now that the live tmux map is gone. This is what the
    // reconnect pass loads to re-attach the still-live agent.
    const persisted = t.buildPersistedSessions();
    const row = persisted.find((p) => p.terminalId === 'CC-detach-1');
    expect(row).toBeDefined();
    expect(row?.tmuxSession).toBe('agents-1712345678901');
    expect(row?.tmuxSocket).toBe('/tmp/server.sock');
    expect(row?.tmuxPane).toBe('%3');
  });

  test('a detached id is excluded from the reconnect "tracked" set so the pass can re-attach it', () => {
    const live = fakeTerm('CC-live');
    const gone = fakeTerm('CC-gone');
    t.register(live, 'CC-live-1', fakeAgentConfig(), undefined);
    t.register(gone, 'CC-gone-1', fakeAgentConfig(), undefined);
    t.markDetached(gone, COORDS);

    // This is exactly buildReconnectDeps.trackedTerminalIds: LIVE tabs only.
    const tracked = new Set(
      t.getAllTerminals().filter((e) => !e.detached).map((e) => e.id),
    );
    expect(tracked.has('CC-live-1')).toBe(true);
    expect(tracked.has('CC-gone-1')).toBe(false); // detached → the pass will re-attach it
  });

  test('a fresh re-register under the same id clears the detached flag (reattach path)', () => {
    const term = fakeTerm('CC-reattach');
    t.register(term, 'CC-reattach-1', fakeAgentConfig(), undefined);
    t.markDetached(term, COORDS);
    expect(t.getAllTerminals().find((e) => e.id === 'CC-reattach-1')?.detached).toBe(true);

    // reattachSession spawns a new terminal and re-registers the same id.
    const fresh = fakeTerm('CC-reattach');
    t.register(fresh, 'CC-reattach-1', fakeAgentConfig(), undefined);
    const entry = t.getAllTerminals().find((e) => e.id === 'CC-reattach-1');
    expect(entry?.detached).toBeUndefined(); // no longer detached — it's a live tab again
  });
});

describe('BUG I: setLabel immediately stops autoLabelPoller', () => {
  test('poller interval is cleared after manual label is set via setLabel', async () => {
    const term = fakeTerm('CC-bug-i');
    t.register(term, 'CC-005', fakeAgentConfig(), undefined);

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => {
      pollCount++;
      // Simulate the poller setting the autoLabel on first run
      t.setAutoLabel(term, 'auto-generated');
    }, 50);

    await new Promise(r => setTimeout(r, 30));
    expect(pollCount).toBe(1); // immediate fire on start

    // User sets a manual label (Cmd+L), which stops the interval immediately
    const fakeContext = undefined as any;
    await t.setLabel(term, 'manual label', fakeContext);

    const entry = t.getByTerminal(term);
    expect(entry?.autoLabelPollerId).toBeUndefined();

    t.stopAutoLabelPoller(term);
  });
});
