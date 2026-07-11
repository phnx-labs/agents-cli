// Impure half of the PR board: `gh pr view` per URL with a short TTL cache and an
// in-flight guard (mirrors swarm.vscode.ts's ciCache idiom), plus the merge action.
// The pure JSON -> PrStatus parse lives in core/prBoard.ts.

import { exec } from 'child_process';
import { promisify } from 'util';
import { parsePrStatus, type PrStatus } from '../core/prBoard';

const execAsync = promisify(exec);

const PR_TTL_MS = 45_000;
const cache = new Map<string, { at: number; status: PrStatus | null }>();
const inFlight = new Map<string, Promise<PrStatus | null>>();

const GH_FIELDS = 'number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup';

async function fetchOne(url: string): Promise<PrStatus | null> {
  try {
    const { stdout } = await execAsync(`gh pr view ${JSON.stringify(url)} --json ${GH_FIELDS}`, {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parsePrStatus(url, stdout);
  } catch {
    // gh unavailable / auth / 404 — no row rather than a fabricated one.
    return null;
  }
}

/**
 * Board statuses for a set of PR URLs. Each URL is fetched at most once per TTL
 * window and never concurrently; misses (gh failure, closed URL) are dropped so
 * the board only renders rows it can back with real data.
 */
export async function fetchPrStatuses(urls: string[]): Promise<PrStatus[]> {
  const unique = [...new Set(urls.filter((u) => typeof u === 'string' && u.startsWith('https://')))];
  const results = await Promise.all(
    unique.map((url) => {
      const cached = cache.get(url);
      if (cached && Date.now() - cached.at <= PR_TTL_MS) return Promise.resolve(cached.status);
      const pending = inFlight.get(url);
      if (pending) return pending;
      const p = fetchOne(url)
        .then((status) => {
          cache.set(url, { at: Date.now(), status });
          return status;
        })
        .finally(() => inFlight.delete(url));
      inFlight.set(url, p);
      return p;
    }),
  );
  return results.filter((s): s is PrStatus => s !== null);
}

/**
 * Merge a PR from the board. Plain `gh pr merge --rebase` — deliberately NO
 * --admin (branch protection stays in force) and no fallback strategy; the board
 * only offers the button on readyToMerge (approved + green + mergeable), so a
 * refusal here is a real signal surfaced back to the UI, not something to bypass.
 */
export async function mergePr(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execAsync(`gh pr merge ${JSON.stringify(url)} --rebase`, { timeout: 30_000 });
    cache.delete(url);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // gh prints the useful reason on stderr, which exec folds into the message.
    return { ok: false, error: msg.slice(0, 400) };
  }
}
