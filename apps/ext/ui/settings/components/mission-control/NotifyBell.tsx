// Notify bell popover — the header-bell surface. Ports the prototype's renderBell()
// (dispatch.html): ON EVENTS (Stalled/Needs-input/Plan-ready/Finished/Failed, the
// silent-stall ones emphasized), WHERE (iMessage/Slack/Desktop + integration), DND
// toggle, and the static quiet-hours line.
//
// The `.bellpop` is a direct child of `.panel`; CSS `.panel.bell .bellpop` toggles
// visibility, so DispatchPanel owns the `bell` class + the header bell icon and this
// component renders the popover body.
import React from 'react'
import { Icon } from './icons'
import { Bell } from './dispatchIcons'
import type { NotifyPrefs } from './dispatch.types'

export interface NotifyBellProps {
  prefs: NotifyPrefs
  onChange: (prefs: NotifyPrefs) => void
}

type EventKey = keyof NotifyPrefs['events']
const EVENTS: { key: EventKey; label: string; em?: boolean }[] = [
  { key: 'stall', label: 'Stalled / stopped', em: true },
  { key: 'question', label: 'Needs input' },
  { key: 'plan', label: 'Plan ready', em: true },
  { key: 'finish', label: 'Finished' },
  { key: 'fail', label: 'Failed', em: true },
]
const CHANNELS: NotifyPrefs['channel'][] = ['imessage', 'slack', 'desktop']
const CHANNEL_LABEL: Record<NotifyPrefs['channel'], string> = {
  imessage: 'iMessage',
  slack: 'Slack',
  desktop: 'Desktop',
}

export function NotifyBell({ prefs, onChange }: NotifyBellProps) {
  const toggleEvent = (k: EventKey) =>
    onChange({ ...prefs, events: { ...prefs.events, [k]: !prefs.events[k] } })
  const setChannel = (c: NotifyPrefs['channel']) => onChange({ ...prefs, channel: c })
  const toggleDnd = () => onChange({ ...prefs, dnd: !prefs.dnd })

  return (
    <div className="bellpop" onClick={e => e.stopPropagation()}>
      <div className="bp-h">
        <Bell size={13} />&nbsp;Notify me
        <span className="dnd" onClick={e => { e.stopPropagation(); toggleDnd() }}>
          <span className={`sw ${prefs.dnd ? 'on' : ''}`}><i /></span> DND
        </span>
      </div>
      <div className="bp-sec">ON EVENTS</div>
      {EVENTS.map(({ key, label, em }) => (
        <div
          key={key}
          className={`chk ${prefs.events[key] ? 'on' : ''}`}
          onClick={e => { e.stopPropagation(); toggleEvent(key) }}
        >
          <span className="box">{prefs.events[key] ? <Icon name="check" size={10} /> : null}</span>
          <span className={em ? 'em' : ''}>{label}</span>
        </div>
      ))}
      <div className="bp-sec">WHERE</div>
      <div className="chan">
        {CHANNELS.map(c => (
          <span
            key={c}
            className={`c ${prefs.channel === c ? 'on' : ''}`}
            onClick={e => { e.stopPropagation(); setChannel(c) }}
          >
            {CHANNEL_LABEL[c]}
          </span>
        ))}
        <span className="c">+ integration</span>
      </div>
      <div className="bp-sec">QUIET HOURS</div>
      <div className="chk">
        <span className="mono" style={{ color: 'var(--tx-mut)' }}>10pm – 8am · queue non-urgent</span>
      </div>
    </div>
  )
}
