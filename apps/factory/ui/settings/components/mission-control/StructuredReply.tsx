import React, { useState } from 'react'
import { Icon } from './icons'
import type { FloorPhase, StructuredQuestion } from './floorModel'

// Option-button reply block. Prototype structuredReply(): factory-floor.html:591-597.
// Used inline in feed items and in the right-pane decision block (rendered by SHELL).
// Structured replies, never a bare free-text box: option chips for choices,
// Confirm/Cancel (destructive styled red), Retry for failed, plus a free-text escape
// hatch and a Screenshot attach.

/** Reply callbacks raised by any structured-reply surface (feed item, cluster, detail). */
export interface ReplyCallbacks {
  /** An option chip (or Retry / View error) was clicked; carries the button label. */
  onOption: (option: string) => void
  /** The free-text escape hatch was submitted. */
  onFreeText: (text: string) => void
  /** The Screenshot attach button was clicked. */
  onAttach: () => void
}

interface StructuredReplyProps extends ReplyCallbacks {
  question: StructuredQuestion | null
  phase: FloorPhase
  /** Inline delivery error (no reachable channel, or the CLI send failed). Shown red. */
  error?: string
}

export function StructuredReply({ question, phase, onOption, onFreeText, onAttach, error }: StructuredReplyProps) {
  const [text, setText] = useState('')
  const danger = question?.kind === 'destructive'
  const options = question?.options ?? []
  const failed = phase === 'failed'

  const send = () => {
    const t = text.trim()
    if (!t) return
    onFreeText(t)
    setText('')
  }

  return (
    <>
      <div className="opts">
        {options.map((o, i) => (
          <button
            key={o}
            className={`opt ${i === 0 ? (danger ? 'danger' : 'primary') : 'ghost'}`}
            onClick={() => onOption(o)}
          >
            {o}
          </button>
        ))}
        {failed && (
          <>
            <button className="opt primary" onClick={() => onOption('Retry')}>Retry</button>
            <button className="opt ghost" onClick={() => onOption('View error')}>View error</button>
          </>
        )}
        {/* Screenshot attach hidden until a transport exists (was a no-op stub). */}
      </div>
      <div className="reply2">
        <input
          placeholder="…or reply in your own words"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send() }}
        />
        <button className="opt ghost" onClick={send}>Send</button>
      </div>
      {error && <div className="reply-err" role="alert">{error}</div>}
    </>
  )
}
