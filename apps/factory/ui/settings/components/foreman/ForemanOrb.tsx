import React, { useEffect, useRef, useState } from 'react'

type ConnState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'
type Activity = 'idle' | 'listening' | 'speaking'
type VisualState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'hibernating'

interface TranscriptLine {
  id: string
  role: 'user' | 'assistant'
  text: string
  final: boolean
  // OpenAI conversation item id — the handle for deleting this utterance
  // from the model's context (conversation.item.delete).
  itemId?: string
}

interface DebugEvent {
  id: string
  eventType: string
  summary: string
  at: number
}

const DEBUG_EVENT_CAP = 30

interface ForemanOrbProps {
  vscode: {
    postMessage: (msg: any) => void
  }
}

const IDLE_CLOSE_MS = 60_000
const IDLE_WARN_MS = 50_000
const SPEAKING_DECAY_MS = 1_500
const TRANSCRIPT_WINDOW = 4

// Press-and-hold threshold. Releases shorter than this are taps (toggle
// start/stop); anything held longer is push-to-talk — the session runs for
// the duration of the hold and ends on release.
const HOLD_MS = 350

// Voice-abort keywords: when any of these appear as a completed user
// transcript, we dispatch foreman.abort so the ForemanCursor cancels any
// in-flight UI sequence. The realtime transcript is emitted with final=true
// at end of utterance, so this fires on completed words — not a partial.
const ABORT_PATTERN = /\b(stop|cancel|wait|nevermind|never mind|abort|no)\b/i

export function ForemanOrb({ vscode }: ForemanOrbProps) {
  const [conn, setConn] = useState<ConnState>('idle')
  const [activity, setActivity] = useState<Activity>('idle')
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [idleCountdown, setIdleCountdown] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([])
  const [debugOpen, setDebugOpen] = useState(true)

  const lastActivityAt = useRef<number>(Date.now())
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTicker = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data
      if (m?.type === 'foreman.status') {
        setConn(m.status)
        if (m.status === 'error') setError(m.detail ?? 'error')
        else if (m.status === 'connecting' || m.status === 'connected') setError(null)
        if (m.status === 'connected') lastActivityAt.current = Date.now()
      } else if (m?.type === 'foreman.transcript') {
        setTranscript((prev) => appendTranscript(prev, m.role, m.text, m.final, m.itemId))
        lastActivityAt.current = Date.now()
        setActivity(m.role === 'assistant' ? 'speaking' : 'listening')
        if (activityTimer.current) clearTimeout(activityTimer.current)
        activityTimer.current = setTimeout(() => setActivity('idle'), SPEAKING_DECAY_MS)

        // Voice-abort: final user utterance matching abort keywords cancels
        // any in-flight UI sequence (cursor animation, pending click, etc).
        if (m.role === 'user' && m.final && typeof m.text === 'string' && ABORT_PATTERN.test(m.text)) {
          window.postMessage({ type: 'foreman.abort' }, '*')
        }
      } else if (m?.type === 'foreman.event') {
        setDebugEvents((prev) => {
          const next = [...prev, {
            id: `${m.at}-${Math.random()}`,
            eventType: String(m.eventType ?? ''),
            summary: String(m.summary ?? ''),
            at: Number(m.at) || Date.now(),
          }]
          return next.length > DEBUG_EVENT_CAP ? next.slice(-DEBUG_EVENT_CAP) : next
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      vscode.postMessage({ type: 'foreman.stopSession' })
    }
  }, [])

  useEffect(() => {
    if (conn !== 'connected') {
      if (idleTicker.current) clearInterval(idleTicker.current)
      idleTicker.current = null
      setIdleCountdown(null)
      return
    }
    idleTicker.current = setInterval(() => {
      const elapsed = Date.now() - lastActivityAt.current
      if (elapsed >= IDLE_CLOSE_MS) {
        handleStop()
        return
      }
      if (elapsed >= IDLE_WARN_MS) {
        setIdleCountdown(Math.max(0, Math.ceil((IDLE_CLOSE_MS - elapsed) / 1000)))
      } else {
        setIdleCountdown(null)
      }
    }, 500)
    return () => {
      if (idleTicker.current) clearInterval(idleTicker.current)
      idleTicker.current = null
    }
  }, [conn])

  // Silent mode: when on, the assistant answers in transcript text only —
  // the extension host drops the PCM instead of piping it to ffplay.
  // Togglable mid-session; the host applies it to the live audio session.
  const [speakerMuted, setSpeakerMuted] = useState(false)

  const toggleSpeaker = () => {
    setSpeakerMuted((muted) => {
      vscode.postMessage({ type: 'foreman.setSpeakerMuted', muted: !muted })
      return !muted
    })
  }

  // Smart mode: type or dictate (Superwhisper types into the focused field) a
  // prompt and submit it to the text brain. Replies stream back over the same
  // foreman.transcript channel the realtime engine uses, so they render in the
  // transcript above. Enter submits; Shift+Enter inserts a newline.
  const [smartInput, setSmartInput] = useState('')
  const submitSmart = () => {
    const text = smartInput.trim()
    if (!text) return
    vscode.postMessage({ type: 'foreman.smartTurn', text })
    setSmartInput('')
    lastActivityAt.current = Date.now()
  }

  // Excise an utterance: server-side conversation.item.delete (so a bad
  // transcription stops steering follow-up answers) plus local removal.
  const deleteLine = (line: TranscriptLine) => {
    if (line.itemId) vscode.postMessage({ type: 'foreman.deleteItem', itemId: line.itemId })
    setTranscript((prev) => prev.filter((l) => l.id !== line.id))
  }

  const handleStart = () => {
    setError(null)
    setTranscript([])
    setDebugEvents([])
    setConn('connecting')
    lastActivityAt.current = Date.now()
    vscode.postMessage({ type: 'foreman.startSession', speakerMuted })
  }

  const handleStop = () => {
    vscode.postMessage({ type: 'foreman.stopSession' })
    setConn('closed')
    setIdleCountdown(null)
    setActivity('idle')
  }

  // Two interaction modes off one button:
  //   tap  — toggle: starts the session if idle, stops it if running
  //   hold — push-to-talk: session starts on press (connection latency
  //          overlaps the hold) and ends the moment the finger lifts
  // Start fires on pointerDOWN in both modes so a hold never waits for the
  // release to begin connecting; the release decides tap-vs-hold semantics.
  const pressedAt = useRef<number | null>(null)
  const wasActiveAtPress = useRef(false)

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pressedAt.current = Date.now()
    wasActiveAtPress.current = conn === 'connected' || conn === 'connecting'
    if (!wasActiveAtPress.current) handleStart()
  }

  const handlePointerUp = () => {
    if (pressedAt.current === null) return
    const heldMs = Date.now() - pressedAt.current
    pressedAt.current = null

    if (heldMs >= HOLD_MS) {
      // Push-to-talk release: end the session.
      handleStop()
      return
    }

    // Tap. If it started the session on press, leave it running (toggle on).
    if (!wasActiveAtPress.current) return
    // Tap on a running session: wake from hibernation warning, else stop.
    if (idleCountdown !== null) {
      lastActivityAt.current = Date.now()
      setIdleCountdown(null)
      return
    }
    handleStop()
  }

  const visualState: VisualState =
    conn === 'connecting' ? 'connecting' :
    conn === 'connected' && idleCountdown !== null ? 'hibernating' :
    conn === 'connected' ? activity :
    'idle'

  const latestLines = transcript.slice(-TRANSCRIPT_WINDOW)
  // Show the transcript for smart-mode replies too (which arrive with no
  // realtime "connection"), not just during a live voice session.
  const showTranscript = latestLines.length > 0 && idleCountdown === null

  return (
    <div
      className="foreman-orb-root"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 10,
        pointerEvents: 'none',
      }}
    >
      {showTranscript && (
        <div className="foreman-orb-transcript">
          {latestLines.map((line) => (
            <div
              key={line.id}
              className="foreman-orb-line"
              style={{ opacity: line.final ? 1 : 0.65 }}
            >
              <span className={`foreman-orb-role ${line.role === 'user' ? 'you' : 'frmn'}`}>
                {line.role === 'user' ? 'YOU' : 'FRMN'}
              </span>
              <span>{line.text}</span>
              {line.final && line.itemId && (
                <button
                  className="foreman-orb-line-delete"
                  onClick={() => deleteLine(line)}
                  title="Remove this message from the conversation context"
                  aria-label="Delete message"
                >
                  x
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {idleCountdown !== null && (
        <div className="foreman-orb-hint">
          Sleeping in {idleCountdown}s · tap to keep
        </div>
      )}

      {error && (
        <div className="foreman-orb-error">{error}</div>
      )}

      {conn !== 'idle' && debugEvents.length > 0 && (
        <DebugLogPanel
          events={debugEvents}
          open={debugOpen}
          onToggle={() => setDebugOpen((o) => !o)}
        />
      )}

      <button
        className={`foreman-orb foreman-orb-${visualState}`}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-label={`Foreman ${visualState}`}
        title={orbTitle(visualState)}
      >
        <OrbBlob state={visualState} />
      </button>

      <button
        className={`foreman-orb-speaker ${speakerMuted ? 'is-muted' : ''}`}
        onClick={toggleSpeaker}
        title={speakerMuted ? 'Silent mode — answers in text only. Click for voice.' : 'Voice replies on. Click for silent mode.'}
      >
        {speakerMuted ? 'silent' : 'voice'}
      </button>

      <textarea
        className="foreman-orb-smart-input"
        value={smartInput}
        onChange={(e) => setSmartInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submitSmart()
          }
        }}
        placeholder="Ask Foreman… (type or dictate, Enter to send)"
        rows={1}
        aria-label="Ask Foreman in smart mode"
        style={{
          pointerEvents: 'auto',
          width: 260,
          maxWidth: '60vw',
          resize: 'none',
          background: 'rgba(0,0,0,0.55)',
          color: '#e6edf3',
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 10,
          padding: '8px 11px',
          fontFamily: 'inherit',
          fontSize: 12.5,
          lineHeight: 1.4,
          outline: 'none',
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        }}
      />
    </div>
  )
}

function DebugLogPanel({ events, open, onToggle }: { events: DebugEvent[]; open: boolean; onToggle: () => void }) {
  const recent = events.slice(-12)
  const baseTime = events[0]?.at ?? Date.now()
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = events
      .map((ev) => `+${((ev.at - baseTime) / 1000).toFixed(1)}s  ${ev.eventType.padEnd(48)} ${ev.summary}`)
      .join('\n')
    navigator.clipboard?.writeText(text).catch(() => { /* noop */ })
  }
  return (
    <div
      style={{
        pointerEvents: 'auto',
        background: 'rgba(0,0,0,0.78)',
        color: '#d4f7d4',
        padding: '6px 8px',
        borderRadius: 6,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 10,
        lineHeight: 1.35,
        maxWidth: 380,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: open ? 4 : 0 }}>
        <strong style={{ color: '#9be39b', fontSize: 9, letterSpacing: 0.6 }}>FOREMAN EVENTS ({events.length})</strong>
        <span style={{ flex: 1 }} />
        <button onClick={handleCopy} style={debugBtnStyle} title="Copy all events">copy</button>
        <button onClick={onToggle} style={debugBtnStyle}>{open ? 'hide' : 'show'}</button>
      </div>
      {open && recent.map((ev) => (
        <div key={ev.id} style={{ display: 'flex', gap: 6, opacity: ev.eventType.startsWith('error') || ev.eventType === 'ws.error' ? 1 : 0.92 }}>
          <span style={{ color: '#5fa55f', minWidth: 38 }}>+{((ev.at - baseTime) / 1000).toFixed(1)}s</span>
          <span style={{ color: eventColor(ev.eventType), minWidth: 0, whiteSpace: 'nowrap' }}>{ev.eventType}</span>
          {ev.summary && <span style={{ color: '#a6c8a6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.summary}</span>}
        </div>
      ))}
    </div>
  )
}

const debugBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#9be39b',
  border: '1px solid rgba(155,227,155,0.3)',
  borderRadius: 3,
  padding: '1px 6px',
  cursor: 'pointer',
  fontSize: 9,
  fontFamily: 'inherit',
}

function eventColor(t: string): string {
  if (t === 'error' || t.endsWith('.failed') || t.endsWith('.error') || t.endsWith('.stderr')) return '#ff7878'
  if (t === 'session.created' || t === 'session.updated' || t === 'ws.open') return '#9be39b'
  if (t.includes('transcription')) return '#ffd479'
  if (t.includes('audio_transcript')) return '#79d4ff'
  if (t === 'response.done') return '#c79bff'
  if (t.startsWith('mic.')) return '#888'
  if (t.startsWith('speaker.')) return '#d4b86a'
  return '#cfe6cf'
}

function appendTranscript(
  prev: TranscriptLine[],
  role: 'user' | 'assistant',
  text: string,
  final: boolean,
  itemId?: string,
): TranscriptLine[] {
  if (!text) return prev
  const last = prev[prev.length - 1]
  if (last && last.role === role && !last.final) {
    const updated = { ...last, text: final ? text : last.text + text, final, itemId: itemId ?? last.itemId }
    return [...prev.slice(0, -1), updated]
  }
  return [...prev, { id: `${role}-${Date.now()}-${Math.random()}`, role, text, final, itemId }]
}

function orbTitle(state: VisualState): string {
  switch (state) {
    case 'idle': return 'Foreman — tap to talk, or hold to talk while pressed'
    case 'connecting': return 'Connecting...'
    case 'listening': return 'Listening — tap to stop'
    case 'speaking': return 'Speaking — tap to stop'
    case 'hibernating': return 'Sleeping soon — tap to keep'
  }
}

function OrbBlob({ state }: { state: VisualState }) {
  const big = state === 'listening' || state === 'speaking' || state === 'connecting'
  // Corner-FAB sizing (mockup): a compact resting orb that still grows while active,
  // so Foreman reads as a tucked affordance rather than dominating the floor.
  const size = big ? 56 : 40
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={`foreman-orb-svg foreman-orb-svg-${state}`}
    >
      <defs>
        <radialGradient id="foreman-orb-grad" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="var(--ds-accent, #4a90e2)" stopOpacity="0.95" />
          <stop offset="55%" stopColor="var(--ds-accent, #4a90e2)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--ds-accent, #4a90e2)" stopOpacity="0.1" />
        </radialGradient>
      </defs>
      <circle
        className="foreman-orb-ring"
        cx="50"
        cy="50"
        r="46"
        fill="none"
        stroke="var(--ds-accent, #4a90e2)"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      <circle
        className="foreman-orb-outer"
        cx="50"
        cy="50"
        r="40"
        fill="url(#foreman-orb-grad)"
      />
      <circle
        className="foreman-orb-inner"
        cx="50"
        cy="50"
        r="22"
        fill="url(#foreman-orb-grad)"
      />
    </svg>
  )
}
