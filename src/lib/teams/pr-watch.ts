/**
 * Autonomous PR lifecycle for teams (issue #338).
 *
 * A team's teammates open PRs. This module watches those PRs and reacts:
 *   - RED CI  -> spawn a fresh fix wave (a teammate --after the one that failed,
 *                with the CI failure logs injected) that pushes a follow-up commit.
 *   - NEW REVIEW COMMENT -> route it to a `bugfix` teammate (--after the source),
 *                with the comment body injected.
 *
 * The DECISION logic here is a pure function (`decidePrActions`) over a snapshot
 * of check results + review comments + a set of already-handled ids. It never
 * touches the network — the poll-based collector (`pollPrSnapshot`, backed by the
 * `gh` CLI) and the orchestrator (`runPrWatch`) sit on top and feed it data. That
 * split keeps the spawn-or-not-spawn logic fully unit-testable (see
 * pr-watch.test.ts) and dedupe-correct.
 *
 * Follow-up (deferred, not required here): replace the poll loop with the
 * event-driven webhook receiver from #331 — `pollPrSnapshot` is the seam where a
 * `check_run` / `pull_request_review_comment` webhook payload would plug in,
 * producing the same PrSnapshot the pure decider already consumes.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * A CI check result. Shaped after `gh pr checks <pr> --json name,state,link,workflow`,
 * where `state` is one of SUCCESS | FAILURE | PENDING | ERROR | CANCELLED | SKIPPING | ...
 */
export interface PrCheck {
  name: string;
  state: string;
  link?: string;
  workflow?: string;
  /**
   * Stable identity for dedupe. Prefer the check-run id (from the gh api call);
   * fall back to the run link, then the check name, so a check with no id still
   * dedupes deterministically across polls.
   */
  id?: string;
}

/** A PR review comment. Shaped after GitHub's `repos/{owner}/{repo}/pulls/{n}/comments`. */
export interface PrReviewComment {
  id: number;
  body: string;
  user?: string;
  path?: string;
  html_url?: string;
}

/** One PR under watch, with its current CI + comment snapshot. */
export interface PrSnapshot {
  /** The PR URL (https://github.com/{owner}/{repo}/pull/{n}). */
  prUrl: string;
  /**
   * Name of the teammate whose work opened this PR — the `--after` anchor the
   * spawned fix/bugfix teammate links to. Null when the PR can't be traced to a
   * named teammate (the reaction still fires, just without a dependency edge).
   */
  sourceTeammate: string | null;
  checks: PrCheck[];
  comments: PrReviewComment[];
}

/** A decision to spawn a follow-up teammate. Pure output of `decidePrActions`. */
export type PrWatchAction =
  | {
      kind: 'ci-fix';
      prUrl: string;
      sourceTeammate: string | null;
      check: PrCheck;
      /** Idempotency key — record it in `handled` once acted on so it never re-fires. */
      dedupeKey: string;
    }
  | {
      kind: 'review-fix';
      prUrl: string;
      sourceTeammate: string | null;
      comment: PrReviewComment;
      dedupeKey: string;
    };

/**
 * Check states that count as a RED CI failure worth spawning a fix wave for.
 * PENDING / SUCCESS / SKIPPING / NEUTRAL are deliberately excluded — a fix wave
 * only fires on a genuine, terminal failure.
 */
const FAILED_STATES = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

/** True when a check is in a terminal failing state. */
export function isFailedCheck(check: PrCheck): boolean {
  return FAILED_STATES.has((check.state || '').trim().toUpperCase());
}

/** Idempotency key for a failed check on a PR — dedupe by check-run id. */
export function checkDedupeKey(prUrl: string, check: PrCheck): string {
  return `ci:${prUrl}:${check.id ?? check.link ?? check.name}`;
}

/** Idempotency key for a review comment on a PR — dedupe by comment id. */
export function commentDedupeKey(prUrl: string, comment: PrReviewComment): string {
  return `review:${prUrl}:${comment.id}`;
}

/**
 * The pure heart of pr-watch: given a PR snapshot and the set of ids already
 * acted on, decide which follow-up teammates to spawn. Emits:
 *   - one `ci-fix` action per NEW failed check (dedup by check-run id)
 *   - one `review-fix` action per NEW review comment (dedup by comment id)
 *
 * No network, no side effects, no reference to already-handled ids beyond the
 * passed set — so the same failure never spawns twice.
 */
export function decidePrActions(
  snapshot: PrSnapshot,
  handled: ReadonlySet<string>
): PrWatchAction[] {
  const actions: PrWatchAction[] = [];

  for (const check of snapshot.checks) {
    if (!isFailedCheck(check)) continue;
    const dedupeKey = checkDedupeKey(snapshot.prUrl, check);
    if (handled.has(dedupeKey)) continue;
    actions.push({
      kind: 'ci-fix',
      prUrl: snapshot.prUrl,
      sourceTeammate: snapshot.sourceTeammate,
      check,
      dedupeKey,
    });
  }

  for (const comment of snapshot.comments) {
    const dedupeKey = commentDedupeKey(snapshot.prUrl, comment);
    if (handled.has(dedupeKey)) continue;
    actions.push({
      kind: 'review-fix',
      prUrl: snapshot.prUrl,
      sourceTeammate: snapshot.sourceTeammate,
      comment,
      dedupeKey,
    });
  }

  return actions;
}

/**
 * Build the task prompt for a CI-fix teammate. Pure so it's unit-testable: the
 * failing check + the fetched logs are injected as data.
 */
export function buildCiFixPrompt(action: Extract<PrWatchAction, { kind: 'ci-fix' }>, logs: string): string {
  const logsBlock = logs.trim()
    ? `\n\nCI failure logs:\n\`\`\`\n${logs.trim()}\n\`\`\``
    : `\n\n(No CI logs could be fetched — inspect the run at ${action.check.link ?? action.prUrl}.)`;
  return (
    `CI is RED on PR ${action.prUrl}. The check "${action.check.name}"` +
    (action.check.workflow ? ` (workflow: ${action.check.workflow})` : '') +
    ` failed with state ${action.check.state}. ` +
    `Diagnose the failure from the logs below, fix it, and push a follow-up commit to the SAME PR branch ` +
    `(check out the PR branch with \`gh pr checkout ${action.prUrl}\`, make the fix, commit, and push). ` +
    `Do not open a new PR — push to the existing branch so this PR goes green.` +
    logsBlock
  );
}

/**
 * Build the task prompt for a review-comment bugfix teammate. Pure so it's
 * unit-testable: the review comment is injected as data.
 */
export function buildReviewFixPrompt(action: Extract<PrWatchAction, { kind: 'review-fix' }>): string {
  const c = action.comment;
  const where = c.path ? ` on \`${c.path}\`` : '';
  const who = c.user ? `@${c.user}` : 'A reviewer';
  return (
    `${who} left a review comment${where} on PR ${action.prUrl}. ` +
    `Address it and push a follow-up commit to the SAME PR branch ` +
    `(check out the PR branch with \`gh pr checkout ${action.prUrl}\`, make the change, commit, and push). ` +
    `Do not open a new PR.\n\n` +
    `Review comment:\n${c.body}` +
    (c.html_url ? `\n\n(thread: ${c.html_url})` : '')
  );
}

/** Parse an owner/repo/number triple out of a GitHub PR URL. Returns null when it doesn't match. */
export function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// Impure collectors — thin `gh` CLI wrappers. Kept out of the pure decider so
// tests never hit the network. These are the seam the #331 webhook receiver
// would replace: a webhook payload can synthesize the same PrCheck /
// PrReviewComment shapes and hand them straight to decidePrActions.
// ---------------------------------------------------------------------------

/** Fetch the current CI checks for a PR via `gh pr checks`. Returns [] on any gh error. */
export async function fetchPrChecks(prUrl: string): Promise<PrCheck[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'checks', prUrl, '--json', 'name,state,link,workflow'],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return raw.map((r) => ({
      name: String(r.name ?? ''),
      state: String(r.state ?? ''),
      link: r.link ? String(r.link) : undefined,
      workflow: r.workflow ? String(r.workflow) : undefined,
      // gh pr checks has no stable check-run id; the run link is the stablest
      // per-check identity it exposes, so dedupe keys off it.
      id: r.link ? String(r.link) : undefined,
    }));
  } catch {
    // `gh pr checks` exits non-zero when checks are failing OR when none are
    // configured. Both surface as a throw here; treat "can't read" as "nothing
    // to act on" rather than crashing the watch loop.
    return [];
  }
}

/** Fetch review comments for a PR via `gh api`. Returns [] on any gh error. */
export async function fetchPrReviewComments(prUrl: string): Promise<PrReviewComment[]> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return [];
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`,
        '--paginate',
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return raw.map((r) => ({
      id: Number(r.id),
      body: String(r.body ?? ''),
      user:
        r.user && typeof r.user === 'object'
          ? String((r.user as Record<string, unknown>).login ?? '')
          : undefined,
      path: r.path ? String(r.path) : undefined,
      html_url: r.html_url ? String(r.html_url) : undefined,
    }));
  } catch {
    return [];
  }
}

/** Fetch the failing-run logs for a check via `gh run view --log-failed`. Best-effort, truncated. */
export async function fetchCiFailureLogs(check: PrCheck, maxChars = 8000): Promise<string> {
  const runId = check.link?.match(/\/runs\/(\d+)/)?.[1] ?? check.link?.match(/\/actions\/runs\/(\d+)/)?.[1];
  if (!runId) return '';
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['run', 'view', runId, '--log-failed'],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    if (stdout.length <= maxChars) return stdout;
    // Keep the tail — the actual error is almost always at the end of the log.
    return `... (truncated ${stdout.length - maxChars} chars) ...\n` + stdout.slice(-maxChars);
  } catch {
    return '';
  }
}

/** Collect a live PR snapshot from `gh`. The poll-mode seam for `runPrWatch`. */
export async function pollPrSnapshot(
  prUrl: string,
  sourceTeammate: string | null
): Promise<PrSnapshot> {
  const [checks, comments] = await Promise.all([
    fetchPrChecks(prUrl),
    fetchPrReviewComments(prUrl),
  ]);
  return { prUrl, sourceTeammate, checks, comments };
}

// ---------------------------------------------------------------------------
// Orchestrator — the poll loop. Deps are injected so the loop is exercisable
// without gh or a real AgentManager; the command wires the real collectors +
// the handleSpawn-backed reactor.
// ---------------------------------------------------------------------------

/** A PR to watch, paired with the teammate that opened it. */
export interface WatchTarget {
  prUrl: string;
  sourceTeammate: string | null;
}

export interface PrWatchDeps {
  /** Discover which PRs to watch this pass (teammates may open PRs mid-run). */
  resolveTargets: () => Promise<WatchTarget[]>;
  /** Snapshot one PR's CI + review comments. Defaults to `pollPrSnapshot`. */
  pollSnapshot?: (prUrl: string, sourceTeammate: string | null) => Promise<PrSnapshot>;
  /** Fetch CI failure logs for a ci-fix action. Defaults to `fetchCiFailureLogs`. */
  fetchLogs?: (check: PrCheck) => Promise<string>;
  /**
   * React to one decided action: spawn the fix/bugfix teammate. The prompt is
   * pre-built with logs/comment injected. Return the spawned teammate label for
   * logging, or null if the spawn was skipped.
   */
  react: (action: PrWatchAction, prompt: string) => Promise<string | null>;
  /** Progress sink — one call per notable event (poll, spawn, drain). */
  onEvent?: (event: PrWatchEvent) => void;
}

export type PrWatchEvent =
  | { type: 'poll'; targets: number; timestamp: string }
  | { type: 'spawned'; action: PrWatchAction; label: string | null; timestamp: string }
  | { type: 'error'; prUrl: string; message: string; timestamp: string };

export interface PrWatchOptions {
  intervalMs?: number;
  /** Stop after this many polls (0 / undefined = run until signalled). */
  maxPolls?: number;
  /** Seed of already-handled dedupe keys (e.g. restored from disk). */
  handled?: Set<string>;
  /** Abort signal — resolves the loop at the next interval boundary. */
  shouldStop?: () => boolean;
}

export interface PrWatchResult {
  polls: number;
  spawned: number;
  handled: Set<string>;
  stoppedBy: 'max-polls' | 'signal';
}

/**
 * Run the pr-watch poll loop. Each pass: resolve watch targets, snapshot each
 * PR, decide actions against the running `handled` set, and react (spawn) to the
 * fresh ones — recording every acted-on dedupe key so a failure/comment never
 * spawns twice across passes.
 */
export async function runPrWatch(
  deps: PrWatchDeps,
  opts: PrWatchOptions = {}
): Promise<PrWatchResult> {
  const intervalMs = opts.intervalMs ?? 15000;
  const maxPolls = opts.maxPolls ?? 0;
  const handled = opts.handled ?? new Set<string>();
  const pollSnapshot = deps.pollSnapshot ?? pollPrSnapshot;
  const fetchLogs = deps.fetchLogs ?? fetchCiFailureLogs;
  const emit = deps.onEvent ?? (() => {});

  let polls = 0;
  let spawned = 0;

  for (;;) {
    if (opts.shouldStop?.()) {
      return { polls, spawned, handled, stoppedBy: 'signal' };
    }

    const targets = await deps.resolveTargets();
    polls++;
    emit({ type: 'poll', targets: targets.length, timestamp: new Date().toISOString() });

    for (const target of targets) {
      let snap: PrSnapshot;
      try {
        snap = await pollSnapshot(target.prUrl, target.sourceTeammate);
      } catch (err) {
        emit({
          type: 'error',
          prUrl: target.prUrl,
          message: (err as Error).message,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const actions = decidePrActions(snap, handled);
      for (const action of actions) {
        // Record the key BEFORE reacting so a spawn failure can't loop-spam the
        // same failure — a bad action is dropped, not retried forever.
        handled.add(action.dedupeKey);
        const prompt =
          action.kind === 'ci-fix'
            ? buildCiFixPrompt(action, await fetchLogs(action.check))
            : buildReviewFixPrompt(action);
        try {
          const label = await deps.react(action, prompt);
          spawned++;
          emit({ type: 'spawned', action, label, timestamp: new Date().toISOString() });
        } catch (err) {
          emit({
            type: 'error',
            prUrl: action.prUrl,
            message: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    if (maxPolls > 0 && polls >= maxPolls) {
      return { polls, spawned, handled, stoppedBy: 'max-polls' };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
