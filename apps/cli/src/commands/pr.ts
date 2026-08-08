/**
 * `agents pr` command group — standalone PR lifecycle commands.
 *
 * `agents pr land <number>` watches a single PR through CI and a non-author
 * review, then rebase-merges on green. Built on top of the pr-watch primitives
 * (`pollPrSnapshot`, `isFailedCheck`) to reuse check-state logic without
 * duplicating the polling, review parsing, or merge policy.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { die } from '../lib/format.js';
import { setHelpSections } from '../lib/help.js';
import {
  pollPrSnapshot,
  parsePrUrl,
  isFailedCheck,
  type PrCheck,
} from '../lib/teams/pr-watch.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers — all REST-based, no GraphQL
// ---------------------------------------------------------------------------

/** Resolve a PR number to its full GitHub URL via `gh pr view`. */
export async function resolvePrUrl(prNumberOrUrl: string): Promise<string> {
  if (prNumberOrUrl.startsWith('https://')) return prNumberOrUrl;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', prNumberOrUrl, '--json', 'url', '--jq', '.url'],
      { maxBuffer: 1024 * 1024 }
    );
    const url = stdout.trim();
    if (!url) throw new Error('empty url from gh pr view');
    return url;
  } catch (err) {
    throw new Error(`Cannot resolve PR ${prNumberOrUrl}: ${(err as Error).message}`);
  }
}

/** Fetch the author login for a PR via REST. */
export async function fetchPrAuthor(prUrl: string): Promise<string | null> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return null;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`, '--jq', '.user.login'],
      { maxBuffer: 512 * 1024 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface PrReview {
  state: string;
  user: string;
}

/** Evaluate already-fetched reviews against the PR author. */
export function isNonAuthorApproved(reviews: PrReview[], author: string | null): boolean {
  return reviews.some((review) => review.state === 'APPROVED' && review.user !== (author ?? ''));
}

/** Fetch submitted reviews for a PR via REST. Returns [] on error. */
export async function fetchPrReviews(prUrl: string): Promise<PrReview[]> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return [];
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/reviews`, '--paginate'],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return raw.map((r) => ({
      state: String(r.state ?? ''),
      user:
        r.user && typeof r.user === 'object'
          ? String((r.user as Record<string, unknown>).login ?? '')
          : '',
    }));
  } catch {
    return [];
  }
}

/**
 * True when at least one non-author has submitted an APPROVED review.
 * Uses the REST reviews endpoint (not GraphQL reviewDecision).
 */
export async function hasNonAuthorApproval(prUrl: string): Promise<boolean> {
  const [author, reviews] = await Promise.all([fetchPrAuthor(prUrl), fetchPrReviews(prUrl)]);
  return isNonAuthorApproved(reviews, author);
}

/** The CI state of a PR: green (all done and passing), pending (still running), or the first failed check. */
export type CiState =
  | { kind: 'green' }
  | { kind: 'pending' }
  | { kind: 'failed'; check: PrCheck };

/** Terminal non-pending states that count as "done" (passed or intentionally skipped). */
const PASSED_STATES = new Set(['SUCCESS', 'SKIPPING', 'NEUTRAL', 'COMPLETED']);

/**
 * Determine the CI state of a PR from its check list.
 * A PR with no checks is considered green (no CI configured).
 * Uses `isFailedCheck` from pr-watch for consistent failure detection.
 */
export function classifyCiState(checks: PrCheck[]): CiState {
  if (checks.length === 0) return { kind: 'green' };
  for (const check of checks) {
    if (isFailedCheck(check)) return { kind: 'failed', check };
  }
  for (const check of checks) {
    if (!PASSED_STATES.has((check.state ?? '').trim().toUpperCase())) {
      return { kind: 'pending' };
    }
  }
  return { kind: 'green' };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPrCommands(program: Command): void {
  const pr = program
    .command('pr')
    .description('Standalone PR lifecycle commands (land, …).');

  setHelpSections(pr, {
    examples: `
      # Watch PR #1234 and merge when CI is green + review approved
      agents pr land 1234

      # Poll every 60 s instead of the default 30 s
      agents pr land 1234 --interval 60

      # Merge as soon as CI is green (skip review check)
      agents pr land 1234 --skip-review

      # Keep the branch after merge
      agents pr land 1234 --no-delete-branch
    `,
    notes: `
      • Requires \`gh\` (GitHub CLI) authenticated for the target repo.
      • Merges with --rebase only — no squash, no merge commit.
      • Non-author approval check uses the GitHub Reviews REST endpoint (REST, not GraphQL).
      • Fails loud on red CI or any merge conflict; never uses --admin or bypasses branch protection.
      • One waiter per PR: do not run two \`pr land\` calls against the same PR concurrently.
    `,
  });

  // --------------------------------------------------------------------------
  // agents pr land <pr>
  // --------------------------------------------------------------------------
  pr.command('land <pr>')
    .description(
      'Watch a PR through CI and a non-author review, then rebase-merge on green. ' +
      'Fails loud on red CI or conflict; never uses --admin.'
    )
    .option('--interval <seconds>', 'Seconds between polls (default 30)', '30')
    .option('--max-polls <n>', 'Stop after this many polls without merging (0 = unlimited)', '0')
    .option('--no-delete-branch', 'Keep the PR branch after merge (default: delete)')
    .option('--skip-review', 'Merge as soon as CI is green, skipping the non-author review check')
    .option('--json', 'Emit one JSON line per status event')
    .action(async (
      prArg: string,
      opts: {
        interval: string;
        maxPolls: string;
        deleteBranch: boolean;
        skipReview?: boolean;
        json?: boolean;
      }
    ) => {
      const intervalMs = Math.max(5000, (Number.parseInt(opts.interval, 10) || 30) * 1000);
      const maxPolls = Math.max(0, Number.parseInt(opts.maxPolls, 10) || 0);
      const deleteBranch = opts.deleteBranch !== false;
      const skipReview = !!opts.skipReview;
      const json = !!opts.json;

      const ts = () => new Date().toISOString().slice(11, 19);

      const emit = (event: Record<string, unknown>) => {
        if (json) {
          console.log(JSON.stringify({ ...event, timestamp: new Date().toISOString() }));
        }
      };

      const log = (msg: string) => {
        if (!json) console.log(msg);
      };

      // 1. Resolve PR URL
      let prUrl: string;
      try {
        prUrl = await resolvePrUrl(prArg);
      } catch (err) {
        die((err as Error).message);
      }

      const parsed = parsePrUrl(prUrl);
      if (!parsed) die(`Cannot parse PR URL: ${prUrl}`);
      const { owner, repo, number } = parsed;

      log(`${chalk.bold('agents pr land')} watching ${chalk.cyan(prUrl)}`);
      if (skipReview) log(chalk.yellow('  --skip-review: will merge as soon as CI is green'));
      log('');

      let polls = 0;
      let stopSignal = false;
      const onSig = () => { stopSignal = true; };
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);

      try {
        for (;;) {
          if (stopSignal) {
            log(chalk.gray('\nInterrupted — PR not merged.'));
            process.exit(0);
          }

          // 2. Snapshot the PR
          const snapshot = await pollPrSnapshot(prUrl, null);
          polls++;

          // 3. Classify CI
          const ci = classifyCiState(snapshot.checks);
          emit({ type: 'poll', polls, ciKind: ci.kind, checks: snapshot.checks.length });

          if (ci.kind === 'failed') {
            log(
              `[${ts()}] ${chalk.red('CI RED')} — check "${ci.check.name}" is ${ci.check.state}` +
              (ci.check.link ? ` (${ci.check.link})` : '')
            );
            emit({ type: 'failed', check: ci.check });
            die(
              `CI is red on ${prUrl}.\n` +
              `  Check "${ci.check.name}" failed with state ${ci.check.state}.\n` +
              `  Fix the failure and re-run \`agents pr land ${prArg}\`.`,
              1
            );
          }

          if (ci.kind === 'pending') {
            const pending = snapshot.checks.filter((c) => !PASSED_STATES.has((c.state ?? '').toUpperCase()));
            const names = pending.map((c) => c.name).join(', ');
            log(`[${ts()}] ${chalk.blue('CI pending')} — waiting on: ${names}`);
            emit({ type: 'pending', pending: pending.map((c) => c.name) });
          } else {
            // ci.kind === 'green'
            const checkCount = snapshot.checks.length;
            log(
              `[${ts()}] ${chalk.green('CI green')}` +
              (checkCount > 0 ? ` (${checkCount} check${checkCount === 1 ? '' : 's'} passed)` : ' (no checks configured)')
            );
            emit({ type: 'ci-green', checks: checkCount });

            // 4. Check for non-author review (unless --skip-review)
            if (!skipReview) {
              const approved = await hasNonAuthorApproval(prUrl);
              if (!approved) {
                log(`[${ts()}] ${chalk.yellow('awaiting review')} — no non-author approval yet`);
                emit({ type: 'awaiting-review' });
              } else {
                log(`[${ts()}] ${chalk.green('review approved')} — non-author APPROVED`);
                emit({ type: 'review-approved' });

                // 5. Merge
                await mergePr(owner, repo, number, deleteBranch, prUrl, json, ts);
                process.off('SIGINT', onSig);
                process.off('SIGTERM', onSig);
                return;
              }
            } else {
              // --skip-review path: merge as soon as CI is green
              await mergePr(owner, repo, number, deleteBranch, prUrl, json, ts);
              process.off('SIGINT', onSig);
              process.off('SIGTERM', onSig);
              return;
            }
          }

          // 6. Check poll cap
          if (maxPolls > 0 && polls >= maxPolls) {
            log(chalk.gray(`\nReached --max-polls ${maxPolls}; exiting without merging.`));
            emit({ type: 'max-polls', polls });
            process.exit(0);
          }

          // 7. Wait before next poll
          if (!stopSignal) {
            await new Promise<void>((r) => setTimeout(r, intervalMs));
          }
        }
      } finally {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
      }
    });
}

/** Execute `gh pr merge --rebase [--delete-branch]` and report result. Calls die() on failure. */
async function mergePr(
  owner: string,
  repo: string,
  number: number,
  deleteBranch: boolean,
  prUrl: string,
  json: boolean,
  ts: () => string
): Promise<void> {
  const args = ['pr', 'merge', String(number), '--rebase'];
  if (deleteBranch) args.push('--delete-branch');
  // Repo flag ensures the right repo when run from outside the checkout
  args.push('--repo', `${owner}/${repo}`);

  if (!json) process.stdout.write(`[${ts()}] merging ${chalk.cyan(prUrl)} … `);

  try {
    await execFileAsync('gh', args, { maxBuffer: 1024 * 1024 });
    if (!json) console.log(chalk.green('merged'));
    if (json) console.log(JSON.stringify({ type: 'merged', prUrl, timestamp: new Date().toISOString() }));
  } catch (err) {
    if (!json) console.log(chalk.red('failed'));
    if (json) console.log(JSON.stringify({ type: 'merge-failed', prUrl, error: (err as Error).message, timestamp: new Date().toISOString() }));
    const msg = (err as Error & { stderr?: string }).stderr ?? (err as Error).message;
    die(`Merge failed for ${prUrl}:\n  ${msg}\n\nResolve any conflicts or branch protection issues and retry.`, 1);
  }
}
