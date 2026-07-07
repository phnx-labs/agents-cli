import React, { useState } from 'react'
import { Icon } from './icons'
import type { HostInventory, HostAgentVersion } from './floorModel'

// Host detail + configure pane. Opens when a host is clicked in FloorSidebar.
// Shows registry metadata and configure actions (enroll / remove / caps), plus
// the installed agents/versions/accounts/usage/resource-drift fetched from
// `agents view --host <name> --json --resources all`. No decorative glyphs —
// status is conveyed with the .hd CSS dot and plain text.

interface HostDetailProps {
  host: string
  /** null = still loading; otherwise the fetched inventory (reachable or not). */
  inventory: HostInventory | null
  configError: string | null
  onRefresh: () => void
  onEnroll: (caps: string[]) => void
  onRemove: () => void
  onDispatch: () => void
}

function agentLabel(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}

function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function usageClass(pct: number): string {
  return pct >= 85 ? 'crit' : pct >= 60 ? 'hi' : ''
}

function VersionRow({ v }: { v: HostAgentVersion }) {
  return (
    <div className="host-ver">
      <span className="host-ver-v">
        <span className="mono">{v.version}</span>
        {v.isDefault ? <span className="host-tag">default</span> : null}
      </span>
      <span className="host-ver-acct">
        {v.signedIn ? (
          <>
            {v.email ?? 'signed in'}
            {v.plan ? <span className="host-plan">{v.plan}</span> : null}
          </>
        ) : (
          <span className="host-unsigned">not signed in</span>
        )}
      </span>
      <span className="host-ver-usage">
        {v.sessionPercent != null && (
          <span className="host-bar" title={`session ${v.sessionPercent}%`}>
            S<span className="host-track"><span className={`host-fill ${usageClass(v.sessionPercent)}`} style={{ width: `${Math.min(100, v.sessionPercent)}%` }} /></span>
          </span>
        )}
        {v.weekPercent != null && (
          <span className="host-bar" title={`week ${v.weekPercent}%`}>
            W<span className="host-track"><span className={`host-fill ${usageClass(v.weekPercent)}`} style={{ width: `${Math.min(100, v.weekPercent)}%` }} /></span>
          </span>
        )}
      </span>
      <span className="host-ver-drift">
        {v.resources
          ? v.resources.drift > 0
            ? <span className="host-drift-warn">{v.resources.drift} drifted</span>
            : <span className="host-drift-ok">synced</span>
          : null}
      </span>
    </div>
  )
}

export function HostDetail({ host, inventory, configError, onRefresh, onEnroll, onRemove, onDispatch }: HostDetailProps) {
  const [capsInput, setCapsInput] = useState('')

  const meta = inventory?.meta ?? null
  const reachable = inventory?.reachable ?? false
  const loading = inventory === null
  const online = reachable || meta?.status === 'online'

  const parseCaps = () => capsInput.split(',').map((c) => c.trim()).filter(Boolean)

  return (
    <>
      <div className="dhead" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className={`hd ${online ? '' : 'off'}`} />
          <span className="title mono">{host}</span>
          <span className="host-status">{loading ? 'checking' : online ? 'online' : 'offline'}</span>
          {meta?.target && <span className="sub mono">{meta.target}</span>}
        </div>
        <button className="host-btn" onClick={onRefresh} disabled={loading}>
          <Icon name="refresh" size={12} /> Refresh
        </button>
      </div>

      <div className="dbody">
        {!loading && !reachable && (
          <div className="host-offline-note">
            Unreachable over SSH{inventory?.error ? ` — ${inventory.error}` : ''}. Showing last-known registry info.
          </div>
        )}

        {/* Configure */}
        <div>
          <div className="lbl">Configure</div>
          <div className="dispatch-panel">
            <div className="host-meta-grid">
              <span className="host-meta-k">Source</span>
              <span className="host-meta-v">{meta?.source ?? 'not enrolled'}</span>
              <span className="host-meta-k">Target</span>
              <span className="host-meta-v mono">{meta?.target ?? host}</span>
              {meta?.os && (<><span className="host-meta-k">OS</span><span className="host-meta-v">{meta.os}</span></>)}
              <span className="host-meta-k">Enrolled</span>
              <span className="host-meta-v">{meta?.enrolled ? 'yes' : 'no'}</span>
              <span className="host-meta-k">Capabilities</span>
              <span className="host-meta-v">
                {meta?.caps && meta.caps.length > 0
                  ? meta.caps.map((c) => <span key={c} className="host-cap">{c}</span>)
                  : <span className="host-dim">none</span>}
              </span>
            </div>

            <div className="host-config-actions">
              <input
                className="host-caps-input"
                placeholder="caps for enroll (e.g. gpu, fast)"
                value={capsInput}
                onChange={(e) => setCapsInput(e.target.value)}
              />
              <button className="host-btn primary" onClick={() => onEnroll(parseCaps())}>
                {meta?.enrolled ? 'Update' : 'Enroll'}
              </button>
              {meta?.enrolled && (
                <button className="host-btn danger" onClick={onRemove}>Remove host</button>
              )}
            </div>
            {configError && <div className="host-config-error">{configError}</div>}
          </div>
        </div>

        {/* Installed agents */}
        <div>
          <div className="lbl">
            Installed agents
            {inventory && <span className="host-fetched"> · fetched {timeAgo(new Date(inventory.fetchedAt).toISOString())}</span>}
          </div>
          {loading ? (
            <div className="host-dim">Loading inventory from {host}…</div>
          ) : inventory && inventory.agents.length > 0 ? (
            inventory.agents.map((ag) => {
              const res = ag.versions.find((v) => v.resources)?.resources ?? null
              return (
                <div key={ag.agent} className="host-agent">
                  <div className="host-agent-h">
                    <span className="host-agent-nm">{agentLabel(ag.agent)}</span>
                    <span className="host-agent-c">{ag.versions.length} version{ag.versions.length > 1 ? 's' : ''}</span>
                  </div>
                  {res && (
                    <div className="host-res-row">
                      <span className="host-res"><b>{res.skills}</b> skills</span>
                      <span className="host-res"><b>{res.plugins}</b> plugins</span>
                      <span className="host-res"><b>{res.mcp}</b> mcp</span>
                      <span className="host-res"><b>{res.commands}</b> commands</span>
                      <span className="host-res"><b>{res.workflows}</b> workflows</span>
                    </div>
                  )}
                  {ag.versions.map((v) => <VersionRow key={v.version} v={v} />)}
                </div>
              )
            })
          ) : (
            <div className="host-dim">
              {reachable ? 'No agent CLIs installed on this host.' : 'Inventory unavailable while the host is unreachable.'}
            </div>
          )}
        </div>

        {reachable && (
          <div className="host-config-actions">
            <button className="host-btn primary" onClick={onDispatch}>Dispatch here</button>
          </div>
        )}
      </div>
    </>
  )
}
