/**
 * Shared parameters for the per-installation `installation.json` lock
 * (PHNX-3940).
 *
 * The SAME physical lock file (`installationRecordPath(agent, label)`) is
 * taken by three independent critical sections — the update transaction
 * (`update.ts`), the launch gate (`launch-gate.ts`), and a policy write
 * (`update-policy.ts`) — and every holder MUST agree on `staleMs`: it is the
 * threshold at which a PEER decides a lock is abandoned and breaks it, so a
 * mismatch would let one side break a lock the other legitimately still
 * holds mid-transaction. `fs-atomic.ts`'s own default (5s stale / 30s
 * acquire) is far too short for a critical section that can run a real npm
 * install (minutes) plus launch probes — using it anywhere on this lock
 * (as `setInstallationUpdatePolicy` used to, before this leaf existed) let a
 * policy write break a live update's lock out from under it.
 *
 * A dependency-free leaf — no imports from `store.js`/`shims.js`/`update.js`/
 * `update-policy.js`/`launch-gate.js` — so every lock-taking module can
 * import it with no import cycle.
 */
import type { FileLockOptions } from '../fs-atomic.js';

/**
 * How long a held installation lock may go without a refresh before a peer
 * treats it as abandoned and breaks it. Every holder of this lock MUST use
 * this exact value — see the module docblock.
 */
export const INSTALLATION_LOCK_STALE_MS = 10 * 60_000;

/**
 * How long `updateInstallation` / `setInstallationUpdatePolicy` will wait to
 * acquire the lock before giving up — long enough to sit behind one full
 * concurrent transaction on the SAME installation (stage + verify + commit +
 * re-verify) rather than failing loud the instant two callers overlap.
 * `launch-gate.ts` intentionally uses its own, shorter acquire timeout
 * (bounded by how long a launch should wait, not an update) while still
 * sharing {@link INSTALLATION_LOCK_STALE_MS}.
 */
export const INSTALLATION_LOCK_ACQUIRE_TIMEOUT_MS = 5 * 60_000;

/** Ready-to-spread `withFileLockAsync` options for the update-style (long, transactional) hold on this lock. */
export const INSTALLATION_LOCK_OPTIONS: Required<FileLockOptions> = {
  staleMs: INSTALLATION_LOCK_STALE_MS,
  acquireTimeoutMs: INSTALLATION_LOCK_ACQUIRE_TIMEOUT_MS,
};
