import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db — db.ts captures DB_PATH at
// module load (same pattern as the migration tests in this directory).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-mirror-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

// Pin this box's device id so the suite is independent of the host it runs on
// (PHNX-3850). Otherwise machineId() resolves to the real hostname: on a box
// literally named `yosemite-m6` it collides with the peer this file uses as a
// remote publisher, and consumeSessionMirrorFromSharedStore skips that peer's
// digest as "self" — the fold never runs and the placeholder-label overwrite is
// never exercised. A fixed id that matches no peer keeps self and every peer
// distinct on every machine.
process.env.AGENTS_SYNC_MACHINE_ID = 'mirror-test-self';

const { getSessionsDir, getUserAgentsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('./db.js');
const mirror = await import('./mirror.js');
const { readFleetSharedDeviceStates, updateFleetSharedDeviceState } = await import('../fleet-shared-state.js');
const { machineId } = await import('./sync/config.js');
const Database = (await import('../sqlite.js')).default;

const self = machineId();

function seedLocalSession(over: Partial<Parameters<typeof db.upsertSession>[0]> & { id: string }): void {
  const meta: any = {
    id: over.id,
    shortId: over.id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-09-01T10:00:00.000Z',
    lastActivity: '2026-09-01T10:30:00.000Z',
    filePath: `/tmp/${over.id}.jsonl`,
    machine: self,
    topic: 'do the thing',
    firstUserMessage: 'Please do the thing end to end and open a PR.',
    ...over,
  };
  db.upsertSession(meta, meta.firstUserMessage ?? '');
}

function rawRow(id: string): any {
  const d = new Database(path.join(getSessionsDir(), 'sessions.db'));
  try {
    return d.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  } finally {
    d.close();
  }
}

describe('session mirror (real DB + real shared-state files)', () => {
  it('publishes this box\'s local sessions into its owned shared-state file', async () => {
    seedLocalSession({ id: 'aaaaaaaa-0000-0000-0000-000000000001' });
    const root = getUserAgentsDir();
    const res = await mirror.publishSessionMirrorToSharedStore({ userAgentsDir: root });
    expect(res.published).toBe(true);
    expect(res.count).toBeGreaterThanOrEqual(1);

    const read = readFleetSharedDeviceStates(root);
    const mine = read.states.find((s) => s.device === self);
    expect(mine?.sessions?.rows?.length).toBeGreaterThanOrEqual(1);
    const row = mine!.sessions!.rows.find((r) => r.id === 'aaaaaaaa-0000-0000-0000-000000000001')!;
    expect(row.topic).toBe('do the thing');
    expect(row.firstUser).toContain('do the thing end to end');
    expect(row.machine).toBe(self);
  });

  it('folds a PEER\'s published digests into the local index as mirror rows and previews them inline', () => {
    const root = getUserAgentsDir();
    // A peer publishes a session that never existed on this box.
    updateFleetSharedDeviceState('yosemite-m5', {
      sessions: {
        rows: [{
          id: 'bbbbbbbb-0000-0000-0000-000000000002',
          shortId: 'bbbbbbbb',
          agent: 'claude',
          machine: 'yosemite-m5',
          topic: 'refactor the exec engine',
          firstUser: 'Refactor buildExecEnv so every dispatch path shares one env builder.',
          label: 'exec refactor',
          lastActivity: '2026-09-01T12:00:00.000Z',
          timestamp: '2026-09-01T11:00:00.000Z',
          ticketId: 'PHNX-9999',
          capturedAt: Date.now(),
        }],
      },
    }, root);

    const res = mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    expect(res.merged).toBe(1);
    expect(res.sources).toContain('yosemite-m5');

    const row = rawRow('bbbbbbbb-0000-0000-0000-000000000002');
    expect(row).toBeTruthy();
    expect(row.machine).toBe('yosemite-m5');
    expect(row.file_path).toBe('');
    expect(row.topic).toBe('refactor the exec engine');
    expect(row.label).toBe('exec refactor');
    expect(row.ticket_id).toBe('PHNX-9999');
    expect(row.mirror_synced_at).toBeGreaterThan(0);
    expect(row.mirror_source).toBe('yosemite-m5');
  });

  it('OVERWRITES a host-dispatch stub\'s [host/peer] placeholder label with the synced topic', () => {
    const root = getUserAgentsDir();
    // A local host-dispatch stub: peer machine, empty file, placeholder label, no topic.
    db.upsertSession({
      id: 'cccccccc-0000-0000-0000-000000000003',
      shortId: 'cccccccc',
      agent: 'claude',
      timestamp: '2026-09-01T09:00:00.000Z',
      filePath: '',
      machine: 'yosemite-m6',
      label: '[host/yosemite-m6]',
    } as any, '');

    updateFleetSharedDeviceState('yosemite-m6', {
      sessions: {
        rows: [{
          id: 'cccccccc-0000-0000-0000-000000000003',
          shortId: 'cccccccc',
          agent: 'claude',
          machine: 'yosemite-m6',
          topic: 'land the traces insight engine',
          firstUser: 'Ship the cross-session failure clustering.',
          lastActivity: '2026-09-01T09:30:00.000Z',
          timestamp: '2026-09-01T09:00:00.000Z',
          capturedAt: Date.now(),
        }],
      },
    }, root);

    mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    const row = rawRow('cccccccc-0000-0000-0000-000000000003');
    // The bare [host/peer] placeholder is gone; the list now renders the topic.
    expect(row.label).toBeNull();
    expect(row.topic).toBe('land the traces insight engine');
  });

  it('NEVER overwrites a genuine local transcript row', () => {
    const root = getUserAgentsDir();
    seedLocalSession({ id: 'dddddddd-0000-0000-0000-000000000004', topic: 'real local work' });
    // A peer claims the same id (shouldn't happen with UUIDs, but the guard must hold).
    const wrote = db.upsertMirrorSession(
      { id: 'dddddddd-0000-0000-0000-000000000004', shortId: 'dddddddd', agent: 'claude', machine: 'evil-peer', timestamp: '2026-09-01T00:00:00.000Z', topic: 'hijacked' },
      'evil-peer',
      Date.now(),
    );
    expect(wrote).toBe(false);
    const row = rawRow('dddddddd-0000-0000-0000-000000000004');
    expect(row.machine).toBe(self);
    expect(row.topic).toBe('real local work');
    expect(row.mirror_synced_at).toBeNull();
  });

  it('a worker skips the consume (the mirror feeds an interactive picker)', () => {
    const root = getUserAgentsDir();
    updateFleetSharedDeviceState('yosemite-s1', {
      sessions: { rows: [{ id: 'eeeeeeee-0000-0000-0000-000000000005', shortId: 'eeeeeeee', agent: 'claude', machine: 'yosemite-s1', topic: 'x', timestamp: '2026-09-01T00:00:00.000Z', capturedAt: Date.now() }] },
    }, root);
    const res = mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'worker' });
    expect(res.skipped).toMatch(/worker/);
    expect(res.merged).toBe(0);
    expect(rawRow('eeeeeeee-0000-0000-0000-000000000005')).toBeFalsy();
  });

  it('carries a session\'s daemon-computed summary through publish and consume (PHNX-3939)', () => {
    const root = getUserAgentsDir();
    const id = '99999999-0000-0000-0000-0000000000aa';
    seedLocalSession({ id, topic: 'add the summarizer' });
    db.writeSessionSummary({
      id,
      fileMtimeMs: 123,
      fileSize: 456,
      summary: {
        goal: 'Ship the per-session summarizer',
        checkpoints: [{ text: 'wrote the cache', at: '2026-09-05T00:00:00.000Z' }],
        summaryChecklist: [{ text: 'add the table', done: true }],
        summaryState: 'ready',
      },
    });

    // Publish: the local source query rides the summary alongside the digest.
    const source = db.queryLocalOriginSessionsForMirror(self, 200).find((s) => s.id === id)!;
    expect(source.summary?.goal).toBe('Ship the per-session summarizer');

    // A peer publishes the same digest+summary; consuming it lands the summary in
    // this box's session_summaries so the merge surfaces it with no transcript.
    updateFleetSharedDeviceState('yosemite-m2', {
      sessions: {
        rows: [{
          id: 'aaaaaaaa-0000-0000-0000-0000000000bb',
          shortId: 'aaaaaaaa',
          agent: 'claude',
          machine: 'yosemite-m2',
          topic: 'peer summary',
          timestamp: '2026-09-01T00:00:00.000Z',
          goal: 'Peer goal',
          checkpoints: [{ text: 'peer step', at: '2026-09-01T00:00:00.000Z' }],
          summaryChecklist: [{ text: 'peer item', done: false }],
          summaryState: 'ready',
          capturedAt: Date.now(),
        }],
      },
    }, root);
    const res = mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    // Other tests in this describe leave peer rows in the shared store, so assert
    // this session merged rather than an exact fleet-wide count.
    expect(res.merged).toBeGreaterThanOrEqual(1);
    const stored = db.readSessionSummaryAny('aaaaaaaa-0000-0000-0000-0000000000bb');
    expect(stored?.goal).toBe('Peer goal');
    expect(stored?.summaryState).toBe('ready');
    expect(stored?.summaryChecklist).toEqual([{ text: 'peer item', done: false }]);
  });

  it('bounds an oversized summary on publish exactly as consume caps it (PHNX-3939)', async () => {
    const root = getUserAgentsDir();
    const id = '99999999-0000-0000-0000-0000000000cc';
    seedLocalSession({ id, topic: 'bound the mirror' });
    db.writeSessionSummary({
      id,
      fileMtimeMs: 111,
      fileSize: 222,
      summary: {
        goal: 'Bound the publish side',
        // 70 > the 50 cap; 500-char text > the 400 cap; 47-char `at` > the 40 cap.
        checkpoints: Array.from({ length: 70 }, () => ({
          text: 'c'.repeat(500),
          at: '2026-09-05T00:00:00.000Z-overlongtimestampvalue',
        })),
        // 130 > the 100 cap; 500-char text > the 400 cap.
        summaryChecklist: Array.from({ length: 130 }, (_, i) => ({ text: 'k'.repeat(500), done: i % 2 === 0 })),
        summaryState: 'ready',
      },
    });

    const res = await mirror.publishSessionMirrorToSharedStore({ userAgentsDir: root });
    expect(res.published).toBe(true);

    const read = readFleetSharedDeviceStates(root);
    const row = read.states.find((s) => s.device === self)!.sessions!.rows.find((r) => r.id === id)!;
    // Item-count caps match toMirrorSummary's consume-side bounds (50 / 100).
    expect(row.checkpoints!.length).toBe(50);
    expect(row.summaryChecklist!.length).toBe(100);
    // Per-item length caps (text 400, `at` 40) — so a value that survives publish
    // is never re-truncated differently on consume.
    expect(row.checkpoints![0].text.length).toBe(400);
    expect(row.checkpoints![0].at.length).toBe(40);
    expect(row.summaryChecklist![0].text.length).toBe(400);
    expect(row.summaryChecklist![0].done).toBe(true);
  });

  it('prunes only stale mirror rows, never a real or fresh one', () => {
    const now = Date.now();
    seedLocalSession({ id: 'ffffffff-0000-0000-0000-000000000006', topic: 'keep me local' });
    db.upsertMirrorSession({ id: '11111111-0000-0000-0000-000000000007', shortId: '11111111', agent: 'claude', machine: 'peer-a', timestamp: '2026-09-01T00:00:00.000Z', topic: 'stale' }, 'peer-a', now - mirror.SESSION_MIRROR_MAX_AGE_MS - 60_000);
    db.upsertMirrorSession({ id: '22222222-0000-0000-0000-000000000008', shortId: '22222222', agent: 'claude', machine: 'peer-a', timestamp: '2026-09-01T00:00:00.000Z', topic: 'fresh' }, 'peer-a', now);

    const pruned = db.pruneMirrorSessions(now - mirror.SESSION_MIRROR_MAX_AGE_MS);
    expect(pruned).toBe(1);
    expect(rawRow('11111111-0000-0000-0000-000000000007')).toBeFalsy();
    expect(rawRow('22222222-0000-0000-0000-000000000008')).toBeTruthy();
    expect(rawRow('ffffffff-0000-0000-0000-000000000006')).toBeTruthy();
  });
});

describe('a mirror row reclaimed by a real local transcript (PHNX-3792 blocker fix)', () => {
  const ID = '33333333-0000-0000-0000-000000000009';

  it('clears the mirror stamp on a genuine local write, so prune cannot delete it and it re-publishes', () => {
    // 1. Seed the id as a peer mirror row (empty file_path, mirror_synced_at set).
    const staleSync = Date.now() - mirror.SESSION_MIRROR_MAX_AGE_MS - 60_000;
    db.upsertMirrorSession(
      { id: ID, shortId: '33333333', agent: 'claude', machine: 'peer-b', timestamp: '2026-09-01T00:00:00.000Z', topic: 'from peer' },
      'peer-b',
      staleSync,
    );
    const asMirror = rawRow(ID);
    expect(asMirror.mirror_synced_at).toBe(staleSync);
    expect(asMirror.file_path === '' || asMirror.file_path == null).toBe(true);

    // 2. The same id then gains a genuine LOCAL transcript via the ordinary scan path.
    seedLocalSession({ id: ID, topic: 'now local', firstUserMessage: 'real transcript content' });
    const asLocal = rawRow(ID);
    expect(asLocal.mirror_synced_at).toBeNull();   // stamp cleared by the real write
    expect(asLocal.mirror_source).toBeNull();
    expect(asLocal.file_path).toBeTruthy();

    // 3. (a) Prune with a cutoff PAST the original stale stamp — the reclaimed row
    // survives because its stamp is now NULL, not because it is fresh. (The prune
    // count is not asserted: this file shares one DB, so other tests' mirror rows
    // also fall in the cutoff — what matters is that THIS real local row is spared.)
    db.pruneMirrorSessions(Date.now());
    expect(rawRow(ID)).toBeTruthy();

    // 4. (b) It is re-publishable as a genuine local-origin row again.
    const publishable = db.queryLocalOriginSessionsForMirror(self, 200).map((r) => r.id);
    expect(publishable).toContain(ID);
  });
});
