import React, { useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from './icons'
import { renderTodoDescription } from '../../utils/markdown'
import { AgentAvatar } from './AgentAvatar'
import {
  parseCloudSummaryIncremental,
  emptyCloudParseCache,
  toolHeadline,
  simpleDiff,
  type CloudEvent,
  type CloudParseCache,
  type PreambleMeta,
  type ToolUseEvent,
  type ToolResultEvent,
} from './cloudActivity'

interface CloudActivityFeedProps {
  summary: string | null | undefined
  maxHeight?: number
}

type Row =
  | { kind: 'preamble'; ev: Extract<CloudEvent, { kind: 'preamble' }> }
  | { kind: 'system'; ev: Extract<CloudEvent, { kind: 'system' }> }
  | { kind: 'thinking'; ev: Extract<CloudEvent, { kind: 'thinking' }> }
  | { kind: 'assistant'; ev: Extract<CloudEvent, { kind: 'assistant' }> }
  | { kind: 'user'; ev: Extract<CloudEvent, { kind: 'user' }> }
  | { kind: 'tool'; use: ToolUseEvent; result?: ToolResultEvent }
  | { kind: 'orphan-result'; ev: ToolResultEvent }
  | { kind: 'result'; ev: Extract<CloudEvent, { kind: 'result' }> }

/**
 * Group a flat event list into render rows so tool_use and its matching
 * tool_result render together as a single card.
 */
function groupEvents(events: CloudEvent[]): Row[] {
  const rows: Row[] = []
  const toolRowByUseId = new Map<string, { kind: 'tool'; use: ToolUseEvent; result?: ToolResultEvent }>()
  for (const ev of events) {
    switch (ev.kind) {
      case 'preamble':
        if (ev.isMetric) break
        rows.push({ kind: 'preamble', ev })
        break
      case 'system':
        rows.push({ kind: 'system', ev })
        break
      case 'thinking':
        rows.push({ kind: 'thinking', ev })
        break
      case 'assistant':
        rows.push({ kind: 'assistant', ev })
        break
      case 'user':
        rows.push({ kind: 'user', ev })
        break
      case 'tool-use': {
        const row = { kind: 'tool' as const, use: ev }
        rows.push(row)
        toolRowByUseId.set(ev.id, row)
        break
      }
      case 'tool-result': {
        const parent = toolRowByUseId.get(ev.id)
        if (parent) parent.result = ev
        else rows.push({ kind: 'orphan-result', ev })
        break
      }
      case 'result':
        rows.push({ kind: 'result', ev })
        break
    }
  }
  return rows
}

export function CloudActivityFeed({ summary, maxHeight = 480 }: CloudActivityFeedProps) {
  // Parse only the bytes appended since last render instead of re-scanning the
  // whole (growing) NDJSON buffer on every streamed token.
  const cacheRef = useRef<CloudParseCache>(emptyCloudParseCache())
  const events = useMemo(() => parseCloudSummaryIncremental(summary, cacheRef.current), [summary])
  const rows = useMemo(() => groupEvents(events), [events])

  if (rows.length === 0) {
    return (
      <div className="sw-cloud-feed-empty">
        Waiting for first event...
      </div>
    )
  }

  return (
    <div className="sw-cloud-feed" style={{ maxHeight }}>
      {rows.map((row, i) => (
        <FeedRow key={i} row={row} />
      ))}
    </div>
  )
}

function FeedRow({ row }: { row: Row }) {
  switch (row.kind) {
    case 'preamble':
      if (row.ev.meta) return <PreambleMetaRow meta={row.ev.meta} tSec={row.ev.tSec} />
      return <PreambleRow text={row.ev.text} tSec={row.ev.tSec} />
    case 'system':
      return <SystemRow summary={row.ev.summary} />
    case 'thinking':
      return <ThinkingRow text={row.ev.text} />
    case 'assistant':
      return <AssistantRow text={row.ev.text} />
    case 'user':
      return <UserRow text={row.ev.text} />
    case 'tool':
      return <ToolRow use={row.use} result={row.result} />
    case 'orphan-result':
      return <ToolResultBlock content={row.ev.content} isError={row.ev.isError} />
    case 'result':
      return <ResultRow subtype={row.ev.subtype} durationMs={row.ev.durationMs} />
  }
}

function PreambleRow({ text, tSec }: { text: string; tSec?: number }) {
  return (
    <div className="sw-cloud-feed-row sw-cloud-feed-preamble">
      {typeof tSec === 'number' && (
        <span className="sw-cloud-feed-tsec mono">t+{tSec}s</span>
      )}
      <span className="sw-cloud-feed-preamble-text mono">{text}</span>
    </div>
  )
}

function PreambleMetaRow({ meta, tSec }: { meta: PreambleMeta; tSec?: number }) {
  const repoBits = [meta.repo, meta.branch ? `(${meta.branch})` : ''].filter(Boolean).join(' ')
  return (
    <div className="sw-cloud-feed-row sw-cloud-feed-preamble">
      {typeof tSec === 'number' && <span className="sw-cloud-feed-tsec mono">t+{tSec}s</span>}
      <AgentAvatar id={meta.agentCli} size={14} />
      <span className="sw-cloud-feed-preamble-text mono">
        {meta.model && <span>{meta.model}</span>}
        {repoBits && (
          <span style={{ color: 'var(--ds-text-dim)' }}>
            {meta.model ? ' · ' : ''}
            {repoBits}
          </span>
        )}
        {meta.user && (
          <span style={{ color: 'var(--ds-text-dim)' }}> · {meta.user}</span>
        )}
      </span>
    </div>
  )
}

function SystemRow({ summary }: { summary: string }) {
  return (
    <div className="sw-cloud-feed-row sw-cloud-feed-system">
      <Icon name="zap" size={11} />
      <span>{summary}</span>
    </div>
  )
}

function ThinkingRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const preview = text.replace(/\s+/g, ' ').slice(0, 120)
  return (
    <div className="sw-cloud-feed-row sw-cloud-feed-thinking">
      <button
        type="button"
        className="sw-cloud-feed-thinking-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon name="chevD" size={11} style={expanded ? undefined : { transform: 'rotate(-90deg)' }} />
        <span>Thinking</span>
      </button>
      <div className="sw-cloud-feed-thinking-text">
        {expanded ? text : preview + (text.length > preview.length ? '...' : '')}
      </div>
    </div>
  )
}

function AssistantRow({ text }: { text: string }) {
  return (
    <div className="sw-cloud-feed-row sw-cloud-feed-assistant">
      {renderTodoDescription(text, false)}
    </div>
  )
}

function UserRow({ text }: { text: string }) {
  return (
    <div className="sw-cloud-feed-row sw-cloud-feed-user">
      <div className="sw-cloud-feed-user-text">{text}</div>
    </div>
  )
}

function ResultRow({ subtype, durationMs }: { subtype: string; durationMs?: number }) {
  const iconName: IconName = subtype === 'success' ? 'check' : 'x'
  return (
    <div className="sw-cloud-feed-row sw-cloud-feed-result">
      <Icon name={iconName} size={12} />
      <span>
        {subtype === 'success' ? 'Completed' : `Ended (${subtype})`}
        {typeof durationMs === 'number' && <span className="sw-cloud-feed-result-dur mono"> · {formatDuration(durationMs)}</span>}
      </span>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m ${rs}s`
}

function ToolRow({ use, result }: { use: ToolUseEvent; result?: ToolResultEvent }) {
  const [expanded, setExpanded] = useState(false)
  const iconName = iconForTool(use.name)
  const headline = toolHeadline(use)
  return (
    <div className="sw-cloud-feed-row sw-cloud-feed-tool">
      <button
        type="button"
        className="sw-cloud-feed-tool-head sw-cloud-feed-tool-head-btn"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Icon name={iconName} size={12} />
        <span className="sw-cloud-feed-tool-headline mono">{headline}</span>
        <span className="sw-cloud-feed-tool-toggle">{expanded ? 'Hide' : 'Details'}</span>
      </button>
      <ToolBody use={use} />
      {result && <ToolResultBlock content={result.content} isError={result.isError} />}
      {expanded && <ToolDetails use={use} result={result} />}
    </div>
  )
}

function ToolDetails({ use, result }: { use: ToolUseEvent; result?: ToolResultEvent }) {
  const inputJson = useMemo(() => {
    try {
      return JSON.stringify(use.input, null, 2)
    } catch {
      return String(use.input)
    }
  }, [use.input])
  return (
    <div className="sw-cloud-feed-tool-details">
      <div className="sw-cloud-feed-tool-detail-section">
        <div className="sw-cloud-feed-tool-detail-label">Input</div>
        <pre className="sw-cloud-feed-tool-detail-pre mono">{inputJson}</pre>
      </div>
      {result && result.content && (
        <div className="sw-cloud-feed-tool-detail-section">
          <div className={`sw-cloud-feed-tool-detail-label${result.isError ? ' err' : ''}`}>
            {result.isError ? 'Error' : 'Result'}
          </div>
          <pre className={`sw-cloud-feed-tool-detail-pre mono${result.isError ? ' err' : ''}`}>{result.content}</pre>
        </div>
      )}
    </div>
  )
}

function iconForTool(name: string): IconName {
  switch (name) {
    case 'Read':
    case 'NotebookEdit':
      return 'folder'
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
      return 'search'
    case 'Edit':
    case 'Write':
      return 'copy'
    case 'Bash':
      return 'terminal'
    case 'Task':
      return 'dispatch'
    case 'WebFetch':
      return 'external'
    case 'TodoWrite':
      return 'clipboard'
    default:
      return 'zap'
  }
}

function ToolBody({ use }: { use: ToolUseEvent }) {
  const i = use.input
  if (use.name === 'Edit') {
    const oldStr = typeof i.old_string === 'string' ? i.old_string : ''
    const newStr = typeof i.new_string === 'string' ? i.new_string : ''
    const rows = simpleDiff(oldStr, newStr)
    if (rows.length === 0) return null
    return (
      <pre className="sw-cloud-feed-diff mono">
        {rows.map((r, i) => (
          <div key={i} className={`sw-cloud-feed-diff-row diff-${r.kind}`}>
            <span className="sw-cloud-feed-diff-sign">
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
            </span>
            <span>{r.text || '\u00a0'}</span>
          </div>
        ))}
      </pre>
    )
  }
  if (use.name === 'Write') {
    const content = typeof i.content === 'string' ? i.content : ''
    return <CollapsibleCode content={content} lang={guessLangFromPath(typeof i.file_path === 'string' ? i.file_path : '')} />
  }
  if (use.name === 'Bash') {
    const desc = typeof i.description === 'string' ? i.description : ''
    if (!desc) return null
    return <div className="sw-cloud-feed-tool-desc">{desc}</div>
  }
  if (use.name === 'Task') {
    const prompt = typeof i.prompt === 'string' ? i.prompt : ''
    if (!prompt) return null
    return <CollapsibleCode content={prompt} maxPreviewLines={3} />
  }
  if (use.name === 'TodoWrite') {
    const todos = Array.isArray(i.todos) ? (i.todos as unknown[]) : []
    if (todos.length === 0) return null
    return (
      <ul className="sw-cloud-feed-todos">
        {todos.map((t, idx) => {
          const td = (t && typeof t === 'object') ? (t as Record<string, unknown>) : {}
          const status = typeof td.status === 'string' ? td.status : 'pending'
          const content = typeof td.content === 'string'
            ? td.content
            : typeof td.activeForm === 'string' ? td.activeForm : ''
          return (
            <li key={idx} className={`sw-cloud-feed-todo status-${status}`}>
              <span className="sw-cloud-feed-todo-marker">
                {status === 'completed' ? '\u2713' : status === 'in_progress' ? '\u25b8' : '\u25cb'}
              </span>
              <span>{content}</span>
            </li>
          )
        })}
      </ul>
    )
  }
  return null
}

function CollapsibleCode({
  content,
  lang,
  maxPreviewLines = 6,
}: {
  content: string
  lang?: string
  maxPreviewLines?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const truncated = lines.length > maxPreviewLines
  const shown = expanded || !truncated ? content : lines.slice(0, maxPreviewLines).join('\n')
  return (
    <div className="sw-cloud-feed-code-wrap">
      <pre className="sw-cloud-feed-code mono" data-lang={lang || ''}>
        {shown}
        {!expanded && truncated && '\n...'}
      </pre>
      {truncated && (
        <button
          type="button"
          className="sw-cloud-feed-code-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Collapse' : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  )
}

function ToolResultBlock({ content, isError }: { content: string; isError: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const trimmed = content.replace(/\s+$/, '')
  if (!trimmed) return null
  const lines = trimmed.split('\n')
  const truncated = lines.length > 4 || trimmed.length > 400
  const preview = expanded
    ? trimmed
    : lines.slice(0, 4).join('\n').slice(0, 400)
  return (
    <div className={`sw-cloud-feed-tool-result${isError ? ' err' : ''}`}>
      <pre className="sw-cloud-feed-tool-result-pre mono">{preview}{!expanded && truncated ? '\n...' : ''}</pre>
      {truncated && (
        <button
          type="button"
          className="sw-cloud-feed-code-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Collapse' : `Expand (${lines.length} lines)`}
        </button>
      )}
    </div>
  )
}

function guessLangFromPath(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i)
  if (!m) return ''
  const ext = m[1].toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', go: 'go', rs: 'rust', md: 'markdown',
    css: 'css', html: 'html', json: 'json', yml: 'yaml', yaml: 'yaml',
    sh: 'bash', toml: 'toml',
  }
  return map[ext] || ext
}
