// The unified "what should the agent do?" box. Ports the prototype's whatHtml() +
// suggestionsHtml() + the input wiring in render() (dispatch.html):
//   attached ticket chips + attachment chips + always-present context textarea,
//   paste/drop attachment tray, @-mention affordance, Auto-pick urgent, and the
//   live-filtered ranked ticket suggestions.
// Real backlog is UnifiedTask; we adapt each to the prototype's ticket view-model.
import React from 'react'
import { useRef } from 'react'
import { Icon } from './icons'
import { ImageIcon, FileIcon } from './dispatchIcons'
import type { UnifiedTask } from '../../types'
import type { DispatchAttachment } from './dispatch.types'

export interface DispatchInputProps {
  prompt: string
  onPromptChange: (value: string) => void
  attached: string[]                              // ticket keys
  tasks: UnifiedTask[]                             // backlog for chips + suggestions
  onAddTicket: (key: string) => void
  onRemoveTicket: (key: string) => void
  attachments: DispatchAttachment[]
  onAddAttachment: (att: DispatchAttachment) => void
  onRemoveAttachment: (index: number) => void
  onSubmit: () => void
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
  /** Draft the prompt from the attached tickets via a headless agent. */
  onDraftPrompt?: () => void
  /** True while a draft is in flight (button shows a spinner + disables). */
  drafting?: boolean
  /** Inline error from the last draft attempt (shown red under the box). */
  draftError?: string
}

interface TicketVM {
  key: string
  src: 'LN' | 'GH'
  displayId: string
  title: string
  pri: 'urgent' | 'high' | 'med' | 'low'
  bug: boolean
}

const PRI_RANK: Record<TicketVM['pri'], number> = { urgent: 0, high: 1, med: 2, low: 3 }

/** Stable identity for a task: prefer the human identifier (RUSH-1302 / #412). */
export function ticketKey(t: UnifiedTask): string {
  return t.metadata.identifier ?? t.id
}

function adapt(t: UnifiedTask): TicketVM {
  const pri: TicketVM['pri'] =
    t.priority === 'urgent' ? 'urgent'
      : t.priority === 'high' ? 'high'
        : t.priority === 'low' ? 'low'
          : 'med'
  const bug = (t.metadata.labels ?? []).some(l => /bug/i.test(l))
  return {
    key: ticketKey(t),
    src: t.source === 'linear' ? 'LN' : 'GH',
    displayId: t.metadata.identifier ?? t.id,
    title: t.title,
    pri,
    bug,
  }
}

/** urgent-bugs first (lower score = higher priority). */
const score = (t: TicketVM) => PRI_RANK[t.pri] * 2 + (t.bug ? 0 : 1)

export function DispatchInput(props: DispatchInputProps) {
  const {
    prompt, onPromptChange, attached, tasks, onAddTicket, onRemoveTicket,
    attachments, onAddAttachment, onRemoveAttachment, onSubmit, inputRef,
    onDraftPrompt, drafting = false, draftError,
  } = props
  const canDraft = !!onDraftPrompt && attached.length > 0
  const boxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const vms = tasks.map(adapt)
  const chipTickets = attached
    .map(k => vms.find(v => v.key === k))
    .filter((v): v is TicketVM => Boolean(v))

  const q = prompt.trim().toLowerCase()
  const suggestions = vms
    .filter(t => !attached.includes(t.key) && (!q || `${t.displayId} ${t.title}`.toLowerCase().includes(q)))
    .sort((a, b) => score(a) - score(b))
    .slice(0, 3)

  const autoPick = () => {
    const t = vms.filter(v => !attached.includes(v.key)).sort((a, b) => score(a) - score(b))[0]
    if (t) onAddTicket(t.key)
  }

  const addFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      onAddAttachment({ type: f.type.startsWith('image') ? 'image' : 'file', name: f.name })
    }
  }

  const pasteScreenshot = async () => {
    // Real clipboard read — no fabricated attachment. Silently no-ops if the
    // webview denies clipboard access (no toasts).
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imgType = item.types.find(t => t.startsWith('image'))
        if (imgType) {
          const ext = imgType.split('/')[1] || 'png'
          onAddAttachment({ type: 'image', name: `pasted-screenshot.${ext}` })
        }
      }
    } catch { /* clipboard unavailable — ignore */ }
  }

  return (
    <>
      <div
        ref={boxRef}
        className="whatbox"
        onDragOver={e => { e.preventDefault(); boxRef.current?.classList.add('drag') }}
        onDragLeave={() => boxRef.current?.classList.remove('drag')}
        onDrop={e => {
          e.preventDefault()
          boxRef.current?.classList.remove('drag')
          if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
        }}
        onPaste={e => {
          const img = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image'))
          if (img) {
            e.preventDefault()
            const file = img.getAsFile()
            onAddAttachment({ type: 'image', name: file?.name || 'pasted-screenshot.png' })
          }
        }}
      >
        <div className="chips">
          {chipTickets.map(t => (
            <span key={t.key} className="tchip">
              <span className={`src ${t.src}`}>{t.src}</span>
              <span className="tid">{t.displayId}</span>
              <span className="tt">{t.title}</span>
              <span className="rm" onClick={() => onRemoveTicket(t.key)}><Icon name="x" size={11} /></span>
            </span>
          ))}
          {attachments.map((a, i) => (
            <span key={i} className="achip">
              <span className="thumb">{a.type === 'image' ? <ImageIcon size={14} /> : <FileIcon size={14} />}</span>
              <span className="nm">{a.name}</span>
              <span className="rm" onClick={() => onRemoveAttachment(i)}><Icon name="x" size={11} /></span>
            </span>
          ))}
        </div>
        <textarea
          ref={inputRef}
          className="ctxa"
          value={prompt}
          placeholder="What should the agent do?  Paste a screenshot, drop files, or @mention code for context."
          onChange={e => onPromptChange(e.target.value)}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSubmit() }
          }}
        />
        <div className="boxbar">
          {onDraftPrompt && (
            <span
              className={`ib draft${drafting ? ' busy' : ''}${canDraft ? '' : ' dis'}`}
              title={canDraft ? 'Let an agent write the prompt from the attached tickets' : 'Attach a ticket first'}
              onClick={() => { if (canDraft && !drafting) onDraftPrompt() }}
            >
              <Icon name="sparkles" size={13} className={drafting ? 'spin' : undefined} />
              {drafting ? 'Drafting…' : 'Draft prompt'}
            </span>
          )}
          <span className="ib" onClick={() => fileRef.current?.click()}><Icon name="paperclip" size={13} /> Attach</span>
          <span className="ib" onClick={pasteScreenshot}><ImageIcon size={13} /> Paste screenshot</span>
          <span className="ib">@ Mention code</span>
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
          />
        </div>
      </div>
      {draftError && <div className="reply-err" role="alert">{draftError}</div>}
      <div className="wactions">
        <span className="gbtn accent" onClick={autoPick}><Icon name="zap" size={13} /> Auto-pick urgent</span>
        <span className="sub2" style={{ alignSelf: 'center' }}>or attach from suggestions</span>
      </div>
      <div className="suggest">
        {suggestions.map(t => (
          <div key={t.key} className="sug" onClick={() => onAddTicket(t.key)}>
            <span className={`pri ${t.pri}`} />
            <span className={`src ${t.src}`}>{t.src}</span>
            <span className="tid">{t.displayId}</span>
            <span className="tt">{t.title}</span>
            {t.bug ? <span className="tag">bug</span> : null}
            <span className="pl">+</span>
          </div>
        ))}
      </div>
    </>
  )
}
