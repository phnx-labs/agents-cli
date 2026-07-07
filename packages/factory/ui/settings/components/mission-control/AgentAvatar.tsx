import React, { useState } from 'react'
import type { IconConfig } from '../../types'
import { getIcons } from '../../hooks/useVscodeApi'
import { getIcon } from '../../utils/icons'

export type AgentId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'shell' | 'watchdog' | 'antigravity' | 'grok'

const BG: Record<AgentId, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  gemini: 'var(--gemini)',
  opencode: 'var(--opencode)',
  cursor: 'var(--cursor)',
  shell: 'var(--shell)',
  watchdog: 'var(--ds-text-dim)',
  antigravity: 'var(--ds-text-dim)',
  grok: 'var(--ds-text-dim)',
}

const LETTER: Record<AgentId, string> = {
  claude: 'C',
  codex: 'X',
  gemini: 'G',
  opencode: 'O',
  cursor: 'K',
  shell: '$',
  watchdog: 'W',
  antigravity: 'A',
  grok: 'R',
}

// Which window.__ICONS__ key backs each agent id (letter fallback for the rest).
const ICON_KEY: Partial<Record<string, keyof IconConfig>> = {
  claude: 'claude', codex: 'codex', gemini: 'gemini', opencode: 'opencode',
  cursor: 'cursor', shell: 'shell', agents: 'agents', antigravity: 'antigravity', grok: 'grok',
}

/** Resolve a real brand logo URI for an agent id, honoring the active theme. '' if none. */
function resolveIcon(id: string): string {
  try {
    const icons = getIcons()
    if (!icons) return ''
    const key = ICON_KEY[id]
    if (!key) return ''
    const isLight = typeof document !== 'undefined' && !!document.querySelector('.swarmify-root.theme-light')
    return getIcon(icons[key] as string | { dark: string; light: string }, isLight)
  } catch {
    return ''
  }
}

export function AgentAvatar({ id, size = 18, title }: {
  id: AgentId | string
  size?: 14 | 16 | 18 | 20 | 24 | 28
  title?: string
}) {
  const normalized = id.toLowerCase()
  const src = resolveIcon(normalized)
  const [failed, setFailed] = useState(false)
  const showImg = !!src && !failed
  const bg = showImg ? 'var(--ds-bg-sunken, var(--sunken, transparent))' : (BG[normalized as AgentId] ?? 'var(--ds-text-dim)')
  const letter = LETTER[normalized as AgentId] ?? id.slice(0, 1).toUpperCase()
  return (
    <span
      className={`sw-avatar sz-${size}`}
      style={{ background: bg }}
      title={title ?? id}
    >
      {showImg
        ? <img src={src} alt={id} className="sw-avatar-img" onError={() => setFailed(true)} />
        : letter}
    </span>
  )
}

export function agentIdFromPrefix(prefix: string | null | undefined): AgentId | null {
  switch (prefix) {
    case 'CC': return 'claude'
    case 'CX': return 'codex'
    case 'GX': return 'gemini'
    case 'OC': return 'opencode'
    case 'CR': return 'cursor'
    case 'SH': return 'shell'
    case 'AG': return 'antigravity'
    case 'GK': return 'grok'
    default: return null
  }
}

export function agentShortChunk(sessionId: string | null | undefined): string {
  if (!sessionId) return ''
  return sessionId.replace(/-/g, '').slice(0, 8)
}
