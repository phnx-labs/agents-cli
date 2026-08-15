/**
 * Bounded, staggered restore scheduling (RUSH-2477).
 *
 * A crash-restart reopens every persisted agent tab at once. Restoring them by
 * firing one resume per tab with no cap or stagger is a thundering herd: N tabs
 * become N near-simultaneous resume child processes within seconds of boot, which
 * is exactly what overwhelmed the resume path (DB-lock crashes, boot-time fleet
 * fan-out) in the incident. `runStaggered` bounds that — at most `concurrency`
 * restores run at once, and each start after the first is spaced by `staggerMs`,
 * so the resumes trickle in instead of stampeding.
 *
 * Pure and side-effect-free apart from the injected `sleep`, so a test can assert
 * the concurrency cap and the stagger deterministically without real timers.
 */

/** At most this many tabs restore at once. */
export const RESTORE_MAX_CONCURRENCY = 2;
/** Space each restore start after the first by this long. */
export const RESTORE_STAGGER_MS = 300;

export interface RunStaggeredOptions {
  /** Max restores in flight at once (default RESTORE_MAX_CONCURRENCY, floored at 1). */
  concurrency?: number;
  /** Delay before each start after the first (default RESTORE_STAGGER_MS, floored at 0). */
  staggerMs?: number;
  /** Injectable delay — real timer in production, controllable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `worker` over `items` with a concurrency cap and a per-start stagger.
 *
 * A worker that throws does not abort the batch — the error is logged (with the
 * item index) and swallowed so one un-resumable tab never strands the rest.
 * Resolves once every item has been processed.
 */
export async function runStaggered<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  opts: RunStaggeredOptions = {},
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? RESTORE_MAX_CONCURRENCY);
  const staggerMs = Math.max(0, opts.staggerMs ?? RESTORE_STAGGER_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (items.length === 0) return;

  let next = 0;
  const runOne = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      // Every start but the very first waits, so the resume children never spawn
      // in the same instant even when a slot frees up immediately.
      if (index > 0 && staggerMs > 0) await sleep(staggerMs);
      try {
        await worker(items[index], index);
      } catch (err) {
        // One un-resumable tab must not strand the batch — but a silent drop is
        // undiagnosable, and clearPersistedSessions runs right after, so the tab
        // is gone for good. Log which item failed and why, then continue.
        console.error(`[RESTORE] item ${index} failed to restore, continuing: ${err}`);
      }
    }
  };

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runOne(),
  );
  await Promise.all(runners);
}
