import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()

import { describe, expect, test } from 'bun:test'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FloorAgent } from './floorModel'

const { SessionRow, SessionsPane } = await import('./SessionsPane')

const noop = () => {}

function agent(over: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'r1',
    host: 'yosemite-s1',
    hostLabel: 'yosemite-s1',
    project: 'svatlas',
    name: 'session',
    abbr: 'CC',
    phase: 'running',
    verb: '',
    target: '',
    tok: 0,
    since: '2d',
    lastActivityMs: Date.parse('2026-08-23T12:00:00Z'),
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: '#418',
    prUrl: 'https://github.com/x/y/pull/418',
    ci: 'running',
    ticket: null,
    branch: '',
    worktreeSlug: '',
    worktreePath: '',
    resp: 'Widened the hero to a 2-col grid and pushed the CTA down. Screenshot attached — does the spacing read better now?',
    prompt: '/Users/muqsit/Screenshots/CleanShot 2026-08-23 at 12.03.45.png The landscape mode looks cramped — can we give the hero more room?',
    topic: 'Redesigning the SVAtlas landscape hero section',
    messages: [],
    question: null,
    reply: { kind: 'none', host: 'yosemite-s1' },
    todos: [],
    summary: '',
    recent: [],
    liveStatus: 'orphaned',
    ...over,
  }
}

const rowProps = {
  selected: false,
  active: false,
  expanded: false,
  height: 108,
  onToggleSelect: noop,
  onToggleStar: noop,
  onResume: noop,
  onSelect: noop,
  onToggleExpand: noop,
}

describe('SessionRow — mockup contract', () => {
  test('renders title, provenance, You ›, Claude ›, chips, Resume', () => {
    const html = renderToStaticMarkup(<SessionRow agent={agent()} {...rowProps} />)
    expect(html).toContain('Redesigning the SVAtlas landscape hero section')
    expect(html).toContain('agent recap')
    expect(html).toContain('You ›')
    expect(html).toContain('Claude ›')
    expect(html).toContain('screenshot')
    expect(html).not.toContain('/Users/muqsit')
    expect(html).not.toContain('CleanShot')
    expect(html).toContain('PR #418')
    expect(html).toContain('▪ svatlas')
    expect(html).toContain('yosemite-s1')
    expect(html).toContain('↻ Resume')
    expect(html).toContain('⌄ more')
    expect(html).toContain('sx-roletag you')
    expect(html).toContain('sx-roletag agent')
  })

  test('skill prompt renders /continue chip without the skill path', () => {
    const html = renderToStaticMarkup(
      <SessionRow
        agent={{
          ...agent({
            prompt: 'Base directory for this skill: /home/muqsit/.agents/skills/continue\npick up the agents view cache work',
            topic: 'Continuing the usage-cache fix from a prior session',
            resp: 'Rebased onto main, re-ran the failing test — green. Opening the PR now.',
            pr: '#2922',
            ci: 'passed',
            branch: 'fix-usage-cache',
            project: 'agents-cli',
          }),
          recapSource: 'renamed',
        } as FloorAgent}
        {...rowProps}
      />,
    )
    expect(html).toContain('/continue')
    expect(html).toContain('pick up the agents view cache work')
    expect(html).not.toContain('Base directory')
    expect(html).not.toContain('/home/muqsit')
    expect(html).toContain('fix-usage-cache')
    expect(html).toContain('renamed')
  })

  test('command prompt renders $ chip', () => {
    const html = renderToStaticMarkup(
      <SessionRow
        agent={agent({
          prompt: '<bash-input>crabbox status</bash-input>\nHelping understand the currency I set up for the agency — does it use Crabbox?',
          topic: 'Explaining the Crabbox CI currency model',
          resp: 'Yes — every run mints a per-repo credit against the microVM pool.',
          pr: null,
          project: 'agents-cli',
        })}
        {...rowProps}
      />,
    )
    expect(html).toContain('$ crabbox status')
    expect(html).toContain('Helping understand the currency')
    expect(html).toContain('no PR')
    expect(html).not.toContain('<bash-input>')
  })

  test('expanded row reveals the full last message', () => {
    const full = 'Yes — every CI run mints a per-repo credit against the shared microVM pool, admitted under a CPU/memory fairness gate.'
    const html = renderToStaticMarkup(
      <SessionRow
        agent={agent({ resp: full })}
        {...rowProps}
        expanded
      />,
    )
    expect(html).toContain(full)
    expect(html).toContain('⌃ less')
    expect(html).toContain('sx-full')
  })

  test('per-row Resume posts the same onResume the group control uses', () => {
    const seen: string[] = []
    const html = document.createElement('div')
    document.body.appendChild(html)
    const root = createRoot(html)
    act(() => {
      root.render(
        <SessionRow
          agent={agent({ id: 'resume-me' })}
          {...rowProps}
          onResume={(a) => { seen.push(a.id) }}
        />,
      )
    })
    const btn = html.querySelector('.sx-resumebtn') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('Resume')
    act(() => { btn.click() })
    expect(seen).toEqual(['resume-me'])
    act(() => root.unmount())
    html.remove()
  })
})

describe('SessionsPane bulk Resume all', () => {
  test('filter chips keep sx-chip; meta chips live under sx-metarow', () => {
    const html = renderToStaticMarkup(
      <SessionsPane
        agents={[agent({ id: 'a', liveStatus: 'orphaned' })]}
        onToggleStar={noop}
        onResume={noop}
        onResumeMany={noop}
        onSelect={noop}
      />,
    )
    expect(html).toContain('class="sx-chip on')
    expect(html).toContain('sx-metarow')
    expect(html).toContain('.sx-metarow .sx-chip')
    expect(html).toContain('sx-chip repo')
  })

  test('reconnect group exposes Resume all N', () => {
    const html = renderToStaticMarkup(
      <SessionsPane
        agents={[agent({ id: 'a', liveStatus: 'orphaned' }), agent({ id: 'b', liveStatus: 'orphaned', topic: 'other' })]}
        onToggleStar={noop}
        onResume={noop}
        onResumeMany={noop}
        onSelect={noop}
      />,
    )
    expect(html).toContain('Resume all 2')
    expect(html).toContain('You ›')
  })
})
