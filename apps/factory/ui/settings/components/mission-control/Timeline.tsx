import React from 'react'
import type { RecentToolCall } from './floorModel'

// Progress timeline from a session's recent tool calls. Two affordances share the same
// step derivation (toolTarget / stepAgo below):
//   MiniTimeline — the compact last-N steps on the feed card (matches the mockup .mtl).
//   VerticalTimeline — the detail-pane rail (matches the mockup .vtl).
// `recent` arrives NEWEST-FIRST (session.summary.ts unshifts each call), so both render
// OLDEST -> newest top-to-bottom, with the newest as the pulsing "now" head.

/** Compact target for a tool call: the basename for a file path, else a short arg. */
export function toolTarget(call: RecentToolCall): string {
  const input = call.input
  if (!input || typeof input !== 'object') return ''
  const rec = input as Record<string, unknown>
  // File-ish keys read best as a basename; free-text keys as a short clause.
  const pathKeys = ['file_path', 'path', 'target_file', 'notebook_path']
  for (const key of pathKeys) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) {
      const seg = v.split('/').filter(Boolean).pop() ?? v
      return seg
    }
  }
  const textKeys = ['command', 'query', 'pattern', 'url', 'description', 'prompt']
  for (const key of textKeys) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) {
      const t = v.trim().replace(/\s+/g, ' ')
      return t.length > 42 ? t.slice(0, 42) + '…' : t
    }
  }
  return ''
}

/** Relative age label ("now" / "40s" / "3m" / "2h") for a tool call's timestamp. */
export function stepAgo(timestamp: string | undefined, nowMs: number): string {
  if (!timestamp) return ''
  const ms = new Date(timestamp).getTime()
  if (!isFinite(ms)) return ''
  const s = Math.max(0, Math.floor((nowMs - ms) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Newest-first `recent` -> oldest-first steps, capped to `limit` most-recent calls. */
function orderedSteps(recent: RecentToolCall[], limit: number): RecentToolCall[] {
  return recent.slice(0, limit).reverse()
}

interface MiniTimelineProps {
  recent: RecentToolCall[]
  nowMs: number
  /** How many recent steps to show (default 4, per the mockup). */
  limit?: number
}

/** Compact mini-timeline for the feed card: last ~4 tool steps, current one pulsing. */
export function MiniTimeline({ recent, nowMs, limit = 4 }: MiniTimelineProps) {
  if (recent.length === 0) return null
  const steps = orderedSteps(recent, limit)
  const lastIndex = steps.length - 1
  return (
    <div className="mtl" onClick={(e) => e.stopPropagation()}>
      <div className="mtl-cap">Progress · last {steps.length} {steps.length === 1 ? 'step' : 'steps'}</div>
      {steps.map((call, i) => {
        const now = i === lastIndex
        const target = toolTarget(call)
        return (
          <div key={`${call.name}-${i}`} className={`step ${now ? 'now' : 'done'}`}>
            <span className="mk" />
            <span className="nm">{call.name}</span>
            {target && <span className="tt mono">{target}</span>}
            <span className="ago">{stepAgo(call.timestamp, nowMs)}</span>
          </div>
        )
      })}
    </div>
  )
}

interface VerticalTimelineProps {
  recent: RecentToolCall[]
  nowMs: number
  /** How many recent steps to show (default 8). */
  limit?: number
}

/** Detail-pane vertical timeline: last ~8 tool steps as a connected rail. */
export function VerticalTimeline({ recent, nowMs, limit = 8 }: VerticalTimelineProps) {
  if (recent.length === 0) return null
  const steps = orderedSteps(recent, limit)
  const lastIndex = steps.length - 1
  return (
    <ul className="vtl">
      {steps.map((call, i) => {
        const now = i === lastIndex
        const target = toolTarget(call)
        return (
          <li key={`${call.name}-${i}`} className={now ? 'now' : ''}>
            <span className="mk" />
            <span className="nm">{call.name}{target && <span className="t mono"> {target}</span>}</span>
            <span className="ago">{stepAgo(call.timestamp, nowMs)}</span>
          </li>
        )
      })}
    </ul>
  )
}
