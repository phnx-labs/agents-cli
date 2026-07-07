// Standalone visual preview of the current Factory Floor feed + Dispatch panel.
// Renders the SAME components the webview uses, with representative data, so the
// current UI can be seen/screenshotted without the VS Code extension host. Not
// shipped (vite.settings.config.ts only inputs settings/index.html); a dev harness.
//
// Run:  cd extension/ui && bun run dev  ->  open http://localhost:5173/preview/
//   URL params:  ?view=feed|dispatch  &  ?theme=dark|light
// (Serve over http, not file://, or ES-module imports are CORS-blocked.)
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../index.css'

import { Icon } from '../components/mission-control/icons'
import { FeedItem, TicketStrip } from '../components/mission-control/FeedItem'
import { SavedViews } from '../components/mission-control/SavedViewsBar'
import { DispatchPanel } from '../components/mission-control/DispatchPanel'
import type { FloorAgent, FloorTicket, StructuredQuestion } from '../components/mission-control/floorModel'
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
    resp: '',
    question: null,
    reply: { kind: 'terminal', host: 'this-mac' },
    todos: [],
    summary: '',
    recent: [],
    ...p,
  }
}

const dropQuestion: StructuredQuestion = {
  kind: 'destructive',
  text: 'Drop the legacy policy_v1 table, or keep it for rollback?',
  options: ['Drop it', 'Keep it'],
  clusterKey: 'drop-policy',
}

// NEEDS YOU — a CI-green PR awaiting review, and a destructive question.
const reviewAgent = agent({
  id: 'a-review', abbr: 'CC', name: 'fix-terminal-race', project: 'rush', phase: 'done',
  needs: true, pr: '#142', ci: 'passed', ticket: 'RUSH-1302',
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
  { id: 'RUSH-1262', title: '[security] rush CLI PKCE token exchange uses unpinned http client', project: 'rush', source: 'LN', pri: 'urgent', status: 'todo', desc: '', labels: ['security'] },
  { id: 'RUSH-799', title: 'Remote agent heartbeat anchors to start time, shows false stall', project: 'agents-cli', source: 'LN', pri: 'high', status: 'todo', desc: '', labels: [] },
  { id: '#418', title: 'Kanban / Deadline feed views are stubs -> "coming soon"', project: 'swarmify', source: 'GH', pri: 'med', status: 'todo', desc: '', labels: [] },
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
  { id: 'rush', label: 'rush', path: '/Users/muqsit/src/github.com/muqsitnawaz/rush', uses: 30 },
  { id: 'muqsitnawaz/rush', label: 'muqsitnawaz/rush', uses: 30 },
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
        <Icon name="alert" size={11} /> NEEDS YOU · 2
        <span className="ln" />
      </div>
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

function Preview() {
  const params = new URLSearchParams(location.search)
  const theme = params.get('theme') === 'light' ? 'theme-light' : 'theme-dark'
  const view = params.get('view') ?? 'feed'
  const [dispatchOpen] = useState(view === 'dispatch')
  return (
    <div className={`swarmify-root ${theme}`} style={{ minHeight: '100vh' }}>
      <div className="sw-floor-dashboard" style={{ padding: 0 }}>
        <div className="page">
          <div className="feed-col"><Feed /></div>
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
