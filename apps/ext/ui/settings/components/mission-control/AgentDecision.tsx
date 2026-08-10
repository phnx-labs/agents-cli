import React from 'react'
import { Icon } from './icons'
import { StructuredReply } from './StructuredReply'
import type { FloorAgent } from './floorModel'

// The "needs you" decision block at the top of the right detail pane. Surfaces the
// three things a NEEDS-YOU card used to omit (RUSH-1521): WHY it's blocked (the reason
// chip), the ORIGINAL task for context, and the BLOCKER itself (the question + option
// chips + reply box). Extracted from UnifiedAgentsPane so the same markup renders in the
// preview harness — one source, no drift.

/** Header label + optional "why" chip derived from the agent's phase + awaiting reason. */
export function decisionReason(a: FloorAgent): { label: string; chip: { text: string; cls: string } | null } {
  const label =
    a.phase === 'failed' ? 'FAILED — NEEDS YOU'
    : a.phase === 'stalled' ? 'STALLED — NEEDS YOU'
    : a.question?.reason === 'permission' ? 'PERMISSION — NEEDS YOU'
    : a.question?.reason === 'plan_review' ? 'PLAN REVIEW — NEEDS YOU'
    : 'WAITING ON YOU'
  const chip =
    a.question?.reason === 'permission' ? { text: 'permission', cls: 'why perm' }
    : a.question?.reason === 'plan_review' ? { text: 'plan review', cls: 'why' }
    : a.question?.reason === 'question' ? { text: 'question', cls: 'why' }
    : null
  return { label, chip }
}

export interface AgentDecisionProps {
  agent: FloorAgent
  error?: string
  onOption: (option: string) => void
  onFreeText: (text: string) => void
  onAttach: () => void
  onNudge: () => void
}

export function AgentDecision({ agent: a, error, onOption, onFreeText, onAttach, onNudge }: AgentDecisionProps) {
  const { label, chip } = decisionReason(a)
  const origTask = a.prompt?.trim()
  // Show the task anchor only when it isn't just a restatement of the question shown below.
  const showTask = !!origTask && origTask !== (a.question?.text ?? a.resp)?.trim()
  return (
    <div style={{ padding: '14px 16px 0' }}>
      <div className={`decide${a.phase === 'stalled' ? ' stall' : ''}`}>
        <div className="ql">
          {label}
          {chip && <span className={chip.cls}>{chip.text}</span>}
        </div>
        {showTask && (
          <div className="qtask" title={origTask}>
            <b>Task ·</b> {origTask!.length > 110 ? origTask!.slice(0, 107) + '…' : origTask}
          </div>
        )}
        {/* With a structured question, StructuredReply renders the text above its options —
            so only show .qt (the last turn) when there's no such question, avoiding a
            duplicated question line. */}
        {!a.question && <div className="qt">{a.resp}</div>}
        {a.phase === 'stalled' && (
          <div className="opts">
            <button className="opt primary" onClick={onNudge}>
              <Icon name="refresh" size={12} /> Nudge
            </button>
          </div>
        )}
        <StructuredReply
          question={a.question}
          phase={a.phase}
          error={error}
          onOption={onOption}
          onFreeText={onFreeText}
          onAttach={onAttach}
        />
      </div>
    </div>
  )
}
