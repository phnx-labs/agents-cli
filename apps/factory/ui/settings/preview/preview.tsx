// Standalone visual preview of the current Factory Floor feed + Dispatch panel.
// Renders the SAME components the webview uses, with representative data, so the
// current UI can be seen/screenshotted without the VS Code extension host. Not
// shipped (vite.settings.config.ts only inputs settings/index.html); a dev harness.
//
// Run:  cd extension/ui && bun run dev  ->  open http://localhost:5173/settings/preview/
//   URL params:  ?view=feed|dispatch  &  ?theme=dark|light
// (Serve over http, not file://, or ES-module imports are CORS-blocked.)
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../index.css'

import { Icon } from '../components/mission-control/icons'
import { FloorSidebar } from '../components/mission-control/FloorSidebar'
import { FeedItem, TicketStrip } from '../components/mission-control/FeedItem'
import { SavedViews } from '../components/mission-control/SavedViewsBar'
import { DispatchPanel } from '../components/mission-control/DispatchPanel'
import { BacklogCenter } from '../components/mission-control/BacklogCenter'
import { ProjectsPane } from '../components/mission-control/ProjectsPane'
import type { FloorAgent, FloorTicket, StructuredQuestion, TicketGroupBy, TicketSort, ManagedProject, LinearProjectLite } from '../components/mission-control/floorModel'
import type { UnifiedTask } from '../types'
import type { InstalledAgent, DispatchHost, DispatchTarget } from '../components/mission-control/dispatch.types'

const noop = () => {}

function agent(p: Partial<FloorAgent>): FloorAgent {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    host: 'this-mac',
    hostLabel: 'zion',
    project: 'rush',
    name: 'agent',
    abbr: 'CC',
    phase: 'running',
    verb: '',
    target: '',
    tok: 0,
    since: '2s',
    lastActivityMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: null,
    ci: null,
    ticket: null,
    branch: 'main',
    worktreeSlug: '',
    worktreePath: '',
    resp: '',
    question: null,
    reply: { kind: 'terminal', host: 'this-mac' },
    todos: [],
    summary: '',
    recent: [],
    ...p,
  }
}

// Issue-2 demo: two sessions in the SAME repo + worktree that used to render as
// identical, contextless "Edit linux.ts / waiting_input" cards. They now carry the
// project, the worktree slug, and a distinct task line.
const twinA = agent({
  id: 'twin-a', abbr: 'CC', name: '02ebf318', project: 'agents-cli', phase: 'waiting',
  needs: true, worktreeSlug: 'headless-secrets-shadow', branch: 'muqsit/headless-secrets',
  verb: 'Edit', target: 'src/lib/secrets/linux.ts',
  summary: 'Removing the stale BYOK resolver and its keychain writes.', since: '0s',
})
const twinB = agent({
  id: 'twin-b', abbr: 'CC', name: 'e3d6852d', project: 'agents-cli', phase: 'waiting',
  needs: true, worktreeSlug: 'headless-secrets-shadow', branch: 'muqsit/headless-secrets',
  verb: 'Edit', target: 'src/lib/secrets/linux.ts',
  summary: 'Adding the Linux secret-service fallback path + a regression test.', since: '0s',
})

const dropQuestion: StructuredQuestion = {
  kind: 'destructive',
  text: 'Drop the legacy policy_v1 table, or keep it for rollback?',
  options: ['Drop it', 'Keep it'],
  clusterKey: 'drop-policy',
}

// NEEDS YOU — a CI-green PR awaiting review, and a destructive question.
const reviewAgent = agent({
  id: 'a-review', abbr: 'CC', name: 'fix-terminal-race', project: 'rush', phase: 'done',
  needs: true, pr: '#142', prUrl: 'https://github.com/phnx-labs/agents-cli/pull/142', ci: 'passed', ticket: 'RUSH-1302',
  resp: 'Refactored task fetch into one model and wired the saved-views flow. Tests added, all green.',
  since: '4m',
})
const askAgent = agent({
  id: 'a-ask', abbr: 'GX', name: 'supabase-rls-migration', project: 'rush', phase: 'waiting',
  needs: true, ci: 'running', pr: '#151',
  resp: 'Drop the legacy policy_v1 table, or keep it for rollback?',
  question: dropQuestion, since: '1m',
})

// RUNNING lane.
const running: FloorAgent[] = [
  agent({
    id: 'r1', abbr: 'CX', name: 'bench-saved-views', project: 'rush', phase: 'running',
    pr: '#148', ci: 'running', tok: 41, files: 9, since: '3s', lastActivityMs: Date.now() - 3000,
    pane: '%42', viewingIn: 'Codium tab 3',
    verb: 'Porting', target: 'the group-by control into the shared model',
    summary: 'Collapsed the three ticket surfaces into one list; now porting the group-by control into the shared model.',
    todos: [
      { content: 'Merge ticket surfaces', status: 'completed' },
      { content: 'Port group-by control', status: 'in_progress' },
      { content: 'Delete dead views', status: 'pending' },
    ],
  }),
  agent({
    id: 'r2', abbr: 'CC', name: 'heartbeat-lastactivity', project: 'agents-cli', phase: 'running',
    tok: 55, files: 4, since: '1s', lastActivityMs: Date.now() - 1000,
    pane: '%57', viewingIn: 'Ghostty tab 2',
    verb: 'Reading', target: 'the remote-session adapter',
    summary: 'Tracing where remote sessions lose their last-activity timestamp — found it in the adapter, drafting the fix.',
  }),
  agent({
    id: 'r3', abbr: 'GX', name: 'plan: dispatch-refactor', project: 'rush', phase: 'running',
    tok: 33, since: '8s', lastActivityMs: Date.now() - 8000,
    verb: 'Mapping', target: 'the two half-wired dispatch paths',
    summary: 'Mapping the two half-wired dispatch paths; will propose a single reply handler before touching code.',
  }),
]

// DONE TODAY.
const done: FloorAgent[] = [
  agent({
    id: 'd1', abbr: 'CC', name: 'foreman-orb-echo-fix', project: 'rush', phase: 'done',
    pr: '#128', ci: 'passed', since: '2h', resp: 'Merged. Mic-gating during TTS stopped the echo loop.',
  }),
]

// READY TO DISPATCH backlog.
const tickets: FloorTicket[] = [
  { id: 'RUSH-1262', title: '[security] rush CLI PKCE token exchange uses unpinned http client', project: 'rush', source: 'LN', pri: 'urgent', status: 'todo', desc: '', labels: ['security'], owner: 'Muqsit' },
  { id: 'RUSH-799', title: 'Remote agent heartbeat anchors to start time, shows false stall', project: 'agents-cli', source: 'LN', pri: 'high', status: 'todo', desc: '', labels: [], owner: 'Muqsit' },
  { id: '#418', title: 'Kanban / Deadline feed views are stubs -> "coming soon"', project: 'swarmify', source: 'GH', pri: 'med', status: 'todo', desc: '', labels: [], owner: '' },
  // A ticket with no formal project — grouping renders it under "Unlabeled", never a
  // blank "· N" header (issue 1).
  { id: 'RUSH-1240', title: '[rush/app] X/social integration renders a broken avatar (not CSP)', project: '', source: 'LN', pri: 'high', status: 'todo', desc: '', labels: ['Bug'], owner: 'Muqsit' },
]

// Dispatch panel mock data.
const tasks: UnifiedTask[] = tickets.map((t) => ({
  id: t.id,
  title: t.title,
  description: 'Ticket pulled into the factory from Linear.',
  status: 'todo',
  priority: t.pri === 'med' ? 'medium' : t.pri,
  source: t.source === 'LN' ? 'linear' : 'github',
  metadata: { identifier: t.id, repo: t.project, labels: t.labels },
})) as unknown as UnifiedTask[]

const dAgents: InstalledAgent[] = [
  { id: 'claude', name: 'Claude', color: '#d97757', signedIn: true, version: '2.1', isDefault: true },
  { id: 'codex', name: 'Codex', color: '#10a37f', signedIn: true, version: '0.9', isDefault: false },
  { id: 'gemini', name: 'Gemini', color: '#4285f4', signedIn: true, version: '1.0', isDefault: false },
]
const dHosts: DispatchHost[] = [
  { id: 'this-mac', label: 'this mac', kind: 'local', online: true, agents: 3, load: 'free', uses: 40 },
  { id: 'rush', label: 'cloud', kind: 'cloud', online: true, agents: 0, load: 'idle', uses: 12, costHint: '~$0.40/run' },
]
const dTargets: DispatchTarget[] = [
  { id: 'phnx-labs/agents-cli', label: 'agents-cli', path: '/Users/muqsit/src/github.com/phnx-labs/agents-cli', uses: 30, confidence: 'high', linearProject: 'Agents CLI' },
  { id: 'phnx-labs/prix', label: 'prix', path: '/Users/muqsit/src/github.com/phnx-labs/prix', uses: 12, confidence: 'high', linearProject: 'Prix' },
  { id: 'muqsitnawaz/rush', label: 'rush-app', path: '/Users/muqsit/Rush/app', uses: 6, confidence: 'medium' },
  { id: 'scratch-tool', label: 'scratch-tool', path: '/Users/muqsit/tmp/scratch-tool', uses: 0, confidence: 'low' },
]

// Managed-projects mock (5 → the sidebar shows top 3 + a "＋2 more" row).
const managedProjects: ManagedProject[] = [
  { id: 'phnx-labs/agents-cli', name: 'agents-cli', path: '/Users/muqsit/src/github.com/phnx-labs/agents-cli', repoSlug: 'phnx-labs/agents-cli', linearProjectId: 'a', linearProjectName: 'Agents CLI', confidence: 'high', source: 'detected' },
  { id: 'phnx-labs/prix', name: 'prix', path: '/Users/muqsit/src/github.com/phnx-labs/prix', repoSlug: 'phnx-labs/prix', linearProjectId: 'b', linearProjectName: 'Prix', confidence: 'high', source: 'detected' },
  { id: 'muqsitnawaz/rush', name: 'rush-app', path: '/Users/muqsit/Rush/app', repoSlug: 'muqsitnawaz/rush', linearProjectId: 'c', linearProjectName: 'Rush App', confidence: 'medium', source: 'manual' },
  { id: 'phnx-labs/rush-cli', name: 'rush-cli', path: '/Users/muqsit/src/github.com/phnx-labs/rush-cli', repoSlug: 'phnx-labs/rush-cli', linearProjectId: 'd', linearProjectName: 'Rush CLI', confidence: 'medium', source: 'detected' },
  { id: 'scratch-tool', name: 'scratch-tool', path: '/Users/muqsit/tmp/scratch-tool', confidence: 'low', source: 'manual' },
]
const linearProjectList: LinearProjectLite[] = [
  { id: 'a', name: 'Agents CLI' }, { id: 'b', name: 'Prix' }, { id: 'c', name: 'Rush App' }, { id: 'd', name: 'Rush CLI' },
]

function Feed() {
  return (
    <div className="feed">
      <SavedViews
        views={[
          { name: 'Today', sort: 'needs', status: [], abbrs: [], search: '' },
          { name: 'Engineering', sort: 'needs', status: [], abbrs: [], search: '' },
          { name: 'My work', sort: 'needs', status: [], abbrs: [], search: '' },
        ]}
        activeName="Today"
        onApply={noop}
        onSave={noop}
        onDelete={noop}
      />

      <div className="feed-sec attn">
        <Icon name="alert" size={11} /> NEEDS YOU · 4
        <span className="ln" />
      </div>
      <FeedItem agent={twinA} selected={false} plain={false} onSelect={noop} onOption={noop} onFreeText={noop} onAttach={noop} />
      <FeedItem agent={twinB} selected={false} plain={false} onSelect={noop} onOption={noop} onFreeText={noop} onAttach={noop} />
      <FeedItem agent={askAgent} selected={false} plain={false} onSelect={noop} onOption={noop} onFreeText={noop} onAttach={noop} />
      <FeedItem agent={reviewAgent} selected={false} plain={false} onSelect={noop} onOption={noop} onFreeText={noop} onAttach={noop} />

      <div className="feed-sec">RUNNING · {running.length}<span className="ln" />
        <span className="fresh"><span className="rot"><Icon name="refresh" size={11} /></span>hosts synced 4s ago</span>
      </div>
      {running.map((a) => (
        <FeedItem key={a.id} agent={a} selected={false} plain={false} onSelect={noop} onOption={noop} onFreeText={noop} onAttach={noop} />
      ))}

      <div className="backlog">
        <div className="bh">
          <span><Icon name="chevD" size={11} /> READY TO DISPATCH · {tickets.length}</span>
          <span className="c"><span className="seeall">see all {tickets.length} <Icon name="chevR" size={10} /></span></span>
        </div>
        {tickets.map((t) => (
          <TicketStrip key={t.id} ticket={t} onDispatch={noop} onSelect={noop} />
        ))}
      </div>

      <div className="feed-sec">DONE TODAY · {done.length}<span className="ln" /></div>
      {done.map((a) => (
        <FeedItem key={a.id} agent={a} selected={false} plain={false} onSelect={noop} onOption={noop} onFreeText={noop} onAttach={noop} />
      ))}
    </div>
  )
}

// Backlog center with the group/sort/filter toolbar. Defaults to grouping by
// Owner so the preview shows tickets bucketed by assignee (incl. Unassigned).
function Backlog() {
  const [group, setGroup] = useState<TicketGroupBy>('project')
  const [sort, setSort] = useState<TicketSort>('priority')
  const [srcFilter, setSrcFilter] = useState<Record<'LN' | 'GH', boolean>>({ LN: true, GH: true })
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <BacklogCenter
      tickets={tickets}
      group={group}
      sort={sort}
      srcFilter={srcFilter}
      projFilter={null}
      search=""
      selectedTicketId={selected}
      onGroup={setGroup}
      onSort={setSort}
      onToggleSrc={(s) => setSrcFilter((f) => ({ ...f, [s]: !f[s] }))}
      onSelectTicket={setSelected}
      onBackToAgents={noop}
    />
  )
}

// Sidebar with the HOSTS rail — local + online + offline devices, one pinned —
// so the host status dots (`.hd`) can be screenshotted at their true size.
function Sidebar() {
  const [pins, setPins] = useState<string[]>(['zion'])
  const sidebarAgents: FloorAgent[] = [
    ...running,
    agent({ id: 's1', hostLabel: 'yosemite-s0', project: 'agents-cli' }),
    agent({ id: 's2', hostLabel: 'yosemite-s0', project: 'agents-cli' }),
    agent({ id: 's3', hostLabel: 'yosemite-s1', project: 'agents-cli' }),
  ]
  const devices = [
    { name: 'zion', online: true, agents: 8 },
    { name: 'mac-mini', online: true, agents: 0 },
    { name: 'win-mini', online: true, agents: 0 },
    { name: 'yosemite-s0', online: true, agents: 2 },
    { name: 'yosemite-s1', online: false, agents: 1 },
  ]
  return (
    <FloorSidebar
      agents={sidebarAgents}
      tickets={tickets}
      projFilter={null}
      offlineHosts={['yosemite-s1']}
      devices={devices}
      hostPins={pins}
      projects={managedProjects}
      onManageProjects={noop}
      onToggleHostPin={(n) => setPins((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]))}
      onReorderHostPins={setPins}
      onScope={noop}
      localHost="zion"
    />
  )
}

// Projects center pane — curated list + add/edit form (the gear target).
function Projects() {
  return (
    <ProjectsPane
      projects={managedProjects}
      linearProjects={linearProjectList}
      pickedFolder={null}
      onSave={noop}
      onDelete={noop}
      onPickFolder={noop}
      onClose={noop}
    />
  )
}

function Preview() {
  const params = new URLSearchParams(location.search)
  const theme = params.get('theme') === 'light' ? 'theme-light' : 'theme-dark'
  const view = params.get('view') ?? 'feed'
  const [dispatchOpen] = useState(view === 'dispatch')
  return (
    <div className={`swarmify-root ${theme}`} style={{ minHeight: '100vh' }}>
      <div className="sw-floor-dashboard" style={{ padding: 0 }}>
        <div className="page" style={{ display: 'flex' }}>
          {view === 'sidebar' ? <Sidebar /> : view === 'projects' ? <div className="feed-col"><Projects /></div> : <div className="feed-col">{view === 'backlog' ? <Backlog /> : <Feed />}</div>}
        </div>
      </div>
      <DispatchPanel
        open={dispatchOpen}
        tasks={tasks}
        agents={dAgents}
        hosts={dHosts}
        targets={dTargets}
        prefillTicketId="RUSH-1262"
        onClose={noop}
        onDispatch={noop}
        onDraftPrompt={noop}
        draftResult={null}
      />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Preview />)
