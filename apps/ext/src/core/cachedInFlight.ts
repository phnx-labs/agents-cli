// Coalesce concurrent + repeated async fetches keyed by a string. Two callers
// asking for the same key at the same time share ONE in-flight promise; a call
// within `ttlMs` of the last resolved value gets the cache instead of re-running.
//
// This is the guard that stops several uncoordinated drivers (the launch-health
// timer, the Dispatch panel's deviceHealth probe, each agent launch) from EACH
// spawning a full-fleet fan-out of `agents` subprocesses for the same host —
// the pile-up that thrashed dozens of duplicate `agents sessions --active
// --device <box>` processes on a loaded box. `fetchDeviceStats` had this guard
// inline; `countRunningAgents` did not, so it was the one probe that stacked.

export interface TimedCache<T> {
  cache: Map<string, { value: T; at: number }>;
  inFlight: Map<string, Promise<T>>;
}

export function createTimedCache<T>(): TimedCache<T> {
  return { cache: new Map(), inFlight: new Map() };
}

export async function cachedInFlight<T>(
  store: TimedCache<T>,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const cached = store.cache.get(key);
  if (cached && now - cached.at < ttlMs) return cached.value;
  const existing = store.inFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const value = await fn();
    // Cache at the call-entry time so the TTL window measures from when the
    // caller asked, matching the prior inline behavior in fetchDeviceStats.
    store.cache.set(key, { value, at: now });
    return value;
  })();
  store.inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    store.inFlight.delete(key);
  }
}
