// Shared "now" ticker for live heartbeats. One setInterval per interval bucket is
// shared across every subscriber, so N Floor cards don't each hold their own timer.
//
// The value is BUCKETED down to the interval (e.g. the second boundary) so identical
// ticks are referentially equal — a card's live-age memo signature only changes when
// the bucket actually advances, never sub-tick. Callers that fold the age into a list
// memo should pass a coarser interval (e.g. useNow(5000)) so the whole list doesn't
// re-sort every second.
import { useEffect, useState } from 'react'

type Listener = (now: number) => void

interface Ticker {
  timer: ReturnType<typeof setInterval>
  listeners: Set<Listener>
  last: number
}

const tickers = new Map<number, Ticker>()

function bucketed(intervalMs: number): number {
  return Math.floor(Date.now() / intervalMs) * intervalMs
}

function ensureTicker(intervalMs: number): Ticker {
  const existing = tickers.get(intervalMs)
  if (existing) return existing
  const listeners = new Set<Listener>()
  const ticker: Ticker = {
    listeners,
    last: bucketed(intervalMs),
    timer: setInterval(() => {
      const rec = tickers.get(intervalMs)
      if (!rec) return
      const now = bucketed(intervalMs)
      if (now === rec.last) return
      rec.last = now
      for (const l of rec.listeners) l(now)
    }, intervalMs),
  }
  tickers.set(intervalMs, ticker)
  return ticker
}

/** Current wall-clock ms, re-rendering the caller each `intervalMs` (default 1s). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => bucketed(intervalMs))
  useEffect(() => {
    const ticker = ensureTicker(intervalMs)
    const listener: Listener = (n) => setNow(n)
    ticker.listeners.add(listener)
    // Sync immediately in case the shared ticker already advanced before we mounted.
    setNow(bucketed(intervalMs))
    return () => {
      ticker.listeners.delete(listener)
      if (ticker.listeners.size === 0) {
        clearInterval(ticker.timer)
        tickers.delete(intervalMs)
      }
    }
  }, [intervalMs])
  return now
}
