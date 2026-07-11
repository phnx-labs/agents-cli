import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloorRail, railActive, railProjectRows, type RailScopeState } from './FloorRail'
import type { FloorAgent, FloorTicket, ManagedProject } from './floorModel'

// Pure, DOM-free tests via renderToStaticMarkup — same convention as
// FloorSubtabs.test.tsx: no happy-dom register, nothing leaks into siblings.

function makeAgent(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'this-mac',
    project: 'swarmify',
    name: 'auth-refactor',
    abbr: 'CC',
    phase: 'running',
    verb: 'Editing',
    target: 'src/core/tasks.ts',
    tok: 0,
    since: '2s',
    lastActivityMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: null,
    prUrl: null,
    ci: null,
    ticket: null,
    branch: 'feat-auth',
    worktreeSlug: '',
    worktreePath: '',
    resp: '',
    messages: [],
    question: null,
    reply: { kind: 'terminal', host: 'this-mac', terminalId: 'CC-1' },
    todos: [],
    summary: '',
    recent: [],
    ...overrides,
  }
}

function makeProject(overrides: Partial<ManagedProject> = {}): ManagedProject {
  return {
    id: 'p1',
    name: 'swarmify',
    path: '/repos/swarmify',
    confidence: 'high',
    source: 'detected',
    ...overrides,
  }
}

const tickets: FloorTicket[] = []

const base: RailScopeState = { center: 'agents', projFilter: null, hostFilter: null, needsOnly: false }

describe('railActive', () => {
  test('all is on only with no narrowing on the agents center', () => {
    expect(railActive('all', base)).toBe(true)
    expect(railActive('all', { ...base, needsOnly: true })).toBe(false)
    expect(railActive('all', { ...base, projFilter: 'swarmify' })).toBe(false)
    expect(railActive('all', { ...base, hostFilter: 'zion' })).toBe(false)
    expect(railActive('all', { ...base, center: 'backlog' })).toBe(false)
  })

  test('needs follows the needs chip', () => {
    expect(railActive('needs', base)).toBe(false)
    expect(railActive('needs', { ...base, needsOnly: true })).toBe(true)
  })

  test('queue follows the backlog center regardless of agent filters', () => {
    expect(railActive('queue', { ...base, center: 'backlog', projFilter: 'swarmify' })).toBe(true)
    expect(railActive('queue', base)).toBe(false)
  })

  test('recap follows the recap center', () => {
    expect(railActive('recap', { ...base, center: 'recap' })).toBe(true)
    expect(railActive('recap', base)).toBe(false)
    // A lingering project filter cannot double-light while the recap center shows.
    expect(railActive('projects', { ...base, center: 'recap', projFilter: 'swarmify' })).toBe(false)
  })

  test('projects/hosts light while their filter narrows the agents center', () => {
    expect(railActive('projects', { ...base, projFilter: 'swarmify' })).toBe(true)
    expect(railActive('hosts', { ...base, hostFilter: 'zion' })).toBe(true)
    // Other centers (host detail, projects manage) do not claim the scope buttons.
    expect(railActive('projects', { ...base, center: 'projects', projFilter: 'swarmify' })).toBe(false)
  })

  test('at most one button lights for any combined state (prix-cloud repro)', () => {
    // needs chip lingering alongside a project or host scope: the scope wins.
    const keys = ['all', 'needs', 'queue', 'recap', 'projects', 'hosts'] as const
    const states: RailScopeState[] = [
      { ...base, needsOnly: true, projFilter: 'swarmify' },
      { ...base, needsOnly: true, hostFilter: 'zion' },
      { ...base, needsOnly: true, projFilter: 'swarmify', center: 'backlog' },
      { ...base, needsOnly: true, projFilter: 'swarmify', center: 'recap' },
      { ...base, needsOnly: true },
      base,
    ]
    for (const s of states) {
      const lit = keys.filter((k) => railActive(k, s))
      expect(lit.length).toBeLessThanOrEqual(1)
    }
    expect(railActive('projects', { ...base, needsOnly: true, projFilter: 'swarmify' })).toBe(true)
    expect(railActive('needs', { ...base, needsOnly: true, projFilter: 'swarmify' })).toBe(false)
    expect(railActive('needs', { ...base, needsOnly: true, hostFilter: 'zion' })).toBe(false)
  })
})

describe('railProjectRows', () => {
  test('managed projects lead, discovered-but-unmanaged follow busiest-first', () => {
    const agents = [
      makeAgent({ id: '1', project: 'swarmify' }),
      makeAgent({ id: '2', project: 'rogue', needs: true }),
      makeAgent({ id: '3', project: 'rogue' }),
      makeAgent({ id: '4', project: 'drifter' }),
    ]
    const rows = railProjectRows(agents, [makeProject({ id: 'p1', name: 'swarmify' })])
    expect(rows.map((r) => r.name)).toEqual(['swarmify', 'rogue', 'drifter'])
    expect(rows[0]).toMatchObject({ managed: true, run: 1, wait: 0 })
    expect(rows[1]).toMatchObject({ managed: false, run: 2, wait: 1 })
  })

  test('managed project with zero agents still gets a row', () => {
    const rows = railProjectRows([], [makeProject({ name: 'idle-proj' })])
    expect(rows).toEqual([{ key: 'p1', name: 'idle-proj', run: 0, wait: 0, managed: true }])
  })
})

describe('FloorRail render', () => {
  const agents = [makeAgent({ id: '1' }), makeAgent({ id: '2', needs: true })]
  const props = {
    agents,
    tickets,
    center: 'agents' as const,
    projFilter: null,
    hostFilter: null,
    needsOnly: false,
    projects: [makeProject()],
    devices: [
      { name: 'zion', online: true, agents: 2 },
      { name: 'yosemite-s1', online: false, agents: 0 },
    ],
    offlineHosts: ['yosemite-s1'],
    hostPins: ['zion'],
    localHost: 'zion',
    onScope: () => {},
    onDispatch: () => {},
    onManageProjects: () => {},
    onExpand: () => {},
  }

  test('renders dispatch, three scopes, two flyout anchors, one expand — no dupes', () => {
    const html = renderToStaticMarkup(<FloorRail {...props} />)
    expect(html).toContain('rail-dispatch')
    for (const label of ['All agents', 'Needs you', 'Backlog', 'Recap', 'Projects', 'Hosts', 'Expand sidebar']) {
      expect(html.split(`aria-label="${label}"`).length - 1).toBe(1)
    }
  })

  test('flyouts are closed by default and hosts button carries the offline dot', () => {
    const html = renderToStaticMarkup(<FloorRail {...props} />)
    expect(html).not.toContain('rail-fly"')
    expect(html).toContain('rail-off')
  })

  test('no offline dot when the fleet is healthy', () => {
    const html = renderToStaticMarkup(
      <FloorRail {...props} devices={[{ name: 'zion', online: true, agents: 2 }]} offlineHosts={[]} />,
    )
    expect(html).not.toContain('rail-off')
  })

  test('active scope lights exactly one button', () => {
    const html = renderToStaticMarkup(<FloorRail {...props} needsOnly={true} />)
    expect(html.split('rail-ib on').length - 1).toBe(1)
    const needsBtn = html.slice(html.indexOf('aria-label="Needs you"') - 120, html.indexOf('aria-label="Needs you"'))
    expect(needsBtn).toContain('rail-ib on')
  })

  test('needs badge is amber and counts needy agents', () => {
    const html = renderToStaticMarkup(<FloorRail {...props} />)
    expect(html).toContain('rail-bdg attn')
  })
})
