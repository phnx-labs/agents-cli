import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db — db.ts captures DB_PATH at
// module load (same pattern as the migration tests in this directory).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-mirror-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

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

  it('carries the peer\'s daemon-generated title both ways, so a remote row shows the SAME headline (PHNX-3797)', async () => {
    const root = getUserAgentsDir();
    const id = 'a1a1a1a1-0000-0000-0000-000000000011';
    seedLocalSession({ id, topic: 'wire the session titler' });
    db.setSessionGeneratedTitle(id, 'Daemon session titler', 'key-1');

    // Publish: this box's own title rides its shared-state file.
    await mirror.publishSessionMirrorToSharedStore({ userAgentsDir: root });
    const published = readFleetSharedDeviceStates(root).states
      .find((s) => s.device === self)!.sessions!.rows.find((r) => r.id === id)!;
    expect(published.title).toBe('Daemon session titler');

    // Consume: a peer's title lands on the mirror row this box renders.
    const peerId = 'b2b2b2b2-0000-0000-0000-000000000012';
    updateFleetSharedDeviceState('yosemite-m3', {
      sessions: {
        rows: [{
          id: peerId,
          shortId: 'b2b2b2b2',
          agent: 'claude',
          machine: 'yosemite-m3',
          topic: 'the fleet list headline is the agent last message',
          title: 'Session headline ladder fix',
          firstUser: 'Every row shows the agent latest message. Make it a real title.',
          lastActivity: '2026-09-01T13:00:00.000Z',
          timestamp: '2026-09-01T12:00:00.000Z',
          capturedAt: Date.now(),
        }],
      },
    }, root);
    mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    expect(rawRow(peerId).generated_title).toBe('Session headline ladder fix');
    expect(db.getSessionById(peerId)?.generatedTitle).toBe('Session headline ladder fix');
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
