import React from 'react'
import type { TerminalDetail as TerminalInfo } from '../../types'
import { postMessage } from '../../hooks'
import { renderTodoDescription, renderMarkdown } from '../../utils/markdown'
import { useNow } from './useNow'
import { VerticalTimeline } from './Timeline'
import { TodoChecklist } from './TodoChecklist'
import { latestTodos } from './floorModel'

// The detail pane for a live terminal-tab agent. Extracted from UnifiedAgentsPane so the
// visual preview harness can render it standalone without loading the whole pane (which
// pulls a large, side-effectful import graph). Ordered like the headless/cloud detail:
// Task -> Progress (timeline) -> Checklist -> Latest (markdown) -> Activity stats -> files,
// so every agent's detail pane reads identically.

/** File-pill border color: fresh edits blue, fading toward muted grey over ~3 min. */
export function filePillColor(touchedAtMs: number | undefined, now: number): string {
  if (touchedAtMs === undefined) return 'var(--ds-text-muted)'
  const elapsed = now - touchedAtMs
  if (elapsed <= 1000) return '#3b82f6'
  const t = Math.min((elapsed - 1000) / (179000), 1)
  const r = Math.round(59 + t * (156 - 59))
  const g = Math.round(130 + t * (163 - 130))
  const b = Math.round(246 + t * (175 - 246))
  return `rgb(${r},${g},${b})`
}

export function TerminalExpandedDetail({ terminal }: { terminal: TerminalInfo }) {
  const now = useNow(5000)
  const todos = latestTodos(terminal.recentToolCalls)
  const cwdDisplay = terminal.cwd ? terminal.cwd.replace(/^\/Users\/[^/]+/, '~') : null
  const linkStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    padding: 0,
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  }
  return (
    <div className="sw-unified-detail-content">
      {(cwdDisplay || terminal.branch) && (
        <div className="sw-unified-detail-section">
          <div className="mono" style={{ fontSize: 11, color: 'var(--ds-text-dim)' }}>
            {cwdDisplay && terminal.cwd && (
              <button
                type="button"
                style={linkStyle}
                title="Reveal folder"
                onClick={() => postMessage({ type: 'revealFolder', path: terminal.cwd })}
              >
                {cwdDisplay}
              </button>
            )}
            {cwdDisplay && terminal.branch && <span>{' · branch: '}</span>}
            {terminal.branch && (
              <button
                type="button"
                style={linkStyle}
                title="Open Source Control"
                onClick={() => postMessage({ type: 'openSourceControl' })}
              >
                {terminal.branch}
              </button>
            )}
          </div>
        </div>
      )}
      {terminal.firstUserMessage && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Task</div>
          <div className="sw-unified-detail-text">
            {renderTodoDescription(terminal.firstUserMessage, false)}
          </div>
        </div>
      )}
      {/* Progress timeline: the recent tool calls as a vertical rail, oldest -> now —
          the same VerticalTimeline the headless/cloud detail uses, so terminal, headless
          and cloud detail panes read identically (was a flat "Recent tools" list). */}
      {terminal.recentToolCalls && terminal.recentToolCalls.length > 0 && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Progress <span className="sw-section-count">{Math.min(terminal.recentToolCalls.length, 8)} recent</span></div>
          <VerticalTimeline recent={terminal.recentToolCalls} nowMs={now} />
        </div>
      )}
      {todos.length > 0 && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Checklist</div>
          <TodoChecklist todos={todos} />
        </div>
      )}
      {/* Latest message: the agent's most recent prose (markdown), streaming on the poll.
          Falls back to the now-line when it hasn't spoken between tool calls yet. */}
      {(terminal.quickSummary?.narrative || terminal.currentActivity) && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Latest</div>
          <div className="sw-activity-feed">
            <div className="sw-activity-msg md">{renderMarkdown(terminal.quickSummary?.narrative || terminal.currentActivity || '')}</div>
          </div>
        </div>
      )}
      {(terminal.quickSummary || terminal.messageCount) && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Activity</div>
          <div className="sw-unified-detail-stats">
            {terminal.messageCount && terminal.messageCount > 0 && <span>{terminal.messageCount} msgs</span>}
            {terminal.quickSummary && terminal.quickSummary.filesEdited > 0 && <span>{terminal.quickSummary.filesEdited} files edited</span>}
            {terminal.quickSummary && terminal.quickSummary.toolCalls > 0 && <span>{terminal.quickSummary.toolCalls} tool calls</span>}
            {terminal.quickSummary && terminal.quickSummary.webSearches > 0 && <span>{terminal.quickSummary.webSearches} web searches</span>}
          </div>
        </div>
      )}
      {terminal.recentFiles && terminal.recentFiles.length > 0 && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Recent files</div>
          <div className="sw-unified-detail-files">
            {[...terminal.recentFiles]
              .sort((a, b) => {
                const ta = terminal.recentFileTimes?.[a]
                const tb = terminal.recentFileTimes?.[b]
                if (ta !== undefined && tb !== undefined) return tb - ta
                if (ta !== undefined) return -1
                if (tb !== undefined) return 1
                return 0
              })
              .slice(0, 12)
              .map((f) => {
                const stat = terminal.recentFileStats?.[f]
                const touchedAt = terminal.recentFileTimes?.[f]
                const color = filePillColor(touchedAt, now)
                return (
                  <button
                    key={f}
                    type="button"
                    className="mono sw-unified-file-pill sw-unified-file-pill-btn"
                    title={f}
                    style={{ borderColor: color, color }}
                    onClick={() => postMessage({ type: 'openTerminalFile', path: f })}
                  >
                    {f.split('/').pop()}
                    {stat && (
                      <span className="sw-unified-file-pill-stat">
                        {stat.added > 0 && <span style={{ color: 'var(--ds-diff-added, #4ade80)' }}>+{stat.added}</span>}
                        {stat.added > 0 && stat.removed > 0 && ' '}
                        {stat.removed > 0 && <span style={{ color: 'var(--ds-diff-removed, #f87171)' }}>-{stat.removed}</span>}
                      </span>
                    )}
                  </button>
                )
              })}
          </div>
        </div>
      )}
    </div>
  )
}
