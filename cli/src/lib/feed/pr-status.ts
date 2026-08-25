import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActiveSession } from '../session/active.js';
import type { PullRequestAttentionSignal } from './attention.js';

const execFileAsync = promisify(execFile);
export const PR_STATUS_TTL_MS = 45_000;
export const PR_STATUS_FIELDS = 'number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup';

export interface PullRequestStatus extends PullRequestAttentionSignal {
  statusCheckRollup?: unknown[];
}

interface CacheEntry { expiresAt: number; value?: PullRequestStatus }
const cache = new Map<string, CacheEntry>();

function needsHuman(value: Omit<PullRequestStatus, 'needsHuman'>): boolean {
  if (value.state !== 'OPEN' || value.isDraft) return false;
  const checks = value.statusCheckRollup ?? [];
  const checksSettled = checks.every((check) => {
    const row = check as { conclusion?: string; status?: string };
    return row.conclusion === 'SUCCESS' || row.conclusion === 'NEUTRAL' || row.status === 'COMPLETED';
  });
  return value.reviewDecision !== 'APPROVED' || (value.mergeable === 'MERGEABLE' && checksSettled);
}

/** CLI-owned bounded-TTL source shared by feed attention and PR-board consumers. */
export async function readPullRequestStatus(
  session: ActiveSession,
  options: { nowMs?: number; ttlMs?: number } = {},
): Promise<PullRequestStatus | undefined> {
  const ref = session.pr?.url ?? session.pr?.number;
  if (!ref || !session.cwd) return undefined;
  const key = `${session.cwd}\0${String(ref)}`;
  const now = options.nowMs ?? Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', String(ref), '--json', PR_STATUS_FIELDS], {
      cwd: session.cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const raw = JSON.parse(stdout) as Omit<PullRequestStatus, 'needsHuman'>;
    const value: PullRequestStatus = { ...raw, url: session.pr?.url, needsHuman: needsHuman(raw) };
    cache.set(key, { expiresAt: now + (options.ttlMs ?? PR_STATUS_TTL_MS), value });
    return value;
  } catch {
    cache.set(key, { expiresAt: now + (options.ttlMs ?? PR_STATUS_TTL_MS) });
    return undefined;
  }
}

export async function projectPullRequestBoard(sessions: ActiveSession[]): Promise<PullRequestStatus[]> {
  const rows = await Promise.all(sessions.map((session) => readPullRequestStatus(session)));
  return rows.filter((row): row is PullRequestStatus => row !== undefined);
}

export function resetPullRequestStatusCache(): void { cache.clear(); }
