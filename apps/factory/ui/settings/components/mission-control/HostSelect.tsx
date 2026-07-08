// Run-on host picker with LIVE load. Ports the prototype's renderHost() +
// loadBar()/hostRight() (dispatch.html): MACHINES/CLOUD sections, load bars,
// SUGGESTED (least-busy) + MOST USED badges, cloud cost, offline-disabled rows,
// and the busy-host nudge to the free machine.
import React from 'react'
import { useRef, useState } from 'react'
import { Icon } from './icons'
import { useClickAway } from './dispatchIcons'
import type { DispatchHost } from './dispatch.types'

export interface HostSelectProps {
  hosts: DispatchHost[]
  value: string
  onChange: (hostId: string) => void
}

/** Least-busy online machine (non-cloud) — drives the SUGGESTED badge + nudge. */
export function suggestedHost(hosts: DispatchHost[]): DispatchHost | undefined {
  return hosts
    .filter(h => h.kind !== 'cloud' && h.online)
    .sort((a, b) => a.agents - b.agents)[0]
}

/** Most-used online machine (non-cloud) — the demoted MOST USED badge. */
function mostUsedHost(hosts: DispatchHost[]): DispatchHost | undefined {
  return hosts
    .filter(h => h.kind !== 'cloud')
    .sort((a, b) => b.uses - a.uses)[0]
}

function LoadBar({ host }: { host: DispatchHost }) {
  const n = Math.min(5, host.agents || 0)
  return (
    <span className="loadbar">
      {Array.from({ length: 5 }, (_, i) => {
        const filled = i < n
        const cls = filled ? (host.load === 'hot' ? 'hot' : 'f') : ''
        return <i key={i} className={cls} />
      })}
    </span>
  )
}

function HostRight({ host }: { host: DispatchHost }) {
  if (host.kind === 'cloud') {
    return <span className="use">{host.costHint ?? 'usage 60%'}</span>
  }
  if (!host.online) return <span className="loadtxt busy">offline</span>
  const st = host.load === 'idle'
    ? 'idle'
    : host.load === 'free'
      ? `${host.agents} agent · free`
      : `${host.agents} agents · busy`
  return (
    <>
      <LoadBar host={host} />
      <span className={`loadtxt ${host.load === 'busy' ? 'busy' : 'free'}`}>{st}</span>
    </>
  )
}

export function HostSelect({ hosts, value, onChange }: HostSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  const sel = hosts.find(h => h.id === value) ?? hosts[0]
  if (!sel) return null
  const sug = suggestedHost(hosts)
  const most = mostUsedHost(hosts)
  const local = hosts.filter(h => h.kind !== 'cloud')
  const cloud = hosts.filter(h => h.kind === 'cloud')
  const isCloud = sel.kind === 'cloud'
  const busy = sel.kind !== 'cloud' && sel.online && sel.load === 'busy'

  const pick = (h: DispatchHost) => {
    if (!h.online) return
    onChange(h.id)
    setOpen(false)
  }

  const Row = ({ h }: { h: DispatchHost }) => (
    <div
      className={`opt ${h.id === sel.id ? 'sel' : ''} ${h.kind === 'cloud' ? 'cloud' : ''} ${!h.online ? 'dis' : ''}`}
      onClick={() => pick(h)}
    >
      <span className={`dot ${h.online ? '' : 'off'}`} />
      <span className="nm">{h.label}</span>
      {sug && h.id === sug.id
        ? <span className="badge">SUGGESTED</span>
        : (most && h.id === most.id ? <span className="badge used">MOST USED</span> : null)}
      <span className="right"><HostRight host={h} /></span>
    </div>
  )

  const subText = isCloud
    ? 'Cloud runs a fresh clone — local uncommitted changes are not included.'
    : sel.kind === 'remote'
      ? `Runs over SSH on ${sel.label}`
      : 'Runs on this machine'

  return (
    <>
      <div ref={ref} className={`dd ${open ? 'open' : ''}`}>
        <button className="dd-btn" onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
          <span className={`dot ${sel.online ? '' : 'off'}`} />
          <span>{sel.label}</span>
          <span className="right">{isCloud ? null : <HostRight host={sel} />}</span>
          <span className="caret"><Icon name="chevD" size={13} /></span>
        </button>
        <div className="dd-menu">
          <div className="dd-sec">MACHINES</div>
          {local.map(h => <Row key={h.id} h={h} />)}
          <div className="dd-sec">CLOUD</div>
          {cloud.map(h => <Row key={h.id} h={h} />)}
        </div>
      </div>
      <div className="sub2">{subText}</div>
      {busy && sug && (
        <div className="nudge">
          <Icon name="alert" size={13} /> {sel.label} has {sel.agents} agents running — may slow your other apps.
          <span className="go" onClick={() => onChange(sug.id)}>Run on {sug.label} (free)</span>
        </div>
      )}
    </>
  )
}
