/** Device-local owner for usage snapshots and authentication health. */

export const USAGE_STATE_TICK_MS = 60_000;
export const AUTH_STATE_TICK_MS = 3 * 60_000;

export interface AccountStateService {
  stop(): void;
}

export interface AccountStateServiceDeps {
  refreshUsage: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  onError?: (area: 'usage' | 'auth', error: unknown) => void;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

/**
 * Start the daemon-owned account-state loops.
 *
 * Each loop is overlap-safe within the daemon. Provider-level work is also
 * guarded by the cross-process refresh lease, so an explicit CLI refresh and
 * an older routine process converge on the same published result.
 */
export function startAccountStateService(deps: AccountStateServiceDeps): AccountStateService {
  const setTimer = deps.setInterval ?? globalThis.setInterval;
  const clearTimer = deps.clearInterval ?? globalThis.clearInterval;
  let usageRunning = false;
  let authRunning = false;
  let stopped = false;

  const runUsage = async (): Promise<void> => {
    if (stopped || usageRunning) return;
    usageRunning = true;
    try { await deps.refreshUsage(); }
    catch (error) { deps.onError?.('usage', error); }
    finally { usageRunning = false; }
  };
  const runAuth = async (): Promise<void> => {
    if (stopped || authRunning) return;
    authRunning = true;
    try { await deps.refreshAuth(); }
    catch (error) { deps.onError?.('auth', error); }
    finally { authRunning = false; }
  };

  const usageTimer = setTimer(() => { void runUsage(); }, USAGE_STATE_TICK_MS);
  const authTimer = setTimer(() => { void runAuth(); }, AUTH_STATE_TICK_MS);
  usageTimer.unref?.();
  authTimer.unref?.();
  void runUsage();
  void runAuth();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimer(usageTimer);
      clearTimer(authTimer);
    },
  };
}
