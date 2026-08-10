// Plan-review surface — when a Plan-mode agent emits a plan, approve / edit / send back
// before it runs. Rendered in the Floor right pane / needs-you, styled as a decision block
// (matches the prototype's .decide look: factory-floor.html:164-166).
import React, { useState } from 'react'
import type { PendingPlan, PlanStep } from './dispatch.types'

export interface PlanReviewProps {
  plan: PendingPlan
  onApprove: (edited?: PlanStep[]) => void
  onSendBack: (note: string) => void
}

type Mode = 'view' | 'edit' | 'sendback'

export function PlanReview({ plan, onApprove, onSendBack }: PlanReviewProps) {
  const [mode, setMode] = useState<Mode>('view')
  const [steps, setSteps] = useState<PlanStep[]>(plan.steps)
  const [note, setNote] = useState('')

  const editStep = (n: number, text: string) =>
    setSteps((prev) => prev.map((s) => (s.n === n ? { ...s, text } : s)))

  const approve = () => onApprove(mode === 'edit' ? steps : undefined)
  const sendBack = () => {
    const t = note.trim()
    if (!t) return
    onSendBack(t)
  }

  return (
    <div className="decide plan">
      <div className="ql">PLAN — REVIEW BEFORE IT RUNS</div>
      <ol className="plan-steps">
        {steps.map((s) => (
          <li key={s.n} className="plan-step">
            {mode === 'edit' ? (
              <input
                className="plan-edit"
                value={s.text}
                onChange={(e) => editStep(s.n, e.target.value)}
              />
            ) : (
              <span>{s.text}</span>
            )}
          </li>
        ))}
      </ol>

      {mode === 'sendback' ? (
        <div className="reply2">
          <input
            autoFocus
            placeholder="What should change before it proceeds?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendBack()
            }}
          />
          <button className="opt primary" onClick={sendBack} disabled={!note.trim()}>
            Send back
          </button>
          <button className="opt ghost" onClick={() => setMode('view')}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="opts">
          <button className="opt primary" onClick={approve}>
            {mode === 'edit' ? 'Approve edits' : 'Approve'}
          </button>
          {mode === 'edit' ? (
            <button
              className="opt ghost"
              onClick={() => {
                setSteps(plan.steps)
                setMode('view')
              }}
            >
              Discard edits
            </button>
          ) : (
            <button className="opt ghost" onClick={() => setMode('edit')}>
              Approve + edit
            </button>
          )}
          <button className="opt ghost" onClick={() => setMode('sendback')}>
            Send back
          </button>
        </div>
      )}
    </div>
  )
}
