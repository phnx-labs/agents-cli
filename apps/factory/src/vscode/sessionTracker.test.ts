import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import type * as vscode from 'vscode';

mock.module('vscode', () => ({
  window: { onDidCloseTerminal: () => ({ dispose: () => {} }) },
  workspace: { workspaceFolders: undefined },
}));

const {
  __reset,
  __testRegister,
  __testGetStartTime,
  onSessionChanged,
  registerTerminal,
  unregisterTerminal,
} = await import('./sessionTracker');

function fakeTerminal(name: string): vscode.Terminal {
  return { name, processId: Promise.resolve(undefined) } as unknown as vscode.Terminal;
}

function terminalWithPid(name: string, pid: number): vscode.Terminal {
  return { name, processId: Promise.resolve(pid) } as unknown as vscode.Terminal;
}

function waitMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-'));
  __reset();
});

afterEach(() => {
  __reset();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('sessionTracker — Claude fork detection', () => {
  test('fires onSessionChanged when a new jsonl with forkedFrom.sessionId appears', async () => {
    const oldSessionId = '11111111-1111-1111-1111-111111111111';
    const newSessionId = '22222222-2222-2222-2222-222222222222';
    const term = fakeTerminal('CC-test');

    const events: Array<{ oldId: string | undefined; newId: string }> = [];
    onSessionChanged((_t, oldId, newId) => {
      events.push({ oldId, newId });
    });

    __testRegister(term, 'claude', [tmpDir], oldSessionId);

    const newFile = path.join(tmpDir, `${newSessionId}.jsonl`);
    const line = JSON.stringify({
      type: 'user',
      forkedFrom: { sessionId: oldSessionId },
      sessionId: newSessionId,
    });
    fs.writeFileSync(newFile, line + '\n');

    await waitMs(600);

    expect(events.length).toBe(1);
    expect(events[0].oldId).toBe(oldSessionId);
    expect(events[0].newId).toBe(newSessionId);

    unregisterTerminal(term);
  });

  test('ignores files without forkedFrom that do not match a dormant terminal', async () => {
    const oldSessionId = '33333333-3333-3333-3333-333333333333';
    const term = fakeTerminal('CC-live');

    const events: Array<string> = [];
    onSessionChanged((_t, _oldId, newId) => {
      events.push(newId);
    });

    __testRegister(term, 'claude', [tmpDir], oldSessionId);

    const trackedFile = path.join(tmpDir, `${oldSessionId}.jsonl`);
    fs.writeFileSync(trackedFile, '');
    await waitMs(500);
    fs.appendFileSync(trackedFile, '{"type":"user"}\n');
    await waitMs(100);

    const unrelatedFile = path.join(tmpDir, `44444444-4444-4444-4444-444444444444.jsonl`);
    fs.writeFileSync(unrelatedFile, '{"type":"user","sessionId":"unrelated"}\n');

    await waitMs(600);

    expect(events.length).toBe(0);

    unregisterTerminal(term);
  });
});

describe('sessionTracker — Codex rollout adoption (no prior sessionId)', () => {
  test('adopts existing rollout file on register when cwd matches', async () => {
    const existingSessionId = '019dcbf2-eeee-7fe1-aa30-1eede3d9e796';
    const term = fakeTerminal('CX-existing');

    const events: Array<{ oldId: string | undefined; newId: string }> = [];
    onSessionChanged((_t, oldId, newId) => {
      events.push({ oldId, newId });
    });

    const rollout = path.join(tmpDir, `rollout-2026-04-26T00-00-00-${existingSessionId}.jsonl`);
    fs.writeFileSync(rollout, JSON.stringify({
      timestamp: '2026-04-26T07:36:40.810Z',
      type: 'session_meta',
      payload: {
        id: existingSessionId,
        cwd: '/__test__',
        originator: 'codex-tui',
        cli_version: '0.124.0',
      },
    }) + '\n');

    // Register after file already exists — verifies proactive backfill.
    __testRegister(term, 'codex', [tmpDir], undefined);

    await waitMs(600);

    expect(events.length).toBe(1);
    expect(events[0].oldId).toBeUndefined();
    expect(events[0].newId).toBe(`rollout-2026-04-26T00-00-00-${existingSessionId}`);

    unregisterTerminal(term);
  });

  test('adopts session id from new rollout-*.jsonl when cwd matches', async () => {
    const newSessionId = '019dcbf2-e44c-7fe1-aa30-1eede3d9e796';
    const term = fakeTerminal('CX-test');

    const events: Array<{ oldId: string | undefined; newId: string }> = [];
    onSessionChanged((_t, oldId, newId) => {
      events.push({ oldId, newId });
    });

    // Register codex terminal with NO sessionId — simulates Codex 0.124+ banner
    // with no session id printed. workspacePath is '/__test__' via __testRegister.
    __testRegister(term, 'codex', [tmpDir], undefined);

    const rollout = path.join(tmpDir, `rollout-2026-04-26T00-00-00-${newSessionId}.jsonl`);
    const meta = JSON.stringify({
      timestamp: '2026-04-26T07:36:40.810Z',
      type: 'session_meta',
      payload: {
        id: newSessionId,
        cwd: '/__test__',
        originator: 'codex-tui',
        cli_version: '0.124.0',
      },
    });
    fs.writeFileSync(rollout, meta + '\n');

    await waitMs(600);

    expect(events.length).toBe(1);
    expect(events[0].oldId).toBeUndefined();
    // Filename-derived id matches payload id
    expect(events[0].newId).toBe(`rollout-2026-04-26T00-00-00-${newSessionId}`);

    unregisterTerminal(term);
  });

  test('ignores rollout when cwd does not match any tracked terminal', async () => {
    const term = fakeTerminal('CX-mismatch');

    const events: string[] = [];
    onSessionChanged((_t, _oldId, newId) => events.push(newId));

    __testRegister(term, 'codex', [tmpDir], undefined);

    const otherSessionId = '019dcbf2-aaaa-7fe1-aa30-1eede3d9e796';
    const rollout = path.join(tmpDir, `rollout-2026-04-26T00-00-00-${otherSessionId}.jsonl`);
    fs.writeFileSync(rollout, JSON.stringify({
      type: 'session_meta',
      payload: { id: otherSessionId, cwd: '/some/other/workspace', originator: 'codex-tui' },
    }) + '\n');

    await waitMs(600);

    expect(events.length).toBe(0);
    unregisterTerminal(term);
  });

  test('routes new rollout to unbound same-cwd terminal when another terminal already has a different session', async () => {
    const existingSessionId = '019dcbf2-aaaa-7fe1-aa30-1eede3d9e700';
    const newSessionId = '019dcbf2-bbbb-7fe1-aa30-1eede3d9e701';
    const bound = fakeTerminal('CX-bound');
    const unbound = fakeTerminal('CX-unbound');

    const events: Array<{ terminal: vscode.Terminal; oldId: string | undefined; newId: string }> = [];
    onSessionChanged((terminal, oldId, newId) => {
      events.push({ terminal, oldId, newId });
    });

    // Existing codex terminal already bound to a different session.
    __testRegister(bound, 'codex', [tmpDir], existingSessionId);
    // Same workspace, no session yet (Codex 0.124+ flow).
    __testRegister(unbound, 'codex', [tmpDir], undefined);

    const rollout = path.join(tmpDir, `rollout-2026-04-26T00-00-00-${newSessionId}.jsonl`);
    fs.writeFileSync(rollout, JSON.stringify({
      timestamp: '2026-04-26T07:36:40.810Z',
      type: 'session_meta',
      payload: {
        id: newSessionId,
        cwd: '/__test__',
        originator: 'codex-tui',
        cli_version: '0.124.0',
      },
    }) + '\n');

    await waitMs(600);

    const matching = events.filter(e => e.newId === `rollout-2026-04-26T00-00-00-${newSessionId}`);
    expect(matching.length).toBe(1);
    expect(matching[0].terminal).toBe(unbound);
    expect(matching[0].oldId).toBeUndefined();

    unregisterTerminal(bound);
    unregisterTerminal(unbound);
  });
});

describe('sessionTracker — Gemini/OpenCode adoption (no prior sessionId)', () => {
  test('adopts existing gemini session file on register when project hash matches', async () => {
    const term = fakeTerminal('GX-existing');
    const geminiSessionId = '6f8f7c61-8b95-4d84-bf52-7ed8a29f33d3';
    const expectedProjectHash = createHash('sha256').update('/__test__').digest('hex');

    const events: Array<{ oldId: string | undefined; newId: string }> = [];
    onSessionChanged((_t, oldId, newId) => {
      events.push({ oldId, newId });
    });

    const geminiFile = path.join(tmpDir, 'session-2026-05-04T01-00-deadbeef.json');
    fs.writeFileSync(geminiFile, JSON.stringify({
      sessionId: geminiSessionId,
      projectHash: expectedProjectHash,
      messages: [],
    }) + '\n');

    __testRegister(term, 'gemini', [tmpDir], undefined);
    await waitMs(600);

    expect(events.length).toBe(1);
    expect(events[0].oldId).toBeUndefined();
    expect(events[0].newId).toBe(geminiSessionId);
    unregisterTerminal(term);
  });

  test('adopts existing opencode session file on register when directory matches', async () => {
    const term = fakeTerminal('OC-existing');
    const opencodeSessionId = 'ses_41c85c5a8fferH3SOowLblaPCy';

    const events: Array<{ oldId: string | undefined; newId: string }> = [];
    onSessionChanged((_t, oldId, newId) => {
      events.push({ oldId, newId });
    });

    const opencodeFile = path.join(tmpDir, `${opencodeSessionId}.json`);
    fs.writeFileSync(opencodeFile, JSON.stringify({
      id: opencodeSessionId,
      directory: '/__test__',
      projectID: 'test-project',
    }) + '\n');

    __testRegister(term, 'opencode', [tmpDir], undefined);
    await waitMs(600);

    expect(events.length).toBe(1);
    expect(events[0].oldId).toBeUndefined();
    expect(events[0].newId).toBe(opencodeSessionId);
    unregisterTerminal(term);
  });

  test('routes new gemini sessions to matching workspace hash across multiple terminals', async () => {
    const termA = fakeTerminal('GX-A');
    const termB = fakeTerminal('GX-B');
    const workspaceA = '/__workspace__/a';
    const workspaceB = '/__workspace__/b';
    const sessionA = '60f2bc29-6f55-4463-824b-e5e7f6b0e1a1';
    const sessionB = 'fe95857c-b07f-4f9b-bfd5-80285f01f5f7';
    const hashA = createHash('sha256').update(workspaceA).digest('hex');
    const hashB = createHash('sha256').update(workspaceB).digest('hex');

    const events: Array<{ terminal: vscode.Terminal; newId: string }> = [];
    onSessionChanged((terminal, _oldId, newId) => {
      events.push({ terminal, newId });
    });

    __testRegister(termA, 'gemini', [tmpDir], undefined, workspaceA);
    __testRegister(termB, 'gemini', [tmpDir], undefined, workspaceB);

    fs.writeFileSync(path.join(tmpDir, 'session-a.json'), JSON.stringify({
      sessionId: sessionA,
      projectHash: hashA,
      messages: [],
    }) + '\n');
    fs.writeFileSync(path.join(tmpDir, 'session-b.json'), JSON.stringify({
      sessionId: sessionB,
      projectHash: hashB,
      messages: [],
    }) + '\n');

    await waitMs(700);

    const routedA = events.find((e) => e.newId === sessionA);
    const routedB = events.find((e) => e.newId === sessionB);
    expect(routedA).toBeTruthy();
    expect(routedB).toBeTruthy();
    expect(routedA!.terminal).toBe(termA);
    expect(routedB!.terminal).toBe(termB);

    unregisterTerminal(termA);
    unregisterTerminal(termB);
  });

  test('routes new gemini session to unbound same-workspace terminal when another is already bound', async () => {
    const workspace = '/__workspace__/shared';
    const projectHash = createHash('sha256').update(workspace).digest('hex');
    const boundSession = '9d89f4f0-2a43-4a8f-b822-8f2f54666c43';
    const newSession = '7f744f17-fd89-4c30-92b4-b4742837f533';
    const bound = fakeTerminal('GX-bound');
    const unbound = fakeTerminal('GX-unbound');

    const events: Array<{ terminal: vscode.Terminal; oldId: string | undefined; newId: string }> = [];
    onSessionChanged((terminal, oldId, newId) => {
      events.push({ terminal, oldId, newId });
    });

    __testRegister(bound, 'gemini', [tmpDir], boundSession, workspace);
    __testRegister(unbound, 'gemini', [tmpDir], undefined, workspace);

    fs.writeFileSync(path.join(tmpDir, 'session-new.json'), JSON.stringify({
      sessionId: newSession,
      projectHash,
      messages: [],
    }) + '\n');

    await waitMs(700);

    const matching = events.filter((e) => e.newId === newSession);
    expect(matching.length).toBe(1);
    expect(matching[0].terminal).toBe(unbound);
    expect(matching[0].oldId).toBeUndefined();

    unregisterTerminal(bound);
    unregisterTerminal(unbound);
  });

  test('assigns distinct session ids when two unbound gemini terminals share one workspace', async () => {
    const workspace = '/__workspace__/shared-2';
    const projectHash = createHash('sha256').update(workspace).digest('hex');
    const session1 = 'fe50d2f7-2f7f-40c6-a393-9fb1e8a663ee';
    const session2 = '2c2fcb54-b928-4f01-95f8-40d57a998a6f';
    const term1 = fakeTerminal('GX-1');
    const term2 = fakeTerminal('GX-2');

    const events: Array<{ terminal: vscode.Terminal; newId: string }> = [];
    onSessionChanged((terminal, _oldId, newId) => {
      events.push({ terminal, newId });
    });

    __testRegister(term1, 'gemini', [tmpDir], undefined, workspace);
    __testRegister(term2, 'gemini', [tmpDir], undefined, workspace);

    fs.writeFileSync(path.join(tmpDir, 'session-1.json'), JSON.stringify({
      sessionId: session1,
      projectHash,
      messages: [],
    }) + '\n');
    await waitMs(700);

    fs.writeFileSync(path.join(tmpDir, 'session-2.json'), JSON.stringify({
      sessionId: session2,
      projectHash,
      messages: [],
    }) + '\n');
    await waitMs(700);

    const event1 = events.find((e) => e.newId === session1);
    const event2 = events.find((e) => e.newId === session2);
    expect(event1).toBeTruthy();
    expect(event2).toBeTruthy();
    expect(event1!.terminal).not.toBe(event2!.terminal);

    unregisterTerminal(term1);
    unregisterTerminal(term2);
  });
});

describe('sessionTracker — lifecycle', () => {
  test('registerTerminal is idempotent', () => {
    const term = fakeTerminal('CC-idemp');
    registerTerminal(term, 'claude', '/nonexistent/workspace', 'abc');
    registerTerminal(term, 'claude', '/nonexistent/workspace', 'abc');
    unregisterTerminal(term);
  });

  test('unregisterTerminal without register is a no-op', () => {
    const term = fakeTerminal('CC-noop');
    unregisterTerminal(term);
  });
});

// ─── Bug proofs ──────────────────────────────────────────────────────────────

describe('BUG: wrong version path — versioned Claude dirs not watched', () => {
  test('session file in a secondary root is detected when that root is registered', async () => {
    // Proves the mechanism works — if both roots are given, both are watched.
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-base-'));
    const versionedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ver-'));
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const term = fakeTerminal('CC-versioned');

    const events: string[] = [];
    onSessionChanged((_t, _old, newId) => events.push(newId));

    // Register with BOTH roots (what the correct code would do)
    __testRegister(term, 'claude', [baseRoot, versionedRoot], sessionId);

    const forkId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    fs.writeFileSync(
      path.join(versionedRoot, `${forkId}.jsonl`),
      JSON.stringify({ forkedFrom: { sessionId } }) + '\n'
    );
    await waitMs(600);

    expect(events).toContain(forkId);
    unregisterTerminal(term);
    fs.rmSync(baseRoot, { recursive: true, force: true });
    fs.rmSync(versionedRoot, { recursive: true, force: true });
  });

  test('session file in a secondary root is NOT detected when only the base root is registered', async () => {
    // Proves the bug: if claudeVersionDirs() returns [], the versioned root is
    // never watched and new sessions created there are silently dropped.
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-base-'));
    const versionedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ver-'));
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
    const term = fakeTerminal('CC-base-only');

    const events: string[] = [];
    onSessionChanged((_t, _old, newId) => events.push(newId));

    // Register with ONLY the base root (what the buggy code does when
    // ~/.agents/versions/claude/ doesn't exist and claudeVersionDirs() → [])
    __testRegister(term, 'claude', [baseRoot], sessionId);

    const forkId = 'ffffffff-ffff-ffff-ffff-222222222222';
    fs.writeFileSync(
      path.join(versionedRoot, `${forkId}.jsonl`),
      JSON.stringify({ forkedFrom: { sessionId } }) + '\n'
    );
    await waitMs(600);

    // No event — versioned root not watched
    expect(events).toHaveLength(0);
    unregisterTerminal(term);
    fs.rmSync(baseRoot, { recursive: true, force: true });
    fs.rmSync(versionedRoot, { recursive: true, force: true });
  });
});

describe('BUG: /continue chain-break — warm old file blocks correlateKillRestart', () => {
  test('new fork whose forkedFrom is untracked AND old file is warm → silently dropped', async () => {
    // Scenario: terminal tracked with sessionId=A, old A.jsonl is warm.
    // New B.jsonl appears with forkedFrom=X (not A — chain break).
    // findTrackedBySessionId(X) misses → falls to correlateKillRestart.
    // A.jsonl was just written → not dormant → correlateKillRestart bails.
    // Result: B is never attributed to any terminal.
    const oldSessionId = '11111111-0000-0000-0000-000000000001';
    const term = fakeTerminal('CC-warm-chain-break');

    const events: string[] = [];
    onSessionChanged((_t, _old, newId) => events.push(newId));

    __testRegister(term, 'claude', [tmpDir], oldSessionId);

    // Warm the old tracked file (simulates Claude writing to it during /continue)
    const trackedFile = path.join(tmpDir, `${oldSessionId}.jsonl`);
    fs.writeFileSync(trackedFile, '{"type":"user"}\n');
    await waitMs(400);
    fs.appendFileSync(trackedFile, '{"type":"assistant"}\n');
    await waitMs(50);

    // New session with forkedFrom pointing to a DIFFERENT (untracked) parent
    const unknownParent = 'deadbeef-0000-0000-0000-000000000000';
    const newSessionId = '22222222-0000-0000-0000-000000000002';
    fs.writeFileSync(
      path.join(tmpDir, `${newSessionId}.jsonl`),
      JSON.stringify({ forkedFrom: { sessionId: unknownParent } }) + '\n'
    );
    await waitMs(600);

    // Bug: new session silently dropped — no event fires
    expect(events).toHaveLength(0);
    unregisterTerminal(term);
  });

  test('new session without forkedFrom AND old file is dormant → fires via correlateKillRestart', async () => {
    // Complement: proves correlateKillRestart DOES work when the file is dormant.
    // CRITICAL PRECONDITION: trackedFile must be set via a prior applyChange.
    // A freshly registered terminal with no adoption has trackedFile=undefined,
    // so correlateKillRestart skips it entirely (filter at sessionTracker.ts:393).
    // We set up the precondition by first letting a forked session be adopted.
    const session1 = '33333333-0000-0000-0000-000000000003';
    const session2 = '44444444-0000-0000-0000-000000000004';
    const session3 = '55555555-0000-0000-0000-000000000005';
    const term = fakeTerminal('CC-dormant-restart');

    const events: string[] = [];
    onSessionChanged((_t, _old, newId) => events.push(newId));

    // Register with session1 — trackedFile is NOT yet set
    __testRegister(term, 'claude', [tmpDir], session1);

    // Step 1: session2 forks from session1 → applyChange fires → trackedFile=session2.jsonl
    fs.writeFileSync(
      path.join(tmpDir, `${session2}.jsonl`),
      JSON.stringify({ forkedFrom: { sessionId: session1 } }) + '\n'
    );
    await waitMs(600);
    expect(events).toContain(session2); // adoption confirmed, trackedFile now set

    // Step 2: wait past DORMANT_THRESHOLD_MS so session2.jsonl goes dormant
    await waitMs(11000);

    // Step 3: session3 appears without forkedFrom — correlateKillRestart should pick it up
    fs.writeFileSync(
      path.join(tmpDir, `${session3}.jsonl`),
      '{"type":"user"}\n'
    );
    await waitMs(600);

    expect(events).toContain(session3);
    unregisterTerminal(term);
  }, 15000);
});

describe('BUG: Codex — yesterday\'s session directory not watched', () => {
  test('session file in yesterday\'s dir is NOT detected when only today\'s dir is registered', async () => {
    const todayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-today-'));
    const yesterdayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-yesterday-'));
    const newSessionId = 'rollout-2026-05-16T00-00-00-55555555-5555-5555-5555-555555555555';
    const term = fakeTerminal('CX-yesterday');

    const events: string[] = [];
    onSessionChanged((_t, _old, newId) => events.push(newId));

    // Register with ONLY today's dir (what codexRootToday() produces after midnight)
    __testRegister(term, 'codex', [todayDir], undefined);

    // Write rollout file in yesterday's dir
    fs.writeFileSync(
      path.join(yesterdayDir, `${newSessionId}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/__test__' } }) + '\n'
    );
    await waitMs(600);

    // Bug: file is in an unwatched directory — no event fires
    expect(events).toHaveLength(0);
    unregisterTerminal(term);
    fs.rmSync(todayDir, { recursive: true, force: true });
    fs.rmSync(yesterdayDir, { recursive: true, force: true });
  });

  test('session file in yesterday\'s dir IS detected when that dir is also registered', async () => {
    const todayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-today2-'));
    const yesterdayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-yest2-'));
    const newSessionId = 'rollout-2026-05-16T00-00-00-66666666-6666-6666-6666-666666666666';
    const term = fakeTerminal('CX-yesterday-fix');

    const events: string[] = [];
    onSessionChanged((_t, _old, newId) => events.push(newId));

    // Register with BOTH dirs (what the fix would do)
    __testRegister(term, 'codex', [todayDir, yesterdayDir], undefined);

    fs.writeFileSync(
      path.join(yesterdayDir, `${newSessionId}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/__test__' } }) + '\n'
    );
    await waitMs(600);

    expect(events.some(id => id.includes('66666666'))).toBe(true);
    unregisterTerminal(term);
    fs.rmSync(todayDir, { recursive: true, force: true });
    fs.rmSync(yesterdayDir, { recursive: true, force: true });
  });
});

describe('sessionTracker — start-time capture on registration (#97)', () => {
  test('captures the shell process start time via real ps when a terminal registers', async () => {
    // A real child process gives registerTerminal a live pid to resolve and run
    // `ps -p <pid> -o lstart=` against, exercising the capture wiring end to end
    // (terminal.processId -> captureProcessStartTime -> entry.startTimeMs).
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const term = terminalWithPid('CC-startcapture', child.pid!);
    try {
      registerTerminal(term, 'claude', '/__test__', undefined);
      // captureStartTime is fire-and-forget (awaits processId then ps); give the
      // single ps round-trip time to resolve before asserting.
      await waitMs(400);

      const start = __testGetStartTime(term);
      expect(typeof start).toBe('number');
      const now = Date.now();
      expect(start!).toBeLessThanOrEqual(now);
      expect(start!).toBeGreaterThan(now - 24 * 60 * 60 * 1000);
    } finally {
      unregisterTerminal(term);
      child.kill('SIGKILL');
    }
  });

  test('leaves start time undefined when the terminal has no pid', async () => {
    const term = fakeTerminal('CC-nopid');
    try {
      registerTerminal(term, 'claude', '/__test__', undefined);
      await waitMs(200);
      // processId resolves to undefined -> capture bails, selection skips it.
      expect(__testGetStartTime(term)).toBeUndefined();
    } finally {
      unregisterTerminal(term);
    }
  });
});
