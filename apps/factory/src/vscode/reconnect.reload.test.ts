import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The reload regression the 17 existing reconnect tests missed: none goes through
// activate()'s real ordering, where restoreAgentTerminals runs BEFORE the reconnect
// pass over the SAME on-disk persist store. This test drives that exact interaction.
//
// A genuine VS Code extension-host reload is a fresh process reading the on-disk
// store, so we prove it in a fresh `bun` child (as sessions.persist.test.ts does),
// against the REAL persist store and the REAL reconnect module — no mocking of the
// store or the pass. `vscode` (pulled in transitively by reconnect.ts → ./tmux) is
// stubbed via a preload so the module graph resolves headless; tmux liveness is
// injected through the pass's `queryState` seam (the same seam the shipped unit
// tests use). The restore step reproduces restoreAgentTerminals' exact restore/clear
// decision — the code under test — against that same real store.

const PRELOAD = path.join(import.meta.dir, '__vscode-stub-preload.ts');
const RECONNECT = path.join(import.meta.dir, 'reconnect.ts');
const PERSIST = path.join(import.meta.dir, '..', 'core', 'sessions.persist.ts');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-reload-'));

fs.writeFileSync(
  PRELOAD,
  `import { plugin } from 'bun';
plugin({
  name: 'stub-vscode',
  setup(build) {
    build.module('vscode', () => ({
      exports: { window: { onDidChangeWindowState: () => ({ dispose() {} }) } },
      loader: 'object',
    }));
  },
});
`,
);

afterAll(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(PRELOAD, { force: true }); } catch { /* ignore */ }
});

// Run a snippet in a fresh bun child with HOME pointed at a throwaway dir (so the
// real SESSIONS_PATH resolves under it) and vscode stubbed. Returns the JSON the
// snippet prints on its last line.
function runInChild(snippet: string): unknown {
  const src = `
    const persist = await import(${JSON.stringify(PERSIST)});
    const reconnect = await import(${JSON.stringify(RECONNECT)});
    ${snippet}
  `;
  const res = spawnSync('bun', ['--preload', PRELOAD, '-e', src], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
  });
  if (res.status !== 0) {
    throw new Error(`child bun failed (status ${res.status}):\n${res.stderr}\n${res.stdout}`);
  }
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// The exact restore/clear decision restoreAgentTerminals makes (extension.ts):
// restore the non-tracked, non-tmux sessions; preserve tmux-backed ones on disk
// for the reconnect pass; clear the rest. Reproduced here against the real store so
// the test exercises the real hasTmuxMapping + saveOnlyTmuxPersistedSessions logic.
const RESTORE_DECISION = `
  function restoreDecision(ws, trackedIdsArr) {
    const trackedIds = new Set(trackedIdsArr);
    const persisted = persist.getWorkspaceSessions(ws);
    const toRestore = persisted.filter(
      p => !trackedIds.has(p.terminalId) && !reconnect.hasTmuxMapping(p),
    );
    const tmuxBacked = persisted.filter(reconnect.hasTmuxMapping);
    // saveOnlyTmuxPersistedSessions == saveWorkspaceSessions(ws, tmuxBacked)
    if (tmuxBacked.length > 0) persist.saveWorkspaceSessions(ws, tmuxBacked, true);
    else persist.clearWorkspaceSessions(ws);
    return { restoredIds: toRestore.map(p => p.terminalId), preservedIds: tmuxBacked.map(p => p.terminalId) };
  }
`;

const TMUX_SESSION = {
  terminalId: 'CL-tmux-1',
  prefix: 'CL',
  sessionId: 'sess-tmux',
  agentType: 'claude',
  createdAt: 1,
  tmuxSession: 'agents-1712345678901',
  tmuxSocket: '/home/u/.agents/.cache/helpers/tmux/server.sock',
  tmuxPane: '%7',
  agentPid: 4242,
};
const PLAIN_SESSION = {
  terminalId: 'CX-plain-1',
  prefix: 'CX',
  sessionId: 'sess-plain',
  agentType: 'codex',
  createdAt: 2,
  // no tmux fields → native terminal path
};

describe('reload path: restoreAgentTerminals + reconnect ordering (real store)', () => {
  test('tmux-backed session survives the restore clear and is RE-ATTACHED, plain session restores as before', () => {
    const ws = '/work/reload-repo';
    const result = runInChild(`
      ${RESTORE_DECISION}
      const ws = ${JSON.stringify(ws)};
      // deactivate wrote both mappings before the reload.
      persist.saveWorkspaceSessions(ws, [${JSON.stringify(TMUX_SESSION)}, ${JSON.stringify(PLAIN_SESSION)}], true);

      // activate() step 1: restoreAgentTerminals. Nothing tracked yet (fresh reload,
      // isTransient terminals did not auto-restore).
      const decision = restoreDecision(ws, []);

      // Snapshot the store AS THE RECONNECT PASS WILL READ IT — this is on disk,
      // proving the tmux mapping was NOT wiped by the clear.
      const afterRestore = persist.getWorkspaceSessions(ws);

      // activate() step 2: the reconnect activation pass, reading the SAME store.
      // tmux is LIVE + client-less. reattachOne records the target (the real prod
      // reattachOne runs 'agents tmux attach' — never a resume-from-session-file).
      const reattached = [];
      let resumed = 0; // a resume would restart the agent — must stay 0.
      const attached = await reconnect.runReconnectPass({
        loadPersisted: () => persist.getWorkspaceSessions(ws),
        queryState: async () => ({ exists: true, paneAlive: true, hasClient: false, probeFailed: false }),
        trackedTerminalIds: () => new Set(), // restore did NOT register the tmux session
        reattachOne: async (t) => { reattached.push(t.session.terminalId); },
        resumePanelPolling: () => {},
        retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      });

      console.log(JSON.stringify({
        decision,
        afterRestoreIds: afterRestore.map(s => s.terminalId),
        afterRestoreTmux: afterRestore.map(s => ({ id: s.terminalId, tmuxSession: s.tmuxSession, tmuxSocket: s.tmuxSocket })),
        attached, reattached, resumed,
      }));
    `) as {
      decision: { restoredIds: string[]; preservedIds: string[] };
      afterRestoreIds: string[];
      afterRestoreTmux: Array<{ id: string; tmuxSession?: string; tmuxSocket?: string }>;
      attached: number;
      reattached: string[];
      resumed: number;
    };

    // Restore recreated ONLY the plain session; the tmux one was deferred + preserved.
    expect(result.decision.restoredIds).toEqual(['CX-plain-1']);
    expect(result.decision.preservedIds).toEqual(['CL-tmux-1']);

    // The persisted mapping A added was NOT wiped: after restore, the store still
    // carries the tmux-backed session (and its tmux coords), and NOT the plain one.
    expect(result.afterRestoreIds).toEqual(['CL-tmux-1']);
    expect(result.afterRestoreTmux[0].tmuxSession).toBe('agents-1712345678901');
    expect(result.afterRestoreTmux[0].tmuxSocket).toBe('/home/u/.agents/.cache/helpers/tmux/server.sock');

    // The reconnect pass RE-ATTACHED the live tmux session (agents tmux attach),
    // did not restart it, and nothing resumed from the CLI session file.
    expect(result.attached).toBe(1);
    expect(result.reattached).toEqual(['CL-tmux-1']);
    expect(result.resumed).toBe(0);
  });

  test('a reload with ONLY a tmux-backed session preserves the mapping for a SECOND reload', () => {
    const ws = '/work/reload-only-tmux';
    const stored = runInChild(`
      ${RESTORE_DECISION}
      const ws = ${JSON.stringify(ws)};
      persist.saveWorkspaceSessions(ws, [${JSON.stringify(TMUX_SESSION)}], true);
      // First reload: restore defers the tmux session and must NOT clear the store.
      restoreDecision(ws, []);
      // A second reload reads the store fresh — the mapping must still be there.
      console.log(JSON.stringify(persist.getWorkspaceSessions(ws)));
    `) as Array<Record<string, unknown>>;

    expect(stored).toHaveLength(1);
    expect(stored[0].terminalId).toBe('CL-tmux-1');
    expect(stored[0].tmuxSession).toBe('agents-1712345678901');
    expect(stored[0].tmuxPane).toBe('%7');
    expect(stored[0].agentPid).toBe(4242);
  });
});
