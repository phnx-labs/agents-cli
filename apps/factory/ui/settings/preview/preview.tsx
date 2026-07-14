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
import { FloorRail } from '../components/mission-control/FloorRail'
import { FloorControls, floorControlsMode } from '../components/mission-control/FloorControls'
import { FloorSubtabs, openTaskTab, closeTaskTab, type FixedTab, type TaskTab } from '../components/mission-control/FloorSubtabs'
import { FeedItem, TicketStrip } from '../components/mission-control/FeedItem'
import { SavedViews } from '../components/mission-control/SavedViewsBar'
import { DispatchPanel } from '../components/mission-control/DispatchPanel'
import { BacklogCenter } from '../components/mission-control/BacklogCenter'
import { PrBoardPane } from '../components/mission-control/PrBoardPane'
import { buildPrBoard, type PrStatusLike } from '../components/mission-control/prBoardModel'
import { TicketDetail } from '../components/mission-control/TicketDetail'
import { ProjectsPane } from '../components/mission-control/ProjectsPane'
import { TerminalExpandedDetail } from '../components/mission-control/TerminalDetail'
import { AgentDecision } from '../components/mission-control/AgentDecision'
import { ticketWorkers, type FloorAgent, type FloorTicket, type StructuredQuestion, type FloorGroupBy, type FloorSort, type TicketGroupBy, type TicketSort, type CenterMode, type ManagedProject, type LinearProjectLite } from '../components/mission-control/floorModel'
import { RecapPane } from '../components/mission-control/RecapPane'
import { buildRecap } from '../components/mission-control/recapModel'
import type { RemoteSessionLike } from '../components/mission-control/floorAdapter'
import type { UnifiedTask, TerminalDetail } from '../types'
import type { InstalledAgent, DispatchHost, DispatchTarget } from '../components/mission-control/dispatch.types'

const noop = () => {}
const feedHandlers = {
  onSelect: noop,
  onOption: noop,
  onFreeText: noop,
  onAttach: noop,
  onOpenPlan: noop,
  onOpenAttachment: noop,
}

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
    prompt: undefined,
    messages: [],
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
  id: 'twin-a', abbr: 'CC', name: 'byok-keychain-cleanup', project: 'agents-cli', phase: 'waiting',
  needs: true, worktreeSlug: 'headless-secrets-shadow', branch: 'muqsit/headless-secrets',
  verb: 'Edit', target: 'src/lib/secrets/linux.ts',
  summary: 'Removing the stale BYOK resolver and its keychain writes.', since: '0s',
})
const twinB = agent({
  id: 'twin-b', abbr: 'CC', name: 'linux-secret-service', project: 'agents-cli', phase: 'waiting',
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
// NEEDS YOU — an idle/paused session whose last turn was a thinking block. Its verb is
// the "Thinking..." live-activity placeholder, but the card must NOT render it (once was
// shown twice: as the body AND the now-line). Expect: task + timeline + reply, no "Thinking...".
const idleThinkingAgent = agent({
  id: 'a-idle', abbr: 'CC', name: 'agents-cli-readiness', project: 'agents-cli', phase: 'waiting',
  needs: true, verb: 'Thinking...', target: '', resp: '', since: '22h',
  sessionId: '659a7ec6-2c1a-4f9e-b2d1-7a3c9e10ab55',
  prompt: 'Is our agents-cli, our skills and factory tooling good enough — like remote agent execution — such that I can dispatch 100 tasks from Linear and the results will be **somewhat good**?',
  plans: [
    { path: '/repo/.agents/worktrees/agent-readiness/ref-plan.html', label: 'ref-plan.html', kind: 'html', source: 'output' },
    { path: '/repo/.agents/worktrees/agent-readiness/ref-review.md', label: 'ref-review.md', kind: 'markdown', source: 'worktree' },
  ],
  attachments: [
    {
      path: '/Users/muqsit/.agents/.history/attachments/factory-floor-readiness.png',
      label: 'factory-floor-readiness.png',
      mediaType: 'image/png',
      sizeBytes: 184_320,
      thumbnailUri: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 96 64%22%3E%3Crect width=%2296%22 height=%2264%22 fill=%22%230a0a0a%22/%3E%3Crect x=%226%22 y=%226%22 width=%2284%22 height=%2252%22 rx=%224%22 fill=%22%23151613%22 stroke=%22%23a3e635%22/%3E%3Cpath d=%22M13 44l17-18 14 12 11-9 28 23H13z%22 fill=%22%235a7d1b%22/%3E%3Ccircle cx=%2268%22 cy=%2220%22 r=%226%22 fill=%22%23a3e635%22/%3E%3C/svg%3E',
    },
  ],
  recent: [
    { name: 'Bash', input: { command: 'cd /Users/muqsit/src/github.com/muqsitnawaz/agents-cli' }, timestamp: new Date(Date.now() - 86_400_000).toISOString() },
    { name: 'Read', input: { file_path: '/Users/muqsit/CleanShot 2026-07-08 at 16.07.46@2x.png' }, timestamp: new Date(Date.now() - 86_460_000).toISOString() },
  ],
})

// RUNNING lane.
const running: FloorAgent[] = [
  agent({
    id: 'r1', abbr: 'CX', name: 'bench-saved-views', sessionId: '4de7b016-2c1a-4f9e-b2d1-7a3c9e10ab55', project: 'rush', phase: 'running',
    pr: '#148', ci: 'running', tok: 41, files: 9, since: '3s', lastActivityMs: Date.now() - 3000,
    pane: '%42', viewingIn: 'Codium tab 3', worktreeSlug: 'bench-saved-views',
    verb: 'Porting', target: 'the group-by control into the shared model',
    prompt: 'Collapse the **three** ticket surfaces into one list and add saved views, wiring the group-by control through the shared `floorModel`.',
    summary: 'Collapsed the three ticket surfaces into one list; now porting the group-by control into the shared model.',
    resp: 'Merged the three surfaces into one `BacklogCenter`. Group-by now reads `groupAgents()` from the shared model — porting the last dead view next.',
    messages: [
      'Read `floorModel.ts` — `groupAgents()` already covers host/project/status/agent, so I can drop the local copy.',
      'Collapsed the three ticket surfaces into one `BacklogCenter` list.',
      'Merged the three surfaces into one `BacklogCenter`. Group-by now reads `groupAgents()` from the shared model — porting the last dead view next.',
    ],
    recent: [
      { name: 'Bash', input: { command: 'bun run test bench' }, timestamp: new Date(Date.now() - 3000).toISOString() },
      { name: 'Edit', input: { file_path: '/repo/ui/settings/components/mission-control/BacklogCenter.tsx' }, timestamp: new Date(Date.now() - 40_000).toISOString() },
      { name: 'Edit', input: { file_path: '/repo/ui/settings/components/mission-control/floorAdapter.ts' }, timestamp: new Date(Date.now() - 80_000).toISOString() },
      { name: 'Read', input: { file_path: '/repo/ui/settings/components/mission-control/floorModel.ts' }, timestamp: new Date(Date.now() - 130_000).toISOString() },
    ],
    plans: [
      { path: '/repo/.agents/worktrees/bench-saved-views/ref-plan.html', label: 'ref-plan.html', kind: 'html', source: 'output' },
      { path: '/repo/.agents/worktrees/bench-saved-views/ref-review.md', label: 'ref-review.md', kind: 'markdown', source: 'worktree' },
    ],
    createdTickets: ['RUSH-1519', 'RUSH-1520'],
    createdCommits: ['095e588093ca'],
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
    spawnedTeam: 'dispatch-refactor',
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
  const [grp, setGrp] = useState<FloorGroupBy | 'none'>('project')
  const [subgrp, setSubgrp] = useState<FloorGroupBy | 'none'>('host')
  const [srt, setSrt] = useState<'needs' | 'recent' | 'tok' | 'name'>('needs')
  return (
    <div className="feed">
      <FloorControls
        mode="agents"
        needsCount={2}
        sidebarOpen rightOpen plain={false}
        onToggleSidebar={noop} onToggleRight={noop} onTogglePlain={noop}
        sort={srt} onSort={setSrt} group={grp} onGroup={setGrp}
        subgroup={subgrp} onSubgroup={setSubgrp}
        ticketGroup="project" onTicketGroup={noop}
        ticketSubgroup="none" onTicketSubgroup={noop}
        ticketSort="priority" onTicketSort={noop}
        srcFilter={{ LN: true, GH: true }} onToggleSrc={noop}
      />
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
        <Icon name="alert" size={11} /> NEEDS YOU · 5
        <span className="ln" />
      </div>
      <FeedItem agent={idleThinkingAgent} selected={false} plain={false} {...feedHandlers} />
      <FeedItem agent={twinA} selected={false} plain={false} {...feedHandlers} />
      <FeedItem agent={twinB} selected={false} plain={false} {...feedHandlers} />
      <FeedItem agent={askAgent} selected={false} plain={false} {...feedHandlers} />
      <FeedItem agent={reviewAgent} selected={false} plain={false} {...feedHandlers} />

      <div className="feed-sec">RUNNING · {running.length}<span className="ln" />
        <span className="fresh"><span className="rot"><Icon name="refresh" size={11} /></span>hosts synced 4s ago</span>
      </div>
      {running.map((a) => (
        <FeedItem key={a.id} agent={a} selected={false} plain={false} {...feedHandlers} />
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
        <FeedItem key={a.id} agent={a} selected={false} plain={false} {...feedHandlers} />
      ))}
    </div>
  )
}

// Backlog center + its contextual controls bar (FloorControls mode='backlog'). The
// group/sort/source controls live in the shared bar now, not a per-view toolbar.
function Backlog() {
  const [group, setGroup] = useState<TicketGroupBy>('project')
  const [subgroup, setSubgroup] = useState<TicketGroupBy | 'none'>('source')
  const [sort, setSort] = useState<TicketSort>('priority')
  const [srcFilter, setSrcFilter] = useState<Record<'LN' | 'GH', boolean>>({ LN: true, GH: true })
  const [selected, setSelected] = useState<string | null>(null)
  // One in-flight ticket (two workers) so the .twork chip renders at true size.
  const workers = ticketWorkers([
    ...running,
    agent({ id: 'w1', ticket: 'RUSH-1262', name: 'pkce-pinning', abbr: 'CC' }),
    agent({ id: 'w2', ticket: 'RUSH-1262', name: 'pkce-review', abbr: 'CX', phase: 'waiting' }),
  ])
  return (
    <>
      <FloorControls
        mode="backlog"
        sidebarOpen rightOpen plain={false}
        onToggleSidebar={noop} onToggleRight={noop} onTogglePlain={noop}
        sort="needs" onSort={noop} group="project" onGroup={noop}
        subgroup="none" onSubgroup={noop}
        ticketGroup={group} onTicketGroup={setGroup}
        ticketSubgroup={subgroup} onTicketSubgroup={setSubgroup}
        ticketSort={sort} onTicketSort={setSort}
        srcFilter={srcFilter} onToggleSrc={(s) => setSrcFilter((f) => ({ ...f, [s]: !f[s] }))}
      />
      <BacklogCenter
        tickets={tickets}
        group={group}
        subgroup={subgroup}
        sort={sort}
        srcFilter={srcFilter}
        projFilter={null}
        search=""
        selectedTicketId={selected}
        workers={workers}
        onSelectTicket={setSelected}
        onOpenTask={noop}
      />
    </>
  )
}

// Sub-tab strip + contextual controls bar — the full Option A nav. Fixed center pills
// (Agents/Backlog/Projects/Hosts) with count+needs badges, two pre-opened task tabs, and
// the one contextual bar that swaps its control set per active center (or hides for a
// task tab / projects / hosts). URL: ?view=subtabs (&center=agents|backlog|projects|host).
function Subtabs() {
  const params = new URLSearchParams(location.search)
  const [center, setCenter] = useState<CenterMode>((params.get('center') as CenterMode) || 'agents')
  const [activeTaskTab, setActiveTaskTab] = useState<string | null>(null)
  const [taskTabs, setTaskTabs] = useState<TaskTab[]>([
    { id: 'RUSH-1262', title: 'PKCE token exchange uses unpinned http client', source: 'LN' },
    { id: '#418', title: 'Kanban / Deadline feed views are stubs', source: 'GH' },
  ])
  const [grp, setGrp] = useState<FloorGroupBy | 'none'>('project')
  const [subgrp, setSubgrp] = useState<FloorGroupBy | 'none'>('host')
  const [srt, setSrt] = useState<FloorSort>('needs')
  const [tg, setTg] = useState<TicketGroupBy>('project')
  const [tsg, setTsg] = useState<TicketGroupBy | 'none'>('source')
  const [ts, setTs] = useState<TicketSort>('priority')
  const [src, setSrc] = useState<Record<'LN' | 'GH', boolean>>({ LN: true, GH: true })
  const [selected, setSelected] = useState<string | null>(null)

  const fixed: FixedTab[] = [
    { center: 'agents', label: 'Agents', count: running.length + 2, needs: 2 },
    { center: 'backlog', label: 'Backlog', count: tickets.length },
    { center: 'projects', label: 'Projects', count: managedProjects.length },
    { center: 'host', label: 'Hosts', count: 5 },
  ]
  const controlsMode = activeTaskTab ? null : floorControlsMode(center)
  return (
    <div className="feed-col">
      <FloorSubtabs
        fixed={fixed}
        center={center}
        taskTabs={taskTabs}
        activeTaskTab={activeTaskTab}
        onSelectCenter={(c) => { setActiveTaskTab(null); setCenter(c) }}
        onSelectTaskTab={setActiveTaskTab}
        onCloseTaskTab={(id) => {
          const r = closeTaskTab(taskTabs, activeTaskTab, id)
          setTaskTabs(r.tabs)
          setActiveTaskTab(r.activeId)
        }}
        onDispatch={noop}
      />
      {controlsMode && (
        <FloorControls
          mode={controlsMode}
          needsCount={2}
          sidebarOpen rightOpen plain={false}
          onToggleSidebar={noop} onToggleRight={noop} onTogglePlain={noop}
          sort={srt} onSort={setSrt} group={grp} onGroup={setGrp}
          subgroup={subgrp} onSubgroup={setSubgrp}
          ticketGroup={tg} onTicketGroup={setTg}
          ticketSubgroup={tsg} onTicketSubgroup={setTsg}
          ticketSort={ts} onTicketSort={setTs}
          srcFilter={src} onToggleSrc={(s) => setSrc((f) => ({ ...f, [s]: !f[s] }))}
        />
      )}
      {!activeTaskTab && center === 'backlog' && (
        <BacklogCenter
          tickets={tickets}
          group={tg}
          subgroup={tsg}
          sort={ts}
          srcFilter={src}
          projFilter={null}
          search=""
          selectedTicketId={selected}
          onSelectTicket={setSelected}
          onOpenTask={(t) => {
            setTaskTabs((prev) => openTaskTab(prev, { id: t.id, title: t.title, source: t.source }))
            setActiveTaskTab(t.id)
          }}
        />
      )}
    </div>
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
  const [collapsed, setCollapsed] = useState(true)
  return collapsed ? (
    <FloorRail
      agents={sidebarAgents}
      tickets={tickets}
      center="agents"
      projFilter={null}
      hostFilter={null}
      needsOnly={false}
      projects={managedProjects}
      devices={devices}
      offlineHosts={['yosemite-s1']}
      hostPins={pins}
      localHost="zion"
      onScope={noop}
      onDispatch={noop}
      onManageProjects={noop}
      onExpand={() => setCollapsed(false)}
    />
  ) : (
    <FloorSidebar
      agents={sidebarAgents}
      tickets={tickets}
      projFilter={null}
      offlineHosts={['yosemite-s1']}
      devices={devices}
      hostPins={pins}
      projects={managedProjects}
      onManageProjects={noop}
      onCollapse={() => setCollapsed(true)}
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
      rollups={{
        'agents-cli': { run: 3, wait: 1, backlog: 4, prs: 2, lastActivityMs: Date.now() - 40 * 60_000 },
        rush: { run: 2, wait: 0, backlog: 12, prs: 1, lastActivityMs: Date.now() - 5 * 60_000 },
      }}
      linearProjects={linearProjectList}
      pickedFolder={null}
      onSave={noop}
      onDelete={noop}
      onPickFolder={noop}
      onClose={noop}
    />
  )
}

// Representative terminal session for the detail-pane preview (?view=detail): a mix of
// tool calls (incl. a TodoWrite so the checklist shows), narrative prose, and edited
// files with diff stats — exercises the redesigned TerminalExpandedDetail end to end.
const detailTerminal: TerminalDetail = {
  id: 't-detail',
  agentType: 'claude',
  label: 'supabase-rls-migration',
  autoLabel: null,
  createdAt: Date.now() - 600_000,
  index: 2,
  sessionId: '9f1c0e22-5b7a-4c3d-9e10-2a4b6c8d0e12',
  cwd: '/Users/muqsit/src/github.com/muqsitnawaz/rush',
  branch: 'muqsit/rls-migration',
  firstUserMessage: 'Migrate the **policy_v1** RLS rules to the new `policy` table and add a regression test.',
  messageCount: 34,
  currentActivity: 'Editing the migration',
  quickSummary: {
    filesEdited: 3,
    toolCalls: 22,
    webSearches: 1,
    narrative: 'Ported the `policy_v1` rules onto the new table and wired the down-migration. Running the RLS regression suite now — one policy for `service_role` still needs a rewrite.',
  } as TerminalDetail['quickSummary'],
  recentFiles: [
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/supabase/migrations/20260708_policy.sql',
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/tests/rls_policy.test.ts',
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/src/db/policy.ts',
  ],
  attachments: [
    {
      path: '/Users/muqsit/.agents/.history/attachments/rls-policy-error.png',
      label: 'rls-policy-error.png',
      mediaType: 'image/png',
      sizeBytes: 96_512,
      thumbnailUri: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 160 100%22%3E%3Crect width=%22160%22 height=%22100%22 fill=%22%230d1117%22/%3E%3Crect x=%2212%22 y=%2214%22 width=%22136%22 height=%2272%22 rx=%226%22 fill=%22%23161b22%22 stroke=%22%233b82f6%22/%3E%3Cpath d=%22M24 70l28-28 22 18 18-14 44 35H24z%22 fill=%22%23214b7a%22/%3E%3Ccircle cx=%22118%22 cy=%2236%22 r=%2210%22 fill=%22%23a3e635%22/%3E%3C/svg%3E',
    },
  ],
  recentFileTimes: {
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/supabase/migrations/20260708_policy.sql': Date.now() - 8_000,
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/tests/rls_policy.test.ts': Date.now() - 60_000,
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/src/db/policy.ts': Date.now() - 180_000,
  },
  recentFileStats: {
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/supabase/migrations/20260708_policy.sql': { added: 48, removed: 2 },
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/tests/rls_policy.test.ts': { added: 31, removed: 0 },
    '/Users/muqsit/src/github.com/muqsitnawaz/rush/src/db/policy.ts': { added: 12, removed: 7 },
  },
  recentToolCalls: [
    { name: 'Bash', input: { command: 'bun test tests/rls_policy.test.ts' }, timestamp: new Date(Date.now() - 8_000).toISOString() },
    { name: 'Edit', input: { file_path: '/rush/supabase/migrations/20260708_policy.sql' }, timestamp: new Date(Date.now() - 30_000).toISOString() },
    { name: 'TodoWrite', input: { todos: [
      { content: 'Port policy_v1 rules to policy table', status: 'completed' },
      { content: 'Write the down-migration', status: 'completed' },
      { content: 'Rewrite the service_role policy', status: 'in_progress' },
      { content: 'Add RLS regression test', status: 'pending' },
    ] }, timestamp: new Date(Date.now() - 60_000).toISOString() },
    { name: 'Read', input: { file_path: '/rush/src/db/policy.ts' }, timestamp: new Date(Date.now() - 120_000).toISOString() },
    { name: 'Grep', input: { pattern: 'policy_v1' }, timestamp: new Date(Date.now() - 200_000).toISOString() },
  ],
} as TerminalDetail

function Detail() {
  return (
    <div className="feed-col" style={{ maxWidth: 420 }}>
      <div className="sw-unified-detail">
        <TerminalExpandedDetail terminal={detailTerminal} />
      </div>
    </div>
  )
}

// The three NEEDS-YOU decision-block shapes (RUSH-1521/1546): the real question + its
// options + a why-blocked chip, extracted at the CLI source. Renders the exact markup the
// right detail pane uses.
const permAgent = agent({
  id: 'a-perm', abbr: 'CC', name: 'headless-secrets', project: 'agents-cli', phase: 'waiting', needs: true,
  prompt: 'Wire the Linux secret-service fallback into the BYOK resolver and add a regression test.',
  question: {
    kind: 'destructive', reason: 'permission', text: 'Permission — Bash: rm -rf build && bun run compile',
    options: ['Approve', 'Deny'], optionKeys: ['1', 'esc'], clusterKey: 'perm-rm-build',
  }, since: '2m',
})
const askAgentD = agent({
  id: 'a-ask-d', abbr: 'CC', name: 'agent-readiness-review', project: 'agents-cli', phase: 'waiting', needs: true,
  prompt: 'Make the NEEDS-YOU panel surface enough to unblock agents at a glance.',
  question: {
    kind: 'choice', reason: 'question', text: 'Ship v0.9.290 with the two follow-ups now, or pull more of the feed-UI backlog into this pass first?',
    options: ['Build 0.9.290 now', 'Pull more backlog first'], optionKeys: ['1', '2'], clusterKey: 'ship-0-9-290',
  }, since: '18h',
})
const planAgent = agent({
  id: 'a-plan', abbr: 'GX', name: 'dispatch-refactor', project: 'rush', phase: 'waiting', needs: true,
  prompt: 'Refactor the dispatch resolver so repo/owner parsing lives in one place.',
  question: {
    kind: 'confirm', reason: 'plan_review', text: 'Plan ready — review it',
    options: ['Approve plan', 'Keep planning'], optionKeys: ['1', 'esc'], clusterKey: 'plan-dispatch',
  }, since: '30s',
})

function Decision() {
  return (
    <div className="feed-col" style={{ maxWidth: 460 }}>
      <div className="sw-unified-detail">
        {[permAgent, askAgentD, planAgent].map((a) => (
          <AgentDecision key={a.id} agent={a} onOption={noop} onFreeText={noop} onAttach={noop} onNudge={noop} />
        ))}
      </div>
    </div>
  )
}

// Ticket detail with an in-flight worker — the dflight block + "Dispatch anyway"
// caution at true size (?view=ticket).
function Ticket() {
  const workers = ticketWorkers([
    agent({ id: 'w1', ticket: 'RUSH-1262', name: 'pkce-pinning', abbr: 'CC', pr: '#142' }),
    agent({ id: 'w2', ticket: 'RUSH-1262', name: 'pkce-review', abbr: 'CX', phase: 'waiting' }),
  ])
  return (
    <div className="detail-col" style={{ maxWidth: 420 }}>
      <TicketDetail ticket={tickets[0]!} hosts={['zion', 'mac-mini']} workers={workers['RUSH-1262']} onSelectAgent={noop} onDispatch={noop} />
    </div>
  )
}

// PR board — CI/review/mergeable badges + the ready-row Merge button (?view=prs).
function PrBoard() {
  const st = (over: Partial<PrStatusLike>): PrStatusLike => ({
    url: 'https://github.com/phnx-labs/agents-cli/pull/142', number: 142,
    title: 'feat(factory): floor rail flyouts — Projects/Hosts menus, Dispatch button',
    state: 'open', isDraft: false, ci: 'passed', review: 'approved', mergeable: 'mergeable', readyToMerge: true,
    ...over,
  })
  const rows = buildPrBoard(
    [
      st({}),
      st({ url: 'u866', number: 866, title: 'feat(factory): in-flight ticket linkage on the backlog', ci: 'running', review: null, readyToMerge: false }),
      st({ url: 'u869', number: 869, title: 'feat(factory): Recap — fleet-wide work ledger', ci: 'failed', review: 'changes_requested', readyToMerge: false }),
      st({ url: 'u871', number: 871, title: 'chore: bump deps', mergeable: 'conflicting', review: 'review_required', ci: null, readyToMerge: false }),
    ],
    [reviewAgent],
  )
  return (
    <div className="feed-col">
      <PrBoardPane rows={rows} loading={false} merging={new Set(['u866'])} errors={{ u871: 'GraphQL: Pull Request has merge conflicts (mergePullRequest)' }} onMerge={noop} onOpenUrl={noop} onRefresh={noop} />
    </div>
  )
}

// Recap ledger — day-grouped ended sessions with duration/cost rollups (?view=recap).
function Recap() {
  const now = Date.now()
  const rs = (over: Partial<RemoteSessionLike>): RemoteSessionLike => ({
    host: 'zion', sessionId: Math.random().toString(36).slice(2), agentType: 'claude', cwd: '/repo',
    project: 'agents-cli', phase: 'idle', activity: '', tokPerSec: 0, waitingForInput: false,
    lastResponse: '', prUrl: null, ticket: null, branch: 'main', sinceMs: 0,
    startedAtMs: now - 3_600_000, lastActivityMs: now - 1_800_000, topic: '', context: 'recent',
    cloudTaskId: '', cloudProvider: '', teamName: '', pid: 0, transport: '', replyRail: '',
    replyMuxTarget: '', replyMuxSocket: '', tmuxPane: '',
    durationMs: 2_562_000, costUsd: 5.6, tokenCount: 2_849_270, ...over,
  })
  const days = buildRecap(
    [
      rs({ topic: 'Floor rail flyouts — Projects/Hosts menus, Dispatch button', prUrl: 'https://github.com/phnx-labs/agents-cli/pull/862', ticket: 'RUSH-1521', lastActivityMs: now - 40 * 60_000 }),
      rs({ topic: 'In-flight ticket linkage on the backlog', agentType: 'codex', host: 'yosemite-s0', prUrl: 'https://github.com/phnx-labs/agents-cli/pull/866', costUsd: 3.2, durationMs: 1_100_000, lastActivityMs: now - 2 * 3_600_000 }),
      rs({ topic: 'Fix PKCE http client pinning', agentType: 'gemini', host: 'mac-mini', project: 'rush', costUsd: 0.8, durationMs: 600_000, lastActivityMs: now - 26 * 3_600_000 }),
      rs({ topic: 'Deploy agents on mac-mini and sync system repo', costUsd: 1.4, durationMs: 900_000, lastActivityMs: now - 27 * 3_600_000, branch: 'HEAD' }),
    ],
    new Set(),
    now,
  )
  return <div className="feed-col"><RecapPane days={days} loading={false} onOpenUrl={noop} /></div>
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
          {view === 'sidebar' ? <Sidebar /> : view === 'subtabs' ? <Subtabs /> : view === 'projects' ? <div className="feed-col"><Projects /></div> : view === 'detail' ? <Detail /> : view === 'decision' ? <Decision /> : view === 'prs' ? <PrBoard /> : view === 'ticket' ? <Ticket /> : view === 'recap' ? <Recap /> : <div className="feed-col">{view === 'backlog' ? <Backlog /> : <Feed />}</div>}
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
