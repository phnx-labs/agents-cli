// Pure parsing of `gh pr view --json` into a board row: CI + review + mergeable +
// a single readyToMerge verdict. The impure gh call + TTL cache live in the vscode
// layer (prBoard.vscode.ts); this parser is pure so it is unit-tested and reusable.

import { aggregateChecks, type CiStatus } from './prChecks';

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';

export interface PrStatus {
  url: string;
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  ci: CiStatus;
  review: ReviewDecision;
  mergeable: Mergeable;
  /** Open, not draft, approved, CI not red/running, and no merge conflict — the
   *  board's Merge button renders only when this is true. */
  readyToMerge: boolean;
}

/** gh `statusCheckRollup` rows: CheckRun {status, conclusion} or StatusContext {state}. */
interface RollupRow {
  status?: string;
  conclusion?: string;
  state?: string;
}

/** Fold a rollup row onto the shape aggregateChecks (prChecks.ts) already handles. */
function rollupToCheckRow(row: RollupRow): { state: string } {
  const status = (row.status || '').toUpperCase();
  if (status && status !== 'COMPLETED') return { state: 'PENDING' };
  const conclusion = (row.conclusion || '').toUpperCase();
  if (conclusion) return { state: conclusion };
  return { state: (row.state || '').toUpperCase() };
}

/**
 * Parse the stdout of
 * `gh pr view <url> --json number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup`.
 * Returns null on any parse failure so a bad gh result never fabricates a row.
 */
export function parsePrStatus(url: string, stdout: string): PrStatus | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const d = JSON.parse(trimmed);
    if (!d || typeof d !== 'object' || typeof d.number !== 'number') return null;
    const rawState = String(d.state || '').toUpperCase();
    const state: PrStatus['state'] = rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : 'open';
    const rawReview = String(d.reviewDecision || '').toUpperCase();
    const review: ReviewDecision =
      rawReview === 'APPROVED' ? 'approved'
      : rawReview === 'CHANGES_REQUESTED' ? 'changes_requested'
      : rawReview === 'REVIEW_REQUIRED' ? 'review_required'
      : null;
    const rawMergeable = String(d.mergeable || '').toUpperCase();
    const mergeable: Mergeable =
      rawMergeable === 'MERGEABLE' ? 'mergeable' : rawMergeable === 'CONFLICTING' ? 'conflicting' : 'unknown';
    const rollup: RollupRow[] = Array.isArray(d.statusCheckRollup) ? d.statusCheckRollup : [];
    const ci = aggregateChecks(rollup.map(rollupToCheckRow));
    const isDraft = d.isDraft === true;
    const readyToMerge =
      state === 'open' && !isDraft && review === 'approved' &&
      ci !== 'failed' && ci !== 'running' && mergeable === 'mergeable';
    return {
      url,
      number: d.number,
      title: typeof d.title === 'string' ? d.title : '',
      state,
      isDraft,
      ci,
      review,
      mergeable,
      readyToMerge,
    };
  } catch {
    return null;
  }
}
