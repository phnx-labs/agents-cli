// Consolidated Dispatch panel — replaces the 5 legacy dispatch surfaces.
// Presentational + local state only; data + actions arrive via DispatchPanelProps.
// Matches extension/docs/prototypes/dispatch.html 1:1 (layout, class names,
// interactions). The prototype's `S` object is mirrored in local state; `render()`
// becomes this component tree; the sub-renderers are the imported sub-components.
import React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { Bell, useClickAway } from './dispatchIcons'
import { DispatchInput, ticketKey } from './dispatchInput'
import { resolveAutoProject } from './dispatch'
import { AgentSelect } from './AgentSelect'
import { HostSelect, suggestedHost } from './HostSelect'
import { ProjectSelect } from './ProjectSelect'
import { ModeSeg } from './ModeSeg'
import { SurfaceSeg } from './SurfaceSeg'
import { WatchdogSeg } from './WatchdogSeg'
import { NotifyBell } from './NotifyBell'
import { BatchToggle } from './BatchToggle'
import type { UnifiedTask } from '../../types'
import type {
  InstalledAgent, DispatchHost, DispatchTarget, DispatchRequest,
  DispatchAttachment, DispatchMode, WatchdogPolicy, NotifyPrefs,
} from './dispatch.types'

// ---- registered-device dispatch (SSH to a real machine with live health) ----
// These types are local to the owned dispatch files (they mirror the backend
// deviceRegistry/deviceHealth/repoIndex/repoSync shapes) so DispatchRequest and
// dispatch.types stay untouched — the device path is additive.
export type SyncPolicy = 'off' | 'safe' | 'aggressive'

/** One attached ticket flattened for the draft-prompt round-trip (host reads these). */
export interface DraftTicketPayload {
  identifier?: string
  title: string
  description?: string
}

/** Result of a draft attempt, delivered from the host via 'draftPromptResult'.
 *  `nonce` changes each delivery so the panel's effect fires even on repeats. */
export interface DraftResult {
  ok: boolean
  text?: string
  error?: string
  nonce: number
}

export interface DispatchDevice {
  name: string
  host: string
  secretRef?: string
  softLimit?: number
  reachable: boolean
  runningAgents?: number
  memPercent?: number
  loadAvg1?: number
}

export interface DispatchDeviceProject {
  name: string
  relPath: string
}

export interface DispatchDeviceRepo {
  slug: string
  freq: number
  perHostPaths: Record<string, string>
  projects: DispatchDeviceProject[]
}

export interface DispatchDeviceSync {
  root: string
  state: 'in-sync' | 'behind' | 'ahead' | 'diverged' | 'dirty' | 'missing' | 'unknown'
  ahead: number
  behind: number
  dirty: boolean
}

export interface DeviceDispatchRequest {
  prompt: string
  ticketIds: string[]
  attachments: DispatchAttachment[]
  agent: string
  deviceName: string
  host: string
  secretRef?: string
  projectPath?: string
  repoSlug?: string
  syncPolicy: SyncPolicy
  mode: DispatchMode
  watchdog: WatchdogPolicy
  notify: NotifyPrefs
  batch: 'all' | 'per'
}

export interface DispatchPanelProps {
  open: boolean
  tasks: UnifiedTask[]                 // backlog, for ticket attach + suggestions
  agents: InstalledAgent[]             // from `dispatchData` / agentInventories
  hosts: DispatchHost[]                // from `hostSessions` (widened with load)
  targets: DispatchTarget[]            // ranked projects (local) / repos (cloud)
  prefill?: string                     // seed the context box (⌘K / drag-drop)
  prefillTicketId?: string             // pre-attach a ticket (from backlog)
  onClose: () => void
  onDispatch: (req: DispatchRequest) => void
  // --- draft prompt (optional; when omitted the Draft button is hidden) ---
  onDraftPrompt?: (payload: { tickets: DraftTicketPayload[]; hint: string }) => void
  draftResult?: DraftResult | null     // parent sets when 'draftPromptResult' arrives
  // --- device path (all optional; when omitted the panel behaves as before) ---
  devices?: DispatchDevice[]           // registered devices with live health
  deviceRepos?: DispatchDeviceRepo[]   // ranked repos -> projects (per-host paths)
  deviceSync?: DispatchDeviceSync | null // sync status for the selected repo
  onRequestRepoSync?: (deviceName: string, root: string) => void
  onManageDevices?: () => void
  onDeviceDispatch?: (req: DeviceDispatchRequest) => void
}

interface PanelState {
  prompt: string
  attached: string[]
  attachments: DispatchAttachment[]
  agent: string
  host: string
  project: string
  repo: string
  mode: DispatchMode
  headless: boolean
  watchdog: WatchdogPolicy
  expanded: boolean
  batch: 'all' | 'per'
  branch: string
  notify: NotifyPrefs
  deviceName: string          // '' -> device mode off (use Run on host)
  repoSlug: string            // selected device repo slug
  projectPath: string         // resolved project path on the device
  syncPolicy: SyncPolicy
}

const DEFAULT_NOTIFY: NotifyPrefs = {
  events: { stall: true, question: true, plan: true, finish: true, fail: true },
  channel: 'imessage',
  dnd: false,
}

function initialState(prefill?: string, prefillTicketId?: string): PanelState {
  return {
    prompt: prefill ?? '',
    attached: prefillTicketId ? [prefillTicketId] : [],
    attachments: [],
    agent: '',            // '' -> effective fallback at render (default/signed-in agent)
    host: '',             // '' -> effective fallback (most-used online machine)
    project: '',
    repo: '',
    mode: 'auto',         // locked default
    headless: false,      // default: open a terminal tab; opt into background
    watchdog: 'keep',
    expanded: false,
    batch: 'all',
    branch: 'auto (new branch)',
    notify: DEFAULT_NOTIFY,
    deviceName: '',
    repoSlug: '',
    projectPath: '',
    syncPolicy: 'safe',
  }
}

// Draft persistence so an accidental close (or webview reload) never loses the
// user's selections. Everything except `attachments` (potentially large binary
// blobs) is saved; the draft is cleared once a dispatch actually fires.
const DRAFT_KEY = 'swarmify.dispatch.draft.v1'
function loadDraft(): Partial<PanelState> | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as Partial<PanelState>) : null
  } catch { return null }
}
function saveDraft(s: PanelState): void {
  try {
    const { attachments: _omit, ...rest } = s
    localStorage.setItem(DRAFT_KEY, JSON.stringify(rest))
  } catch { /* quota / unavailable — non-fatal */ }
}
function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY) } catch { /* non-fatal */ }
}

// Seed the panel: restore the saved draft if present, otherwise defaults. When
// opened for a specific ticket, ensure that ticket is attached and seeds the
// prompt even on top of a restored draft.
function seededState(prefill?: string, prefillTicketId?: string): PanelState {
  const base = initialState(prefill, prefillTicketId)
  const draft = loadDraft()
  if (!draft) return base
  const merged: PanelState = { ...base, ...draft, attachments: base.attachments }
  if (prefillTicketId && !merged.attached.includes(prefillTicketId)) {
    merged.attached = [...merged.attached, prefillTicketId]
  }
  if (prefill && !merged.prompt.trim()) merged.prompt = prefill
  return merged
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Local projects carry a `path`; cloud repos don't (dispatch.types contract). */
const isRepo = (t: DispatchTarget) => t.path === undefined

export function DispatchPanel(props: DispatchPanelProps) {
  const {
    open, tasks, agents, hosts, targets, prefill, prefillTicketId, onClose, onDispatch,
    devices, deviceRepos, deviceSync, onRequestRepoSync, onManageDevices, onDeviceDispatch,
    onDraftPrompt, draftResult,
  } = props
  const [S, setS] = useState<PanelState>(() => seededState(prefill, prefillTicketId))
  const [bellOpen, setBellOpen] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bellRef = useRef<HTMLSpanElement>(null)
  useClickAway(bellRef, () => setBellOpen(false), bellOpen)

  // Restore the saved draft + autofocus each time the panel opens (never wipe).
  useEffect(() => {
    if (!open) return
    setS(seededState(prefill, prefillTicketId))
    setBellOpen(false)
    setDrafting(false)
    setDraftError(undefined)
    const id = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Persist the draft on every change so a close/reopen (or reload) keeps it.
  useEffect(() => {
    if (open) saveDraft(S)
  }, [S, open])

  // Draft result from the host: fill the prompt box on success, show an inline
  // error on failure. Keyed on nonce so a repeat delivery still fires the effect.
  useEffect(() => {
    if (!draftResult) return
    setDrafting(false)
    if (draftResult.ok && draftResult.text) {
      setS(s => ({ ...s, prompt: draftResult.text! }))
      setDraftError(undefined)
    } else {
      setDraftError(draftResult.error ?? 'Could not draft a prompt.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftResult?.nonce])

  // Auto-select the local project from the (primary) attached ticket's Linear
  // project. Fires on attach and on (re)open; a `linearProject` match wins, else
  // it falls back to the most-used project. Runs ONLY when a ticket is attached,
  // so a restored draft or manual pick without a ticket is never clobbered; and
  // because it does not depend on S.project it never fights a manual override the
  // user makes afterward. (Harmless in cloud mode — dispatch reads effRepo there.)
  const primaryAttached = S.attached[0]
  useEffect(() => {
    if (!open || !primaryAttached) return
    const localProjects = targets.filter(t => t.path !== undefined)
    if (localProjects.length === 0) return
    const ticket = tasks.find(t => ticketKey(t) === primaryAttached)
    const id = resolveAutoProject(localProjects, ticket?.metadata.project)
    if (id) patch({ project: id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryAttached, open])

  if (!open) return null

  // Ask the host to draft the prompt from the attached tickets. The typed prompt
  // (if any) rides along as a hint the draft should fold in.
  const runDraft = () => {
    if (!onDraftPrompt) return
    const tickets: DraftTicketPayload[] = S.attached
      .map(k => tasks.find(t => ticketKey(t) === k))
      .filter((t): t is UnifiedTask => !!t)
      .map(t => ({ identifier: t.metadata.identifier, title: t.title, description: t.description }))
    if (tickets.length === 0) return
    setDraftError(undefined)
    setDrafting(true)
    onDraftPrompt({ tickets, hint: S.prompt.trim() })
  }

  const patch = (p: Partial<PanelState>) => setS(s => ({ ...s, ...p }))

  // ---- effective selections (fall back to sensible defaults if state is unset or
  //      the chosen id vanished from freshly-loaded props) ----
  const effAgent =
    agents.find(a => a.id === S.agent)
    ?? agents.find(a => a.isDefault)
    ?? agents.find(a => a.signedIn)
    ?? agents[0]

  const mostUsedMachine = [...hosts].filter(h => h.kind !== 'cloud').sort((a, b) => b.uses - a.uses)[0]
  const effHost =
    hosts.find(h => h.id === S.host)
    ?? mostUsedMachine
    ?? suggestedHost(hosts)
    ?? hosts[0]
  const isCloud = effHost?.kind === 'cloud'

  const projects = targets.filter(t => !isRepo(t))
  const repos = targets.filter(isRepo)
  const topBy = (arr: DispatchTarget[]) => [...arr].sort((a, b) => b.uses - a.uses)[0]
  const effProject = projects.find(p => p.id === S.project) ?? topBy(projects)
  const effRepo = repos.find(r => r.id === S.repo) ?? topBy(repos)
  const projectLabel = isCloud ? (effRepo?.label ?? '—') : (effProject?.label ?? '—')

  // ---- device path: active only when a registered device is selected AND the
  //      host has a device-dispatch handler wired (else the panel is unchanged) ----
  const deviceList = devices ?? []
  const effDevice = deviceList.find(d => d.name === S.deviceName)
  const deviceMode = !!(effDevice && onDeviceDispatch && deviceReady(effDevice))
  const selectedRepo = (deviceRepos ?? []).find(r => r.slug === S.repoSlug)

  const attachedCount = S.attached.length
  const bellActive = Object.values(S.notify.events).some(v => !v) || S.notify.dnd

  const doDispatch = () => {
    if (!effAgent) return
    if (deviceMode && effDevice && onDeviceDispatch) {
      if (!S.projectPath) return
      onDeviceDispatch({
        prompt: S.prompt,
        ticketIds: S.attached,
        attachments: S.attachments,
        agent: effAgent.id,
        deviceName: effDevice.name,
        host: effDevice.host,
        secretRef: effDevice.secretRef,
        projectPath: S.projectPath || undefined,
        repoSlug: S.repoSlug || undefined,
        syncPolicy: S.syncPolicy,
        mode: S.mode,
        watchdog: S.watchdog,
        notify: S.notify,
        batch: S.batch,
      })
      clearDraft()
      return
    }
    if (!effHost) return
    const req: DispatchRequest = {
      prompt: S.prompt,
      ticketIds: S.attached,
      attachments: S.attachments,
      agent: effAgent.id,
      runOn: effHost.id,
      project: isCloud ? undefined : effProject?.id,
      repo: isCloud ? effRepo?.id : undefined,
      branch: isCloud ? S.branch : undefined,
      mode: S.mode,
      headless: S.headless,
      watchdog: S.watchdog,
      notify: S.notify,
      batch: S.batch,
    }
    onDispatch(req)
    clearDraft()
  }

  // ---- device repo -> project resolution ----
  // Local host uses the real detected path; a remote device uses its known
  // per-host path if we have one, else the ~/src/github.com/<owner>/<repo>
  // convention (tilde expands on the remote — never the local mac path).
  const pickHostPath = (repo: DispatchDeviceRepo, device: DispatchDevice | undefined): string => {
    const isLocal = !device || device.host === 'this-mac' || device.host === 'localhost' || device.host === ''
    if (isLocal) {
      return repo.perHostPaths['this-mac'] || Object.values(repo.perHostPaths)[0] || `~/src/github.com/${repo.slug}`
    }
    return repo.perHostPaths[device.host] || `~/src/github.com/${repo.slug}`
  }

  const selectDevice = (name: string) => {
    const dev = deviceList.find(d => d.name === name)
    if (dev && selectedRepo) {
      // Default to the repo root; a subdirectory is optional.
      const root = pickHostPath(selectedRepo, dev)
      patch({ deviceName: name, projectPath: root || S.projectPath })
      if (root && onRequestRepoSync) onRequestRepoSync(dev.name, root)
    } else {
      patch({ deviceName: name })
    }
  }

  const selectRepo = (slug: string) => {
    const repo = (deviceRepos ?? []).find(r => r.slug === slug)
    if (!repo) { patch({ repoSlug: slug }); return }
    // Default the project path to the repo root — no subdirectory required.
    const root = pickHostPath(repo, effDevice)
    patch({ repoSlug: slug, projectPath: root || '' })
    if (root && effDevice && onRequestRepoSync) onRequestRepoSync(effDevice.name, root)
  }

  const selectProject = (relPath: string) => {
    if (!selectedRepo) return
    const root = pickHostPath(selectedRepo, effDevice)
    patch({ projectPath: root ? joinPath(root, relPath) : relPath })
  }

  // ---- header ----
  const phsub = attachedCount
    ? `${attachedCount} ticket${attachedCount > 1 ? 's' : ''} + context`
    : 'new agent'

  // ---- footer label ----
  const nCount = (S.batch === 'per' && attachedCount >= 2) ? attachedCount : 1
  const deviceTargetLabel = S.repoSlug || (S.projectPath ? shortPath(S.projectPath) : '—')
  const deviceNeedsRepo = deviceMode && !S.projectPath
  const footLabel = deviceMode && effDevice
    ? (deviceNeedsRepo
        ? `Select a repo to run on ${effDevice.name}`
        : nCount > 1
        ? `Dispatch ${nCount} agents → ${effDevice.name}`
        : `Dispatch ${effAgent?.name ?? 'agent'} → ${deviceTargetLabel} on ${effDevice.name}`)
    : nCount > 1
      ? `Dispatch ${nCount} agents`
      : `Dispatch ${effAgent?.name ?? 'agent'} → ${projectLabel}${S.mode !== 'auto' ? ' · ' + cap(S.mode) : ''}`

  return (
    <div className="dispatch-overlay">
    <div className={`panel${bellOpen ? ' bell' : ''}`} onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
      <div className="ph">
        <span className="t">DISPATCH</span>
        <span className="sub">{phsub}</span>
        <span className="sp" />
        <span
          ref={bellRef}
          className={`icon ${bellActive ? 'act' : ''}`}
          title="Notifications"
          onClick={e => { e.stopPropagation(); setBellOpen(o => !o) }}
        >
          <Bell size={15} />
          <span className="belldot" />
        </span>
        <span className="icon" onClick={onClose}><Icon name="x" size={15} /></span>
      </div>

      <div className="body">
        <DispatchInput
          prompt={S.prompt}
          onPromptChange={v => patch({ prompt: v })}
          attached={S.attached}
          tasks={tasks}
          onAddTicket={k => patch({ attached: S.attached.includes(k) ? S.attached : [...S.attached, k] })}
          onRemoveTicket={k => patch({ attached: S.attached.filter(v => v !== k) })}
          attachments={S.attachments}
          onAddAttachment={a => patch({ attachments: [...S.attachments, a] })}
          onRemoveAttachment={i => patch({ attachments: S.attachments.filter((_, idx) => idx !== i) })}
          onSubmit={doDispatch}
          inputRef={inputRef}
          onDraftPrompt={onDraftPrompt ? runDraft : undefined}
          drafting={drafting}
          draftError={draftError}
        />

        {S.expanded ? (
          <div className="rows">
            <div className="row">
              <span className="lbl">Agent</span>
              <span className="ctl">
                <AgentSelect agents={agents} value={effAgent?.id ?? ''} onChange={id => patch({ agent: id })} />
              </span>
            </div>
            <div className="row">
              <span className="lbl">Run on</span>
              <span className="ctl">
                <HostSelect hosts={hosts} value={effHost?.id ?? ''} onChange={id => patch({ host: id })} />
              </span>
            </div>
            <div className="row">
              <span className="lbl">{isCloud ? 'Repo' : 'Project'}</span>
              <span className="ctl">
                <ProjectSelect
                  items={isCloud ? repos : projects}
                  value={(isCloud ? effRepo?.id : effProject?.id) ?? ''}
                  cloud={isCloud}
                  onChange={id => (isCloud ? patch({ repo: id }) : patch({ project: id }))}
                />
              </span>
            </div>
            <div className="row">
              <span className="lbl">Mode</span>
              <span className="ctl"><ModeSeg value={S.mode} onChange={m => patch({ mode: m })} /></span>
            </div>
            <div className="row">
              <span className="lbl">Surface</span>
              <span className="ctl"><SurfaceSeg headless={S.headless} onChange={h => patch({ headless: h })} /></span>
            </div>
            <div className="row">
              <span className="lbl">Watchdog</span>
              <span className="ctl"><WatchdogSeg value={S.watchdog} onChange={w => patch({ watchdog: w })} /></span>
            </div>
            {deviceList.length > 0 && (
              <div className="row">
                <span className="lbl">Device</span>
                <span className="ctl">
                  <DeviceSelect
                    devices={deviceList}
                    value={S.deviceName}
                    onChange={selectDevice}
                    onManage={onManageDevices}
                  />
                </span>
              </div>
            )}
            {deviceMode && effDevice && (
              <>
                <div className="row">
                  <span className="lbl">Key</span>
                  <span className="ctl">
                    {effDevice.secretRef
                      ? <div className="sub2 mono">key: {effDevice.secretRef}</div>
                      : <div className="sub2">no credentials attached — SSH must resolve from your config</div>}
                  </span>
                </div>
                {(deviceRepos ?? []).length > 0 && (
                  <div className="row">
                    <span className="lbl">Repo</span>
                    <span className="ctl">
                      <DeviceRepoSelect
                        repos={deviceRepos ?? []}
                        value={S.repoSlug}
                        onChange={selectRepo}
                      />
                      {selectedRepo && selectedRepo.projects.length > 1 && (
                        <DeviceProjectSelect
                          projects={selectedRepo.projects}
                          root={pickHostPath(selectedRepo, effDevice)}
                          value={S.projectPath}
                          onChange={selectProject}
                        />
                      )}
                      {S.projectPath && <div className="sub2 mono">{S.projectPath}</div>}
                    </span>
                  </div>
                )}
                <div className="row">
                  <span className="lbl">Sync</span>
                  <span className="ctl"><SyncLine sync={deviceSync ?? null} hasRepo={!!S.repoSlug} /></span>
                </div>
                <div className="row">
                  <span className="lbl">Auto-sync</span>
                  <span className="ctl"><SyncPolicySeg value={S.syncPolicy} onChange={p => patch({ syncPolicy: p })} /></span>
                </div>
              </>
            )}
            <AdvancedOptions
              cloud={isCloud}
              branch={S.branch}
              onBranchChange={b => patch({ branch: b })}
            />
            <div className="collapse" onClick={() => patch({ expanded: false })}>
              <Icon name="chevD" size={12} /> Hide config
            </div>
          </div>
        ) : (
          <div className="summary" onClick={() => patch({ expanded: true })}>
            <span className="dot" />
            <span className="txt">
              <b>{effAgent?.name ?? 'agent'}</b> · {deviceMode && effDevice
                ? `${deviceTargetLabel} on ${effDevice.name}`
                : `${projectLabel} on ${effHost?.label ?? '—'}`} · {cap(S.mode)}
            </span>
            <span className="cfg">Configure <Icon name="chevD" size={12} /></span>
          </div>
        )}

        {attachedCount >= 2 && (
          <BatchToggle count={attachedCount} value={S.batch} onChange={b => patch({ batch: b })} />
        )}
      </div>

      <div className="foot">
        <button className="disp" onClick={doDispatch} disabled={deviceNeedsRepo}>
          <Icon name="zap" size={14} /> {footLabel}<span className="kbd">⌘↵</span>
        </button>
        {effAgent && !effAgent.signedIn && (
          <div className="warn">
            <Icon name="alert" size={13} />
            <span>{effAgent.name} isn&apos;t signed in — you&apos;ll be prompted to <b>agents add {effAgent.id}</b> first.</span>
          </div>
        )}
      </div>

      <NotifyBell prefs={S.notify} onChange={n => patch({ notify: n })} />
    </div>
    </div>
  )
}

// "More options" disclosure — Branch (cloud only) + the extra-context input. The
// extra-context field has no field in DispatchRequest yet (see report); it renders
// to match the prototype but is not wired into the emitted request.
function AdvancedOptions({ cloud, branch, onBranchChange }: {
  cloud: boolean
  branch: string
  onBranchChange: (b: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`adv ${open ? 'open' : ''}`}>
      <div className="adv-h" onClick={() => setOpen(o => !o)}>
        <span className="c"><Icon name="chevR" size={11} /></span> More options
      </div>
      <div className="adv-body">
        {cloud && (
          <div className="field">
            <div className="k">Branch</div>
            <input value={branch} onChange={e => onBranchChange(e.target.value)} />
          </div>
        )}
        <div className="field">
          <div className="k">Repos / extra context passed to the agent</div>
          <input placeholder="optional" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Device path helpers + sub-components (SSH dispatch to a registered machine).
// ---------------------------------------------------------------------------

/** A device is dispatchable when reachable AND under its soft agent limit. */
function deviceReady(d: DispatchDevice): boolean {
  if (!d.reachable) return false
  return !deviceAtLimit(d)
}

function deviceAtLimit(d: DispatchDevice): boolean {
  return d.softLimit !== undefined && (d.runningAgents ?? 0) >= d.softLimit
}

/** Least-busy reachable under-limit device — drives the SUGGESTED badge. */
function suggestedDevice(devices: DispatchDevice[]): DispatchDevice | undefined {
  return devices.filter(deviceReady).sort((a, b) => (a.runningAgents ?? 0) - (b.runningAgents ?? 0))[0]
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/')
}

function joinPath(root: string, relPath: string): string {
  if (!root) return relPath === '.' ? '' : relPath
  return !relPath || relPath === '.' ? root : `${root}/${relPath}`
}

function DeviceLoadBar({ d }: { d: DispatchDevice }) {
  const running = d.runningAgents ?? 0
  const limit = d.softLimit ?? 5
  const filledCount = Math.min(5, Math.ceil((running / Math.max(1, limit)) * 5))
  const hot = deviceAtLimit(d)
  return (
    <span className="loadbar">
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < filledCount ? (hot ? 'hot' : 'f') : ''} />
      ))}
    </span>
  )
}

function DeviceRight({ d }: { d: DispatchDevice }) {
  if (!d.reachable) return <span className="loadtxt busy">offline</span>
  const running = d.runningAgents ?? 0
  const atLimit = deviceAtLimit(d)
  const txt = atLimit
    ? 'At limit'
    : d.softLimit !== undefined
      ? `${running}/${d.softLimit}`
      : `${running} agents`
  return (
    <>
      <DeviceLoadBar d={d} />
      <span className={`loadtxt ${atLimit ? 'busy' : 'free'}`}>{txt}</span>
    </>
  )
}

function DeviceSelect({ devices, value, onChange, onManage }: {
  devices: DispatchDevice[]
  value: string
  onChange: (name: string) => void
  onManage?: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  // Only show reachable devices; offline/pending nodes just clutter the list.
  const online = devices.filter(d => d.reachable)
  const sel = devices.find(d => d.name === value)
  const sug = suggestedDevice(online)

  const pick = (d: DispatchDevice) => {
    if (!deviceReady(d)) return
    onChange(d.name)
    setOpen(false)
  }

  return (
    <>
      <div ref={ref} className={`dd ${open ? 'open' : ''}`}>
        <button className="dd-btn" onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
          <span className={`dot ${sel && sel.reachable ? '' : 'off'}`} />
          <span>{sel ? sel.name : 'Off — run on host above'}</span>
          <span className="right">{sel ? <DeviceRight d={sel} /> : null}</span>
          <span className="caret"><Icon name="chevD" size={13} /></span>
        </button>
        <div className="dd-menu">
          <div className="dd-sec">DEVICES</div>
          <div className={`opt ${!sel ? 'sel' : ''}`} onClick={() => { onChange(''); setOpen(false) }}>
            <span className="dot off" />
            <span className="nm">Off — run on host above</span>
          </div>
          {online.map(d => (
            <div
              key={d.name}
              className={`opt ${d.name === value ? 'sel' : ''} ${!deviceReady(d) ? 'dis' : ''}`}
              onClick={() => pick(d)}
            >
              <span className={`dot ${d.reachable ? '' : 'off'}`} />
              <span className="nm">{d.name}</span>
              {sug && d.name === sug.name ? <span className="badge">SUGGESTED</span> : null}
              <span className="right"><DeviceRight d={d} /></span>
            </div>
          ))}
          {onManage && (
            <div className="opt" onClick={() => { onManage(); setOpen(false) }}>
              <span className="nm" style={{ color: 'var(--brand-600)' }}>Manage devices…</span>
            </div>
          )}
        </div>
      </div>
      <div className="sub2">{sel ? `Runs over SSH on ${sel.host}` : 'Off — dispatch uses the Run on host above'}</div>
    </>
  )
}

function DeviceRepoSelect({ repos, value, onChange }: {
  repos: DispatchDeviceRepo[]
  value: string
  onChange: (slug: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  const ranked = [...repos].sort((a, b) => b.freq - a.freq)
  const sel = ranked.find(r => r.slug === value)
  const top = ranked[0]

  return (
    <div ref={ref} className={`dd ${open ? 'open' : ''}`}>
      <button className="dd-btn" onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
        <span>{sel ? sel.slug : 'Pick a repo'}</span>
        <span className="caret" style={{ marginLeft: 'auto' }}><Icon name="chevD" size={13} /></span>
      </button>
      <div className="dd-menu">
        {ranked.map(r => (
          <div
            key={r.slug}
            className={`opt ${r.slug === value ? 'sel' : ''}`}
            onClick={() => { onChange(r.slug); setOpen(false) }}
          >
            <span className="nm">{r.slug}</span>
            {top && r.slug === top.slug ? <span className="badge used">MOST USED</span> : null}
            <span className="right"><span className="use">{r.freq}×</span></span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DeviceProjectSelect({ projects, root, value, onChange }: {
  projects: DispatchDeviceProject[]
  root: string
  value: string
  onChange: (relPath: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  // The repo root is the default; picking a subdirectory is optional.
  const atRoot = value === root
  const selName = atRoot ? 'whole repo' : (projects.find(p => joinPath(root, p.relPath) === value)?.name ?? 'whole repo')
  const subdirs = projects.filter(p => p.relPath !== '.' && p.relPath !== '')

  return (
    <div ref={ref} className={`dd ${open ? 'open' : ''}`} style={{ marginTop: 6 }}>
      <button className="dd-btn" onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
        <span>Subdirectory (optional): {selName}</span>
        <span className="caret" style={{ marginLeft: 'auto' }}><Icon name="chevD" size={13} /></span>
      </button>
      <div className="dd-menu">
        <div className={`opt ${atRoot ? 'sel' : ''}`} onClick={() => { onChange('.'); setOpen(false) }}>
          <span className="nm">whole repo</span>
          <span className="right"><span className="use">root</span></span>
        </div>
        {subdirs.map(p => (
          <div
            key={p.relPath}
            className={`opt ${joinPath(root, p.relPath) === value ? 'sel' : ''}`}
            onClick={() => { onChange(p.relPath); setOpen(false) }}
          >
            <span className="nm">{p.name}</span>
            <span className="right"><span className="use">{p.relPath}</span></span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SyncLine({ sync, hasRepo }: { sync: DispatchDeviceSync | null; hasRepo: boolean }) {
  if (!hasRepo) return <div className="sub2">pick a repo to check sync status</div>
  if (!sync) return <div className="sub2">checking sync…</div>
  let label: string
  let suffix = ''
  switch (sync.state) {
    case 'in-sync': label = 'in sync'; break
    case 'ahead': label = `${sync.ahead} ahead`; break
    case 'behind': label = `${sync.behind} behind`; suffix = ' — will fetch first'; break
    case 'diverged': label = `diverged (${sync.ahead} ahead, ${sync.behind} behind)`; suffix = ' — will fetch first'; break
    case 'dirty': label = 'uncommitted changes'; break
    case 'missing': label = 'not cloned on this device'; suffix = ' — will clone first'; break
    default: label = 'unknown'
  }
  return (
    <div className="sub2">
      {label}{suffix}
    </div>
  )
}

function SyncPolicySeg({ value, onChange }: { value: SyncPolicy; onChange: (p: SyncPolicy) => void }) {
  const opts: { k: SyncPolicy; label: string }[] = [
    { k: 'off', label: 'Off' },
    { k: 'safe', label: 'Safe' },
    { k: 'aggressive', label: 'Aggressive' },
  ]
  return (
    <span className="seg">
      {opts.map(o => (
        <button key={o.k} className={value === o.k ? 'on' : ''} onClick={() => onChange(o.k)}>{o.label}</button>
      ))}
    </span>
  )
}
