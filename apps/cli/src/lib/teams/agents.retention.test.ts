/**
 * RUSH-2356: `cleanupOldAgents` reaped staged `--after` teammates past the
 * retention cap because `listCompleted()` classified every non-RUNNING status
 * — including `pending` — as "completed". A DAG of pending teammates that
 * outlived the 50-record cap silently lost its still-pending members: `teams
 * add --after` printed a success block for a record that then vanished from
 * disk. `--after` was only the trigger — any teammate parked non-terminal
 * (pending, or a still-running one) was equally at risk.
 *
 * Exercises the real AgentManager/AgentProcess persistence + retention path
 * against a temp meta.json dir. No mocking — cleanupOldAgents() is invoked
 * directly (it has no public wrapper), everything else is the real thing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus, captureProcessStartTime } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-retention-'));
}

/** A finished teammate, `minutesAgo` minutes in the past, saved straight to disk. */
async function makeCompleted(base: string, id: string, minutesAgo: number): Promise<void> {
  const completedAt = new Date(Date.now() - minutesAgo * 60_000);
  const agent = new AgentProcess(
    id, 'retention-team', 'claude', 'do a thing', null, 'plan',
    null, AgentStatus.COMPLETED, new Date(completedAt.getTime() - 1000), completedAt, base,
  );
  await agent.saveMeta();
}

/** A staged `--after` teammate parked PENDING, waiting on `dep` — never launched. */
async function makePending(base: string, id: string, name: string, dep: string): Promise<void> {
  const agent = new AgentProcess(
    id, 'retention-team', 'claude', 'do a thing', null, 'plan',
    null, AgentStatus.PENDING, new Date(), null, base,
    null, null, null, null, null, null, null, // parentSessionId..remoteSessionId
    name, [dep],
  );
  await agent.saveMeta();
}

describe('retention never reaps a non-terminal teammate (RUSH-2356)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('55 completed + 5 pending, cap=50: only the 5 oldest completed are reaped; every pending survives', async () => {
    const base = tmpBase();
    dirs.push(base);

    // done-0 is oldest, done-54 is newest.
    for (let i = 0; i < 55; i++) {
      await makeCompleted(base, `done-${i}`, 55 - i);
    }
    for (let i = 0; i < 5; i++) {
      await makePending(base, `pending-${i}`, `p${i}`, 'done-54');
    }

    const mgr = new AgentManager(50, base);
    await mgr.listAll(); // load everything from disk into the cache

    // The retention pass every `teams add` runs internally at the end of spawn().
    await (mgr as unknown as { cleanupOldAgents(): Promise<void> }).cleanupOldAgents();

    const all = await mgr.listAll();
    const completedIds = all.filter((a) => a.status === AgentStatus.COMPLETED).map((a) => a.agentId).sort();
    const pendingIds = all.filter((a) => a.status === AgentStatus.PENDING).map((a) => a.agentId).sort();

    expect(completedIds).toHaveLength(50);
    expect(pendingIds).toHaveLength(5);
    // The 5 OLDEST completed records are the ones reaped — never a pending one.
    for (let i = 0; i < 5; i++) expect(completedIds).not.toContain(`done-${i}`);

    // Every pending record survives on DISK, not just in the in-memory cache —
    // a subsequent `teams start` (a fresh CLI invocation, fresh AgentManager)
    // must still find and launch it.
    for (let i = 0; i < 5; i++) {
      const reread = await AgentProcess.loadFromDisk(`pending-${i}`, base);
      expect(reread?.status).toBe(AgentStatus.PENDING);
      expect(reread?.after).toEqual(['done-54']);
    }
  });

  it('a still-RUNNING teammate is never a reap candidate, however deep the completed backlog', async () => {
    const base = tmpBase();
    dirs.push(base);

    for (let i = 0; i < 60; i++) {
      await makeCompleted(base, `done-${i}`, 60 - i);
    }
    // A genuinely alive local pid (this test process's own) — a RUNNING
    // teammate with no live pid is an impossible state updateStatusFromProcess
    // fails on its own, which would mask whether retention (not liveness) is
    // what's under test here.
    const running = new AgentProcess(
      'still-running', 'retention-team', 'claude', 'do a thing', null, 'plan',
      process.pid, AgentStatus.RUNNING, new Date(), null, base,
    );
    running.startTime = captureProcessStartTime(process.pid);
    await running.saveMeta();

    const mgr = new AgentManager(50, base);
    await mgr.listAll();
    await (mgr as unknown as { cleanupOldAgents(): Promise<void> }).cleanupOldAgents();

    const reread = await AgentProcess.loadFromDisk('still-running', base);
    expect(reread?.status).toBe(AgentStatus.RUNNING);

    const all = await mgr.listAll();
    expect(all.filter((a) => a.status === AgentStatus.COMPLETED)).toHaveLength(50);
  });

  it('the age-based reap (loadExistingAgents) also never deletes a non-terminal record, even a stale one', async () => {
    const base = tmpBase();
    dirs.push(base);

    // A staged --after teammate that has sat PENDING for 30 days — well past
    // the default 7-day cleanupAgeDays window — with a completedAt that
    // should never have been set on a non-terminal record in the first place
    // (the sibling bug updateStatusFromProcess's PENDING guards fix), but
    // this reap must be independently safe even if one somehow got stamped.
    const stalePending = new AgentProcess(
      'stale-pending', 'age-team', 'claude', 'do a thing', null, 'plan',
      null, AgentStatus.PENDING, new Date(Date.now() - 30 * 86_400_000),
      new Date(Date.now() - 30 * 86_400_000), base,
      null, null, null, null, null, null, null, 'staged', ['someone'],
    );
    await stalePending.saveMeta();

    // A genuinely old COMPLETED record — this one SHOULD be reaped.
    const staleCompleted = new AgentProcess(
      'stale-completed', 'age-team', 'claude', 'do a thing', null, 'plan',
      null, AgentStatus.COMPLETED, new Date(Date.now() - 30 * 86_400_000),
      new Date(Date.now() - 30 * 86_400_000), base,
    );
    await staleCompleted.saveMeta();

    // Constructing the manager runs loadExistingAgents(), which performs the
    // age-based reap synchronously before this call resolves.
    const mgr = new AgentManager(50, base, undefined, undefined, 7);
    await mgr.listAll();

    expect(fs.existsSync(path.join(base, 'stale-pending'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'stale-completed'))).toBe(false);

    const reread = await AgentProcess.loadFromDisk('stale-pending', base);
    expect(reread?.status).toBe(AgentStatus.PENDING);
  });
});

/**
 * The failed-`teams add` teardown must remove an ORPHAN worktree and nothing
 * else. `spawn()` saves a staged teammate's record and only THEN runs the
 * retention pass, which refreshes every sibling and can throw on a distributed
 * one — so a throw out of `spawn()` does not imply "nothing was written". Were
 * teardown unconditional, that persisted, pending `--after` teammate would lose
 * its worktree and branch: real work destroyed by the cleanup meant to protect
 * the retry. `isWorktreeClaimed` is the check that tells the two apart.
 */
describe('isWorktreeClaimed distinguishes an orphan worktree from a live teammate (RUSH-2356)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A teammate owning `worktree`, saved straight to disk at `status`. */
  async function makeOwner(
    base: string, id: string, task: string, worktree: string, status: AgentStatus,
  ): Promise<void> {
    const agent = new AgentProcess(
      id, task, 'claude', 'do a thing', null, 'plan',
      null, status, new Date(), status === AgentStatus.PENDING ? null : new Date(), base,
      null, null, null, null, null, null, null, worktree, [],
      null, null, null, null, null, null, worktree,
    );
    await agent.saveMeta();
    // Guard the fixture itself: a constructor-arg slip would silently make
    // every assertion below vacuous.
    expect((await AgentProcess.loadFromDisk(id, base))?.worktreeName).toBe(worktree);
  }

  it('true for a PENDING --after teammate that persisted — its worktree is never torn down', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeOwner(base, 'staged-1', 'wt-team', 'surface', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(true);
  });

  it('true across TEAMS — worktree names are global to the repo, records are per-team', async () => {
    const base = tmpBase();
    dirs.push(base);
    // A live teammate in a DIFFERENT team owns it. Tearing it down because the
    // add's own team has no record would destroy that teammate's checkout.
    await makeOwner(base, 'other-1', 'different-team', 'surface', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(true);
  });

  it('false for a TERMINAL owner — its worktree is already gone, so the branch is a real orphan', async () => {
    const base = tmpBase();
    dirs.push(base);
    // `teams stop` removed this teammate's worktree; the record lingers until
    // retention reaps it. Counting it would strand the orphan branch forever —
    // exactly the bug the teardown exists to fix.
    await makeOwner(base, 'done-1', 'wt-team', 'surface', AgentStatus.COMPLETED);
    await makeOwner(base, 'dead-1', 'wt-team', 'surface2', AgentStatus.FAILED);

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(false);
    expect(await mgr.isWorktreeClaimed('surface2')).toBe(false);
  });

  it('false when nothing claims the name at all', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeOwner(base, 'other-2', 'wt-team', 'ui', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(false);
  });

  it('reads raw meta.json, so it still answers when a sibling would fail a status refresh', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeOwner(base, 'staged-2', 'wt-team', 'surface', AgentStatus.PENDING);

    // A directory with no meta.json at all is not a record — ENOENT proves it
    // claims nothing, so the scan skips it and still finds the real record.
    fs.mkdirSync(path.join(base, 'empty-1'), { recursive: true });

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(true);
    expect(await mgr.isWorktreeClaimed('nothing-claims-this')).toBe(false);
  });

  // The guard protects a `git worktree remove --force`, so its two errors are
  // not symmetric: a false "claimed" strands an orphan branch a human can
  // delete, a false "unclaimed" destroys a live agent's uncommitted work. An
  // unreadable record may BE the one claiming this worktree and we cannot tell,
  // so it must answer "claimed".
  it('fails CLOSED on an unreadable record rather than reporting the worktree free', async () => {
    const base = tmpBase();
    dirs.push(base);

    // Not valid JSON — the shape a partial write leaves.
    const brokenDir = path.join(base, 'broken-1');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'meta.json'), '{ "worktree_name": "surf');

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('nothing-claims-this')).toBe(true);
  });

  it('answers unclaimed when the records directory is genuinely absent (ENOENT)', async () => {
    const base = tmpBase();
    dirs.push(base);
    fs.rmSync(base, { recursive: true, force: true });

    const mgr = new AgentManager(50, base);
    expect(await mgr.isWorktreeClaimed('anything')).toBe(false);
  });
});
