/**
 * RUSH-2492 — `agents sessions focus|attach|resume|exec --resume <id>` must NOT
 * hard-abort session resolution when a fleet peer is offline. All four call
 * sites switch on the outcome of `resolveSessionMetadataValue`, so this pins the
 * two states that decide their behaviour, exercising the real resolver (real
 * local SQLite index in a temp HOME) with the documented `deps.gatherRemoteList`
 * seam standing in for the SSH fan-out — the same test seam used by the RUSH-2203
 * local-hit test in sessions.test.ts. No mocking of the decision itself: the fan
 * out RESULTS are fed as data, exactly the shape `metadataResolveOutcome` reads.
 *
 *   1. A session that lives on a REACHABLE peer resolves even when an unrelated
 *      device is offline → callers take the `resolved` branch and attach.
 *   2. A session found on NO reachable device stays `partial` (the offline peer
 *      may be hiding it) → callers now warn + report not-found instead of the old
 *      hard abort that treated the offline device as the blocker.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();

/** Drive the real resolver in a child process so HOME (hence the SQLite session
 * index) is a throwaway temp dir, never the developer's real sessions.db. */
function resolveWithFanout(selector: string, fanout: { sessions: unknown[]; unreachable: string[] }): { kind: string; sessionId?: string } {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-rush2492-'));
  try {
    const runner = [
      "const { resolveSessionMetadataValue } = await import('./src/commands/sessions.ts');",
      `const fanout = ${JSON.stringify(fanout)};`,
      // The injected fan-out returns the reachable hits + the unreachable peer
      // list; the real local index (empty temp HOME) contributes nothing.
      'const deps = { gatherRemoteList: async () => fanout };',
      `const outcome = await resolveSessionMetadataValue(${JSON.stringify(selector)}, {}, deps);`,
      "process.stdout.write(JSON.stringify({ kind: outcome.kind, sessionId: outcome.session && outcome.session.id }));",
    ].join(' ');
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', runner], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

describe('RUSH-2492 offline-peer session resolution', () => {
  const id = '71f4b54c-1111-2222-3333-444455556666';
  const onReachablePeer = {
    id,
    shortId: '71f4b54c',
    agent: 'claude',
    version: '2.1.45',
    mode: 'edit',
    machine: 'yosemite-s1',
    timestamp: '2026-08-10T09:29:43.616Z',
    filePath: '/sessions/claude.jsonl',
  };

  it('resolves a session that lives on a reachable peer even while a device is offline', () => {
    // The exact repro: id lives on reachable yosemite-s1, mac-mini is offline.
    // The resolver picks the reachable hit, so the caller attaches — it does NOT
    // abort just because mac-mini did not answer.
    const outcome = resolveWithFanout('71f4b54c', { sessions: [onReachablePeer], unreachable: ['mac-mini'] });
    expect(outcome).toEqual({ kind: 'resolved', sessionId: id });
  });

  it('stays partial only when the id is found on NO reachable device (it may be on the offline peer)', () => {
    // Nothing on any reachable box → the offline peer genuinely changes the
    // answer, so the resolver defers. This is the residual `partial` the four
    // call sites now degrade to a one-line warning + not-found, never a hard
    // "could not resolve because a device was down" abort.
    const outcome = resolveWithFanout('deadbeef', { sessions: [], unreachable: ['mac-mini'] });
    expect(outcome.kind).toBe('partial');
  });
});
