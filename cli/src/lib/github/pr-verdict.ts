/**
 * Non-author PR approval + CI-green checks for merge-on-green.
 *
 * Verdict rules are copied from merge-guard.sh (the PreToolUse hook in
 * phnx-labs/.agents-system `rules/subrules/gh-merge-guard/merge-guard.sh`).
 * That hook accepts EITHER a formal GitHub `APPROVED` review OR an APPROVE
 * verdict comment on THIS PR, and rejects a comment that only cites another
 * PR ("carried from #N" / "APPROVE on #N") — the #2736 laundering pattern.
 *
 * Do not invent a third rule. If the hook's regexes change, change these in
 * the same delivery.
 */

/** A GitHub pull-request review, shaped after `GET .../pulls/{n}/reviews`. */
export interface PrReview {
  state?: string;
}

/** An issue comment on a PR, shaped after `GET .../issues/{n}/comments`. */
export interface PrComment {
  body?: string;
}

/**
 * One status-check rollup item from `gh pr list --json statusCheckRollup`.
 * `gh` exposes conclusion/state/status under those names; empty fields are
 * pending/in-progress.
 */
export interface StatusCheck {
  conclusion?: string;
  state?: string;
  status?: string;
}

/** One open PR with the fields the mergeable selector reads. */
export interface MergeablePrInput {
  number: number;
  /** `owner/repo`. Required so a daemon with no git cwd can still merge. */
  repo: string;
  reviewDecision?: string | null;
  statusCheckRollup?: StatusCheck[] | null;
  reviews?: PrReview[] | null;
  comments?: PrComment[] | null;
}

/**
 * True when a non-author verdict exists ON this PR.
 *
 * Mirrors merge-guard.sh: a GitHub review with `state == "APPROVED"`, or an
 * issue comment whose body contains `\bAPPROVE\b` and is not a carried-from
 * citation (`\bcarried\s+(?:over\s+)?from\b` or `\bAPPROVE\s+(?:on|from)\s+#\d+`).
 */
export function hasApproveVerdict(
  reviews: readonly PrReview[] | null | undefined,
  comments: readonly PrComment[] | null | undefined,
): boolean {
  if (Array.isArray(reviews) && reviews.some((r) => r?.state === 'APPROVED')) {
    return true;
  }
  if (!Array.isArray(comments)) return false;
  for (const c of comments) {
    const body = c?.body ?? '';
    if (!/\bAPPROVE\b/.test(body)) continue;
    // A verdict that only points at another PR is laundering, not review.
    if (/\bcarried\s+(?:over\s+)?from\b|\bAPPROVE\s+(?:on|from)\s+#\d+/.test(body)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * True when every check is a terminal success-class conclusion.
 *
 * Matches the built-in monitor's original jq: SUCCESS / NEUTRAL / SKIPPED
 * (ascii-uppercased conclusion, else state, else status). An empty rollup
 * is green — jq `all([])` is true, and a PR with no checks is mergeable
 * from this filter's point of view.
 */
export function isCiGreen(rollup: readonly StatusCheck[] | null | undefined): boolean {
  const items = rollup ?? [];
  return items.every((c) => {
    const v = (c.conclusion || c.state || c.status || '').toUpperCase();
    return v === 'SUCCESS' || v === 'NEUTRAL' || v === 'SKIPPED';
  });
}

/**
 * Keep PRs that are CI-green AND non-author-approved.
 *
 * `reviewDecision == "APPROVED"` is sufficient (a formal review). When that
 * field is empty — the fleet convention: reviewers post an APPROVE *comment*
 * rather than a GitHub review — fall through to {@link hasApproveVerdict}.
 */
export function selectMergeablePrs(prs: readonly MergeablePrInput[]): MergeablePrInput[] {
  return prs.filter((pr) => {
    if (!isCiGreen(pr.statusCheckRollup)) return false;
    if (pr.reviewDecision === 'APPROVED') return true;
    return hasApproveVerdict(pr.reviews, pr.comments);
  });
}

/** `owner/repo#n` — the poll observation the merge action can parse without a cwd. */
export function formatMergeableRef(pr: Pick<MergeablePrInput, 'repo' | 'number'>): string {
  return `${pr.repo}#${pr.number}`;
}
