import { describe, test, expect } from 'bun:test'
import { decisionReason } from './AgentDecision'
import type { FloorAgent, StructuredQuestion } from './floorModel'

function agent(p: Partial<FloorAgent>): FloorAgent {
  return {
    id: 'x', host: 'this-mac', project: 'p', name: 'n', abbr: 'CC', phase: 'waiting',
    verb: '', target: '', tok: 0, since: '', lastActivityMs: 0, files: 0, tools: 0,
    needs: true, pinned: false, pr: null, ci: null, ticket: null, branch: '',
    worktreeSlug: '', worktreePath: '', resp: '', messages: [], question: null,
    reply: { kind: 'terminal', host: 'this-mac' }, todos: [], summary: '', recent: [],
    ...p,
  }
}
const q = (reason: StructuredQuestion['reason']): StructuredQuestion => ({ kind: 'choice', text: 't', options: ['a'], clusterKey: 'k', reason })

describe('decisionReason — why-blocked label + chip', () => {
  test('permission reads red and labels PERMISSION', () => {
    const r = decisionReason(agent({ question: q('permission') }))
    expect(r.label).toBe('PERMISSION — NEEDS YOU')
    expect(r.chip).toEqual({ text: 'permission', cls: 'why perm' })
  })
  test('plan review labels PLAN REVIEW', () => {
    const r = decisionReason(agent({ question: q('plan_review') }))
    expect(r.label).toBe('PLAN REVIEW — NEEDS YOU')
    expect(r.chip?.text).toBe('plan review')
  })
  test('a question is the generic waiting label with a question chip', () => {
    const r = decisionReason(agent({ question: q('question') }))
    expect(r.label).toBe('WAITING ON YOU')
    expect(r.chip?.text).toBe('question')
  })
  test('failed / stalled phases keep their own labels and no chip', () => {
    expect(decisionReason(agent({ phase: 'failed', question: null })).label).toBe('FAILED — NEEDS YOU')
    expect(decisionReason(agent({ phase: 'stalled', question: null })).chip).toBeNull()
  })
  test('no question ⇒ plain waiting label, no chip', () => {
    const r = decisionReason(agent({ question: null }))
    expect(r.label).toBe('WAITING ON YOU')
    expect(r.chip).toBeNull()
  })
})
