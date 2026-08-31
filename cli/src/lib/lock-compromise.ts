/**
 * proper-lockfile invokes this callback from its background refresh timer.
 * Its default is to throw there, outside the caller's promise chain, which can
 * terminate the daemon. These leases are advisory serialization barriers: log
 * a broken lease and let the owning operation finish instead of crashing the
 * shared process.
 */
export function logAndContinueOnLockCompromised(scope: string): (err: Error) => void {
  return (err: Error) => {
    console.warn(`[agents ${scope}] Lock was compromised; continuing without crashing: ${err.message}`);
  };
}
