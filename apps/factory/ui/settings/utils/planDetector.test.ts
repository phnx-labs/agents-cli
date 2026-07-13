import { describe, expect, test } from 'bun:test'
import { detectPlanFiles, extractPlanCandidates } from './planDetector'

describe('planDetector', () => {
  test('extracts html and ref markdown plan paths from agent output', () => {
    const candidates = extractPlanCandidates('Rendered /tmp/ref-plan.html and wrote ./ref-cycle-18.md.')
    expect(candidates.map((c) => c.value)).toEqual(['/tmp/ref-plan.html', './ref-cycle-18.md'])
  })

  test('resolves relative plan refs against the worktree path', () => {
    const plans = detectPlanFiles(
      [
        { value: 'ref-plan.md', source: 'output' },
        { value: 'artifacts/plan.html', source: 'worktree' },
      ],
      '/repo/.agents/worktrees/rush-1525',
    )
    expect(plans).toEqual([
      { path: '/repo/.agents/worktrees/rush-1525/ref-plan.md', label: 'ref-plan.md', kind: 'markdown', source: 'output' },
      { path: '/repo/.agents/worktrees/rush-1525/artifacts/plan.html', label: 'plan.html', kind: 'html', source: 'worktree' },
    ])
  })

  test('dedupes the same plan when it appears in output and files', () => {
    const plans = detectPlanFiles(
      [
        { value: '/repo/ref-plan.md', source: 'output' },
        { value: '/repo/ref-plan.md', source: 'worktree' },
      ],
      '/repo',
    )
    expect(plans).toHaveLength(1)
    expect(plans[0].source).toBe('output')
  })

  test('ignores ordinary markdown files', () => {
    const plans = detectPlanFiles(
      [
        { value: 'README.md', source: 'output' },
        { value: 'notes.md', source: 'worktree' },
      ],
      '/repo',
    )
    expect(plans).toEqual([])
  })
})

