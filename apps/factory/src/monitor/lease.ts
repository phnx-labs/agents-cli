// Lease file mechanics for monitor leader election.
//
// One shared file at `~/.agents/.tmp/monitor-lease.json` records who currently
// owns the "monitor" role across every IDE window:
//
//   { leaderId, pid, expiresAt }
//
// The holder renews `expiresAt` on a heartbeat while it lives. Any window may
// CLAIM the lease once it has expired AND the holder's pid is dead — this is
// what gives automatic takeover when the leader window crashes. Writes are
// atomic (temp file + rename) so a reader never sees a half-written JSON.
//
// This module is intentionally free of any vscode dependency so the election
// logic can run — and be tested — in plain subprocesses (see leader.test.ts).

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isPidAlive } from '../core/liveness';

export const LEASE_DIR = path.join(os.homedir(), '.agents', '.tmp');
export const LEASE_FILE = path.join(LEASE_DIR, 'monitor-lease.json');

export interface MonitorLease {
  /** computeWindowId(sessionId, pid) of the current holder. */
  leaderId: string;
  /** OS pid of the holder's extension host — used for liveness on takeover. */
  pid: number;
  /** Epoch ms after which the lease is stale and may be claimed. */
  expiresAt: number;
}

function isLease(v: any): v is MonitorLease {
  return (
    v &&
    typeof v === 'object' &&
    typeof v.leaderId === 'string' &&
    typeof v.pid === 'number' &&
    typeof v.expiresAt === 'number'
  );
}

/** Read the current lease, or undefined if absent / unreadable / malformed. */
export function readLease(file: string = LEASE_FILE): MonitorLease | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isLease(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Atomically write the lease (temp file + rename), creating the dir if needed. */
export function writeLease(lease: MonitorLease, file: string = LEASE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(lease, null, 2));
  fs.renameSync(tmp, file);
}

/** Remove the lease iff we still hold it — graceful handoff on shutdown. */
export function releaseLease(selfId: string, file: string = LEASE_FILE): void {
  const lease = readLease(file);
  if (lease && lease.leaderId !== selfId) return; // someone else owns it now
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Pure decision: may `selfId` write itself as leader right now?
 *
 *   - no lease yet                 -> claim (bootstrap)
 *   - lease is already ours        -> renew
 *   - lease still valid (not past) -> no
 *   - expired but holder pid alive -> no (holder is just slow, not dead)
 *   - expired and holder pid dead  -> claim (takeover)
 *
 * Caller performs the IO; this stays side-effect free for testability.
 */
export function canClaim(
  lease: MonitorLease | undefined,
  selfId: string,
  now: number,
): boolean {
  if (!lease) return true;
  if (lease.leaderId === selfId) return true;
  if (now < lease.expiresAt) return false;
  return !isPidAlive(lease.pid);
}
