import { useEffect, useState } from 'react'

/**
 * A once-per-`intervalMs` ticker returning `Date.now()`. Drives live relative-age
 * labels (a session's "since", a tool step's "40s", a file pill's freshness) so they
 * re-render on a fixed cadence instead of only when their data changes.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
