/**
 * Cross-platform cooperative cancellation for the harness auto-update pass
 * (PHNX-3940).
 *
 * The pass mutates the filesystem transactionally — stage an npm install into a
 * sibling dir, launch-probe it, swap it in, record the new release, drop the
 * rollback material (see `update.ts`). Interrupting it mid-swap can leave an
 * installation whose directory and its own metadata disagree, with no way back.
 * So it must be cancellable from OUTSIDE the process — on the daemon's per-tick
 * deadline, or on daemon shutdown — WITHOUT terminating a process that is mid-swap.
 *
 * `execFile`'s `timeout`/`AbortSignal` do exactly the wrong thing here: they
 * FORCE-terminate the child. On Windows that is unconditional (there are no POSIX
 * signals to cooperate with — the SIGTERM listener the pass installs never runs),
 * so a Windows daemon would kill its own update worker mid-rename. Even on POSIX
 * the forced kill races the swap.
 *
 * The fix is a request, not a kill: the daemon spawns the pass as a child over a
 * Node IPC channel and asks it to stop by SENDING A MESSAGE. The child flips a
 * flag that `update.ts`'s existing `shouldCancel` reads at each safe boundary
 * (before the next installation, before staging, and immediately before commit)
 * and finishes what it is doing cleanly. The channel closing (parent gone) and a
 * received SIGTERM/SIGINT are treated as the same request, so a force-killed
 * daemon can never strand a child mutating forever, and a manual `agents update
 * --auto` interrupted with Ctrl+C also stops at a boundary rather than mid-swap.
 *
 * This module is a dependency-free LEAF on purpose: `index.ts` reads the guard
 * depth below through the shared {@link GUARDED_AUTO_UPDATE_SYMBOL} registry key
 * (never importing this module, so the slim CLI shell stays slim), and the daemon
 * child fixture in tests imports {@link withGuardedUpdateCancellation} without
 * pulling the installations graph.
 */

/**
 * The hidden verb the daemon spawns to run one auto-update pass with IPC-driven
 * cancellation (dispatched in `index.ts`, handled by
 * `update-runtime.ts`'s `runHarnessUpdateChild`). Internal protocol — not a
 * public command.
 */
export const HARNESS_UPDATE_CHILD_CMD = '__harness-update-run';

/** IPC message `type` the daemon sends to request a cooperative stop. */
export const HARNESS_UPDATE_CANCEL_MSG = 'harness-update:cancel';

/**
 * Well-known cross-realm key naming the count of guarded auto-update passes
 * running IN THIS PROCESS right now. `index.ts`'s top-level SIGINT handler reads
 * it via `Symbol.for(...)` WITHOUT importing this module (keeping the slim entry
 * shell free of a heavy static import — see `agent.test.ts`'s import guard), so
 * the guard state has to live somewhere both can reach: the global symbol
 * registry.
 */
export const GUARDED_AUTO_UPDATE_SYMBOL = Symbol.for('agents.guardedAutoUpdateDepth');

type GuardHolder = { [GUARDED_AUTO_UPDATE_SYMBOL]?: number };

/** The IPC payload the daemon sends; `child.send(cancelMessage())`. */
export function cancelMessage(): { type: typeof HARNESS_UPDATE_CANCEL_MSG } {
  return { type: HARNESS_UPDATE_CANCEL_MSG };
}

function isCancelMessage(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === HARNESS_UPDATE_CANCEL_MSG
  );
}

/**
 * True while a guarded auto-update pass is mutating this process. Read by
 * `index.ts`'s SIGINT handler (which reads the same registry symbol directly) to
 * DEFER its default `process.exit(130)` so a Ctrl+C can't tear a swap apart; the
 * pass still observes the SIGINT cooperatively and stops at its next boundary.
 * Ref-counted (a depth, not a boolean) so it is correct even if a pass ever nests.
 */
export function isGuardedAutoUpdateActive(): boolean {
  return ((globalThis as GuardHolder)[GUARDED_AUTO_UPDATE_SYMBOL] ?? 0) > 0;
}

function beginGuardedAutoUpdate(): void {
  const holder = globalThis as GuardHolder;
  holder[GUARDED_AUTO_UPDATE_SYMBOL] = (holder[GUARDED_AUTO_UPDATE_SYMBOL] ?? 0) + 1;
}

function endGuardedAutoUpdate(): void {
  const holder = globalThis as GuardHolder;
  const depth = holder[GUARDED_AUTO_UPDATE_SYMBOL] ?? 0;
  holder[GUARDED_AUTO_UPDATE_SYMBOL] = depth > 0 ? depth - 1 : 0;
}

/**
 * Run `run(cancelled)` with cooperative cancellation wired from every source
 * that can reach this process, and the SIGINT guard held for its duration:
 *
 *   - **IPC message** `{ type: HARNESS_UPDATE_CANCEL_MSG }` — the primary,
 *     cross-platform request the daemon sends. Works on Windows, where a signal
 *     would force-kill.
 *   - **`disconnect`** — the IPC channel closed (the daemon went away). Stop
 *     rather than continue mutating orphaned.
 *   - **SIGTERM / SIGINT** — a direct `kill`/Ctrl+C on this process. Cooperative,
 *     not fatal; paired with `index.ts`'s guard, which defers its hard exit while
 *     {@link isGuardedAutoUpdateActive} holds.
 *
 * `cancelled()` never un-sets once set. Listeners are installed for the call's
 * lifetime only and removed in `finally`, and the process-wide `message`/
 * `disconnect` listeners are harmless when there is no IPC channel (they simply
 * never fire), so this is safe on the in-process manual `agents update --auto`
 * path too.
 */
export async function withGuardedUpdateCancellation<T>(
  run: (cancelled: () => boolean) => Promise<T>,
): Promise<T> {
  let cancelled = typeof process.send === 'function' && process.connected === false;
  const requestStop = (): void => {
    cancelled = true;
  };
  const onMessage = (msg: unknown): void => {
    if (isCancelMessage(msg)) requestStop();
  };

  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  process.on('message', onMessage);
  process.on('disconnect', requestStop);
  beginGuardedAutoUpdate();
  try {
    return await run(() => cancelled);
  } finally {
    endGuardedAutoUpdate();
    process.removeListener('SIGTERM', requestStop);
    process.removeListener('SIGINT', requestStop);
    process.removeListener('message', onMessage);
    process.removeListener('disconnect', requestStop);
  }
}
