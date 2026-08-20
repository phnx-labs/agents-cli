/**
 * RUSH-2429: a torn meta.json write permanently disabled orphan-worktree
 * cleanup for EVERY worktree name in EVERY team.
 *
 * The chain: saveMeta() wrote with a bare `fs.writeFile` (no tmp file, no
 * rename), so a process killed mid-write left a truncated, unparseable
 * meta.json. loadFromDisk() returned null for that file from a bare catch,
 * indistinguishable from ENOENT (genuinely absent) — so loadExistingAgents()
 * and rescanFromDisk() silently skipped it forever (`if (!agent) continue`),
 * and isWorktreeClaimed() (which reads meta.json directly, not through the
 * cache) then failed CLOSED on it globally: it scans every record and returns
 * true the first time it cannot read one, so one corrupt record answered
 * "claimed" for every worktree name in every team.
 *
 * Two independent fixes, verified here against the real filesystem (no
 * mocking):
 *  1. saveMeta() writes via a sibling tmp file + rename, so a write that dies
 *     partway through can never leave a torn meta.json — the target is either
 *     the previous valid record or the new one.
 *  2. loadFromDisk() quarantines a record whose CONTENT is corrupt (a torn or
 *     unparseable meta.json — the JSON.parse failure) by renaming it to
 *     meta.json.corrupt, so it stops masquerading as "no record" and a
 *     subsequent isWorktreeClaimed() scan sees genuine absence (ENOENT) for
 *     that entry instead of failing closed on it forever. A plain READ error
 *     (EACCES/EIO/EMFILE) is NOT corruption — the file is intact and simply
 *     could not be read this time — so loadFromDisk() returns null WITHOUT
 *     renaming it, preserving the valid record for the next read.
 *
 * isWorktreeClaimed()'s fail-closed behavior for a record that is genuinely
 * present-but-unreadable AT DECISION TIME is a deliberate, separately-tested
 * invariant (agents.retention.test.ts, "fails CLOSED on an unreadable
 * record") and is untouched here — these tests only prove that a corrupt
 * record stops being PERMANENT. Quarantining only on a parse failure (never on
 * a transient read error) is what keeps that guard's protection intact: a valid
 * record is never renamed away, so a live teammate's worktree can never be
 * misread as unclaimed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-meta-corruption-'));
}

/** Write garbage bytes directly to <base>/<id>/meta.json, bypassing saveMeta(). */
function writeCorruptMeta(base: string, id: string, content = '{ "worktree_name": "surf'): string {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, 'meta.json');
  fs.writeFileSync(metaPath, content);
  return metaPath;
}

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
}

describe('saveMeta() writes atomically, via tmp + rename (RUSH-2429)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  // Only a NEW-file create can be blocked by directory permissions; writing to
  // an already-existing file is not. That asymmetry is what makes the test
  // below discriminating — see its body. Skipped where it cannot hold: chmod is
  // a no-op on Windows, and root bypasses the permission check entirely.
  const canBlockFileCreate =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  const itBlocksCreate = canBlockFileCreate ? it : it.skip;

  itBlocksCreate('a save that cannot complete leaves the previous valid record untouched, never torn', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'atomic-1';

    const agent = new AgentProcess(
      id, 'atomic-team', 'claude', 'v1', null, 'plan', null, AgentStatus.RUNNING, new Date(), null, base,
    );
    await agent.saveMeta();
    const agentDir = path.join(base, id);
    const metaPath = path.join(agentDir, 'meta.json');
    const before = fs.readFileSync(metaPath, 'utf-8');
    expect(JSON.parse(before).prompt).toBe('v1');

    // Drive the REAL writer into a failure instead of planting a decoy file it
    // never touches. A read-only directory blocks creating the sibling tmp
    // file, so atomicWriteJson's very first step fails and the rename never
    // happens. This is what makes the test discriminating: a bare
    // `writeFile(metaPath, ...)` would still SUCCEED here, because meta.json
    // already exists and the file itself stays writable — so a non-atomic
    // saveMeta() overwrites it with 'v2' and fails these assertions, which is
    // precisely the regression RUSH-2429 closed.
    agent.prompt = 'v2';
    fs.chmodSync(agentDir, 0o555);
    try {
      await expect(agent.saveMeta()).rejects.toThrow();

      const after = fs.readFileSync(metaPath, 'utf-8');
      expect(after).toBe(before);
      expect(() => JSON.parse(after)).not.toThrow();
      expect(JSON.parse(after).prompt).toBe('v1');
    } finally {
      fs.chmodSync(agentDir, 0o755);
    }

    // And the failed attempt left no tmp file to be mistaken for a record.
    expect(fs.readdirSync(agentDir)).toEqual(['meta.json']);
  });

  it('leaves no stray tmp file behind on a normal, uninterrupted save', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'atomic-2';

    const agent = new AgentProcess(
      id, 'atomic-team', 'claude', 'v1', null, 'plan', null, AgentStatus.RUNNING, new Date(), null, base,
    );
    await agent.saveMeta();

    const entries = fs.readdirSync(path.join(base, id));
    expect(entries).toEqual(['meta.json']);
  });

  it('every repeated save round-trips through loadFromDisk as fully valid JSON', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'atomic-3';

    const agent = new AgentProcess(
      id, 'atomic-team', 'claude', 'v1', null, 'plan', null, AgentStatus.PENDING, new Date(), null, base,
    );
    for (const status of [AgentStatus.PENDING, AgentStatus.RUNNING, AgentStatus.COMPLETED]) {
      agent.status = status;
      if (status === AgentStatus.COMPLETED) agent.completedAt = new Date();
      await agent.saveMeta();
      const reread = await AgentProcess.loadFromDisk(id, base);
      expect(reread?.status).toBe(status);
    }
  });
});

describe('loadFromDisk() quarantines an unreadable meta.json instead of treating it as absent (RUSH-2429)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a directory with no meta.json at all is genuinely absent — returns null, nothing to quarantine', async () => {
    const base = tmpBase();
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'empty-1'), { recursive: true });

    const result = await AgentProcess.loadFromDisk('empty-1', base);
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(base, 'empty-1', 'meta.json.corrupt'))).toBe(false);
  });

  it('a READ error (not corruption) returns null WITHOUT quarantining — the intact record is preserved for the guard', async () => {
    // A read failure that is not ENOENT (here EISDIR: meta.json exists but is a
    // directory, so fs.readFile throws) must NOT be treated as corrupt content.
    // Renaming it away would be the fail-open RUSH-2429 forbids: it would strip
    // the record isWorktreeClaimed() relies on and let a live worktree read as
    // unclaimed. loadFromDisk() must return null and leave the entry untouched.
    const base = tmpBase();
    dirs.push(base);
    const agentDir = path.join(base, 'readerr-1');
    const metaPath = path.join(agentDir, 'meta.json');
    fs.mkdirSync(metaPath, { recursive: true }); // meta.json is a directory -> EISDIR on read

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await AgentProcess.loadFromDisk('readerr-1', base);
      expect(result).toBeNull();
      // The record was NOT quarantined: no .corrupt sibling, meta.json still there.
      expect(fs.existsSync(`${metaPath}.corrupt`)).toBe(false);
      expect(fs.existsSync(metaPath)).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('an unparseable meta.json is renamed to meta.json.corrupt, warns, and loadFromDisk returns null', async () => {
    const base = tmpBase();
    dirs.push(base);
    const metaPath = writeCorruptMeta(base, 'corrupt-1');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await AgentProcess.loadFromDisk('corrupt-1', base);
      expect(result).toBeNull();
      expect(fs.existsSync(metaPath)).toBe(false);
      expect(fs.existsSync(`${metaPath}.corrupt`)).toBe(true);
      expect(fs.readFileSync(`${metaPath}.corrupt`, 'utf-8')).toBe('{ "worktree_name": "surf');
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('quarantined');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a re-read after quarantine sees genuine absence (ENOENT), not "unreadable", so it never re-quarantines', async () => {
    const base = tmpBase();
    dirs.push(base);
    const metaPath = writeCorruptMeta(base, 'corrupt-2');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await AgentProcess.loadFromDisk('corrupt-2', base)).toBeNull();
      warnSpy.mockClear();
      expect(await AgentProcess.loadFromDisk('corrupt-2', base)).toBeNull();
      // The second read hits the ENOENT branch, not the quarantine branch —
      // no second warning, and the .corrupt file is left exactly as it was.
      expect(warnSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(`${metaPath}.corrupt`)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('loadExistingAgents (AgentManager construction) quarantines a corrupt sibling while still loading a healthy record', async () => {
    const base = tmpBase();
    dirs.push(base);
    writeCorruptMeta(base, 'corrupt-3');
    await makeOwner(base, 'healthy-1', 'meta-team', 'some-surface', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll(); // awaits initialize(), which runs loadExistingAgents()

    expect(all.map((a) => a.agentId)).toEqual(['healthy-1']);
    expect(fs.existsSync(path.join(base, 'corrupt-3', 'meta.json'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'corrupt-3', 'meta.json.corrupt'))).toBe(true);
  });
});

describe('isWorktreeClaimed() recovers once a corrupt record is quarantined (RUSH-2429)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a genuine orphan is unclaimed again after the one corrupt record blocking it is quarantined', async () => {
    const base = tmpBase();
    dirs.push(base);
    // The only record in this team dir is corrupt — before RUSH-2429, this
    // alone made isWorktreeClaimed() answer "claimed" for every name, forever,
    // since it could never tell whether this unreadable record was the
    // claimant of 'surface'.
    writeCorruptMeta(base, 'corrupt-4');

    const mgr = new AgentManager(50, base);
    // Force the scan (and therefore the quarantine) to complete before we ask
    // isWorktreeClaimed anything, rather than relying on incidental timing.
    await mgr.rescanFromDisk();

    expect(fs.existsSync(path.join(base, 'corrupt-4', 'meta.json'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'corrupt-4', 'meta.json.corrupt'))).toBe(true);

    // 'surface' has no genuine claimant left — it is a real orphan, and
    // tearDownOrphanWorktree's `if (await mgr.isWorktreeClaimed(name)) return;`
    // guard now lets cleanup proceed instead of stopping forever.
    expect(await mgr.isWorktreeClaimed('surface')).toBe(false);
  });

  it('quarantining the corrupt record does not un-claim a name a healthy sibling genuinely still owns', async () => {
    const base = tmpBase();
    dirs.push(base);
    writeCorruptMeta(base, 'corrupt-5');
    await makeOwner(base, 'live-1', 'meta-team', 'still-claimed', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    await mgr.rescanFromDisk();

    expect(fs.existsSync(path.join(base, 'corrupt-5', 'meta.json.corrupt'))).toBe(true);
    // The genuinely orphaned name recovers...
    expect(await mgr.isWorktreeClaimed('surface')).toBe(false);
    // ...while the name a live, non-terminal record actually owns is still
    // reported claimed — quarantine only removes the corrupt record's own
    // (unknowable) claim, it never touches anyone else's.
    expect(await mgr.isWorktreeClaimed('still-claimed')).toBe(true);
  });
});
