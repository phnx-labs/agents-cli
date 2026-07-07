// sessionTracker follower-routing — broadcast session facts drive correlation (#69).
//
// With the monitor "connected", the local fs.watch is suppressed (mountWatcher
// is a no-op) and broadcast session/warmth facts must drive the SAME terminal
// <-> sessionId correlation the local watcher does. No real files involved — the
// monitor already parsed them; this exercises the window-local correlation only.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import type * as vscode from 'vscode';

mock.module('vscode', () => ({
  window: { onDidCloseTerminal: () => ({ dispose: () => {} }) },
  workspace: { workspaceFolders: undefined },
}));

const {
  __reset,
  __testRegister,
  ingestSessionFact,
  ingestSessionWarmth,
  onSessionChanged,
  setMonitorConnectivity,
} = await import('./sessionTracker');
import type { SessionFactPayload } from '../monitor/protocol';

function fakeTerminal(name: string): vscode.Terminal {
  return { name, processId: Promise.resolve(undefined) } as unknown as vscode.Terminal;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fact(over: Partial<SessionFactPayload>): SessionFactPayload {
  return {
    agentType: 'claude',
    filePath: '/tmp/unused.jsonl',
    fileSessionId: 'unused',
    mtimeMs: 0,
    ...over,
  };
}

beforeEach(() => {
  __reset();
  setMonitorConnectivity(() => true);
});

afterEach(() => {
  setMonitorConnectivity(() => false);
  __reset();
});

describe('sessionTracker follower routing', () => {
  test('ingestSessionFact correlates a claude fork to its tracked terminal', async () => {
    const oldId = '11111111-1111-1111-1111-111111111111';
    const newId = '22222222-2222-2222-2222-222222222222';
    const term = fakeTerminal('CC-fork');

    const events: Array<{ oldId: string | undefined; newId: string }> = [];
    onSessionChanged((_t, o, n) => events.push({ oldId: o, newId: n }));

    // Connected: no local watcher mounts; the terminal is just tracked.
    __testRegister(term, 'claude', ['/__no_watch__'], oldId);

    ingestSessionFact(
      fact({
        agentType: 'claude',
        filePath: `/x/${newId}.jsonl`,
        fileSessionId: newId,
        forkedFromId: oldId,
      }),
    );
    await waitMs(50);

    expect(events.length).toBe(1);
    expect(events[0].oldId).toBe(oldId);
    expect(events[0].newId).toBe(newId);
  });

  test('ingestSessionFact routes a gemini session by project hash', async () => {
    const workspace = '/__ws__/gemini';
    const projectHash = createHash('sha256').update(workspace).digest('hex');
    const sessionId = '6f8f7c61-8b95-4d84-bf52-7ed8a29f33d3';
    const term = fakeTerminal('GX-hash');

    const events: string[] = [];
    onSessionChanged((_t, _o, n) => events.push(n));

    __testRegister(term, 'gemini', ['/__no_watch__'], undefined, workspace);

    ingestSessionFact(
      fact({
        agentType: 'gemini',
        filePath: '/x/session.json',
        fileSessionId: 'session',
        geminiSessionId: sessionId,
        geminiProjectHash: projectHash,
      }),
    );
    await waitMs(50);

    expect(events).toContain(sessionId);
  });

  test('warmth keeps a tracked file from being stolen by kill/restart correlation', async () => {
    // Two codex terminals would both look dormant; warmth on the first's file
    // proves the dormancy clock is driven by broadcast warmth facts.
    const session1 = '019dcbf2-aaaa-7fe1-aa30-1eede3d9e700';
    const term = fakeTerminal('CX-warm');

    const events: string[] = [];
    onSessionChanged((_t, _o, n) => events.push(n));

    __testRegister(term, 'codex', ['/__no_watch__'], undefined);
    // Adopt an initial session so trackedFile is set.
    ingestSessionFact(
      fact({
        agentType: 'codex',
        filePath: `/x/rollout-${session1}.jsonl`,
        fileSessionId: `rollout-${session1}`,
        codexCwd: '/__test__',
      }),
    );
    await waitMs(50);
    expect(events).toContain(`rollout-${session1}`);

    // Keep it warm via broadcast warmth — a new unrelated session must NOT steal
    // it (still active, not dormant).
    ingestSessionWarmth(`/x/rollout-${session1}.jsonl`);
    const session2 = '019dcbf2-bbbb-7fe1-aa30-1eede3d9e701';
    ingestSessionFact(
      fact({
        agentType: 'codex',
        filePath: `/x/rollout-${session2}.jsonl`,
        fileSessionId: `rollout-${session2}`,
        // No cwd match and the only terminal is warm -> dropped.
      }),
    );
    await waitMs(50);

    expect(events).not.toContain(`rollout-${session2}`);
  });
});
