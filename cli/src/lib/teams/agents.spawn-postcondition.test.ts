/**
 * RUSH-2356 — the silent-success class: `teams add` must never print a
 * success block for a teammate that isn't actually durably on disk. spawn()
 * now asserts the postcondition (a real `loadFromDisk` read, not the exit
 * code) right after saveMeta()+cleanupOldAgents(), throwing loud if the
 * record is somehow absent.
 *
 * Uses a staged (`--after`) spawn so the happy path never launches a real
 * agent process (isStaged short-circuits to just saveMeta()) — exercises the
 * real AgentManager.spawn()/AgentProcess.loadFromDisk() path against a temp
 * meta.json dir. No mocking.
 *
 * Passes a cloudProvider so spawn()'s pre-flight checkCliAvailable() call is
 * skipped — that check runs unconditionally for any non-cloud/non-remote
 * spawn (staged or not), and CI intentionally has no coding-agent CLI
 * installed (matches scripts/sandbox.sh's own test-mode comment). What's
 * under test here is the postcondition assertion, not CLI detection, which
 * already has its own dedicated coverage in agents.cli-detection.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-spawn-post-'));
}

describe('spawn() postcondition — never reports success for a record that is not on disk (RUSH-2356)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a staged --after teammate is durably persisted before spawn() resolves', async () => {
    const base = tmpBase();
    dirs.push(base);

    // A completed sibling for the new teammate to depend on, seeded straight
    // to disk (avoids a real launch for the dependency too).
    const sibling = new AgentProcess(
      'sibling-1', 'post-team', 'claude', 'first half', null, 'plan',
      null, AgentStatus.COMPLETED, new Date(Date.now() - 60_000), new Date(), base,
      null, null, null, null, null, null, null, 'first',
    );
    await sibling.saveMeta();

    const mgr = new AgentManager(50, base);
    const agent = await mgr.spawn(
      'post-team', 'claude', 'second half', null, null, 'medium',
      null, null, null, 'second', ['first'],
      null, null, null, 'rush', // cloudProvider — skips the CLI-availability pre-flight
    );

    expect(agent.status).toBe(AgentStatus.PENDING);

    // The actual postcondition: readable from DISK, not just the return value
    // or the in-memory cache — a second CLI invocation (`teams status`) reads
    // exactly this.
    const reread = await AgentProcess.loadFromDisk(agent.agentId, base);
    expect(reread).not.toBeNull();
    expect(reread?.name).toBe('second');
    expect(reread?.after).toEqual(['first']);
    expect(reread?.status).toBe(AgentStatus.PENDING);
  });

  it('spawn() THROWS (never returns a success) when the record is not on disk afterward', async () => {
    const base = tmpBase();
    dirs.push(base);

    const sibling = new AgentProcess(
      'sibling-2', 'post-team', 'claude', 'first half', null, 'plan',
      null, AgentStatus.COMPLETED, new Date(Date.now() - 60_000), new Date(), base,
      null, null, null, null, null, null, null, 'first',
    );
    await sibling.saveMeta();

    const mgr = new AgentManager(50, base);

    // Fault injection at the REAL seam, not a mock: the only way a record
    // vanishes between saveMeta() and the postcondition read is something
    // deleting it in between, and historically that something was the
    // retention pass spawn() runs right there (the RUSH-2356 regression:
    // cleanupOldAgents treated `pending` as reapable). Reproduce that effect
    // with a real `fs.rm` of the record it just wrote. saveMeta(),
    // loadFromDisk(), the manager and the filesystem are all the real thing —
    // only the fault is injected, and it is injected exactly where the bug was.
    const realCleanup = (mgr as unknown as { cleanupOldAgents(): Promise<void> }).cleanupOldAgents;
    (mgr as unknown as { cleanupOldAgents(): Promise<void> }).cleanupOldAgents = async function reapEverything() {
      await realCleanup.call(mgr);
      for (const entry of await fs.promises.readdir(base)) {
        await fs.promises.rm(path.join(base, entry), { recursive: true, force: true });
      }
    };

    let spawned: AgentProcess | null = null;
    let thrown: Error | null = null;
    try {
      spawned = await mgr.spawn(
        'post-team', 'claude', 'second half', null, null, 'medium',
        null, null, null, 'second', ['first'],
        null, null, null, 'rush', // cloudProvider — skips the CLI-availability pre-flight
      );
    } catch (err) {
      thrown = err as Error;
    }

    // Fail loud: the add reports the failure instead of printing a success
    // block for a teammate that does not exist.
    expect(spawned).toBeNull();
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toMatch(/was not durably persisted to disk after add/);
    expect(thrown?.message).toContain('second');

    // And the half-created teammate is not left behind in the manager's
    // in-memory cache either — `teams status` must not list a record that
    // isn't on disk.
    const all = await mgr.listAll();
    expect(all.map((a) => a.name)).not.toContain('second');
  });
});
