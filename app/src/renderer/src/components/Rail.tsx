import { useEffect, useId, useState } from 'react'
import { formatRefreshed } from '@shared/format'
import { describeDevice, showRemoteDot, type Presence } from '@shared/remotePresence'
import type { View } from './Sidebar'
import { isWeb, screenOk } from '../web'

/** Stroke icons for the rail (24px grid). */
const ICONS: Record<string, string> = {
  terminals: 'M4 17l6-5-6-5M12 19h8',
  board: 'M3 5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM10 5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1zM17 5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z',
  prs: 'M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 8v8M18 16V9a3 3 0 0 0-3-3h-4',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  costs: 'M12 3v18M16.5 7.5c0-1.9-2-3-4.5-3s-4.5 1.1-4.5 3 2 2.6 4.5 3 4.5 1.1 4.5 3-2 3-4.5 3-4.5-1.1-4.5-3',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  janitor: 'M14 3l7 7M9 8l7 7M4 21l6-6M10 15l-3-3 5-5 5 5-5 5z',
  workflow: 'M5 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 6h10M6 8l5 8M18 8l-5 8',
  broadcast: 'M3 11v2a2 2 0 0 0 2 2h1l5 4V5L6 9H5a2 2 0 0 0-2 2zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14',
  standup: 'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h8M8 12h8M8 16h5',
  skills: 'M12 2l3 6 6 .9-4.5 4.3 1 6.3L12 16.8 6.5 19.5l1-6.3L3 8.9 9 8z',
  palette: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4-4',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
}

export function RailIcon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  )
}

export type RailAction = 'palette' | 'broadcast' | 'standup' | 'skills'

interface Props {
  view: View
  onView: (v: View) => void
  onAction: (a: RailAction) => void
  /** Needs-you items (badge on Terminals). */
  needs: number
  /** PRs waiting on the user (badge on PRs). */
  prAttention: number
  /** Browsers and phones/API clients connected to this Mac right now. */
  remote: Presence[]
  /** Open Settings → Remote. */
  onRemote: () => void
}

/** The blinking amber dot (only while something remote is connected) and its hover/focus card. */
function RemoteIndicator({ remote, onRemote }: { remote: Presence[]; onRemote: () => void }) {
  const [now, setNow] = useState(Date.now)
  const [esc, setEsc] = useState(false)
  const cardId = useId()
  useEffect(() => {
    if (!remote.length) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [remote.length])
  if (!showRemoteDot(remote.length, isWeb())) return null
  const n = remote.length
  return (
    <div
      className={`ri ${esc ? 'esc' : ''}`}
      onMouseEnter={() => (setNow(Date.now()), setEsc(false))}
      onFocus={() => setEsc(false)}
      onKeyDown={(e) => e.key === 'Escape' && setEsc(true)}
    >
      <button
        className="rb"
        aria-label={`${n} remote connection${n === 1 ? '' : 's'} active`}
        aria-describedby={cardId}
        onClick={(e) => {
          e.currentTarget.blur()
          onRemote()
        }}
      >
        <span className="ri-dot" />
      </button>
      <div id={cardId} className="ri-card" role="group" aria-label="Remote connections">
        <div className="ri-box">
        <div className="ri-head">Remote connections ({n})</div>
        {remote.map((r, i) => (
          <div key={`${i}:${r.kind}:${r.id}`} className="ri-row">
            <div className="ri-name">{r.name}</div>
            <div className="ri-sub">{describeDevice(r.device)}</div>
            {r.since > 0 && (
              <div className="ri-sub" title={new Date(r.since).toLocaleString()}>
                connected {formatRefreshed(now - r.since)}
              </div>
            )}
          </div>
        ))}
        </div>
      </div>
    </div>
  )
}

const VIEWS: [View, string, string][] = [
  ['terminals', 'Terminals', '⇧← ⇧→'],
  ['board', 'Board', ''],
  ['prs', 'Pull requests', ''],
  ['tasks', 'Tasks', ''],
]
const TOOLS: [View, string][] = [
  ['costs', 'Costs'],
  ['janitor', 'Janitor'],
  ['workflow', 'Workflow'],
]
const ACTIONS: [RailAction, string, string][] = [
  ['broadcast', 'Broadcast', 'Send one message to several sessions'],
  ['standup', 'Standup', "Yesterday's commits, PRs and reports"],
  ['skills', 'Skills', 'Add or remove skills'],
  ['palette', 'Commands', '⌘K'],
]

/** The Command Center rail: views on top, tools, then actions and Settings at the bottom. */
export function Rail({ view, onView, onAction, needs, prAttention, remote, onRemote }: Props) {
  const viewBtn = (v: View, label: string, hint = '', badge = 0) => (
    <button key={v} className={`rb ${view === v ? 'on' : ''}`} data-tip={hint ? `${label}  ${hint}` : label} aria-label={label} aria-current={view === v ? 'page' : undefined} onClick={() => onView(v)}>
      <RailIcon name={v} />
      {badge > 0 && <span className="rb-badge">{badge}</span>}
    </button>
  )
  return (
    <nav className="rail" aria-label="Views">
      <div className="rail-drag" />
      {VIEWS.filter(([v]) => screenOk(v)).map(([v, label, hint]) => viewBtn(v, label, hint, v === 'terminals' ? needs : v === 'prs' ? prAttention : 0))}
      {TOOLS.some(([v]) => screenOk(v)) && <div className="rail-sep" />}
      {TOOLS.filter(([v]) => screenOk(v)).map(([v, label]) => viewBtn(v, label))}
      <div style={{ flex: 1 }} />
      <RemoteIndicator remote={remote} onRemote={onRemote} />
      {ACTIONS.filter(([a]) => a === 'palette' || screenOk(a)).map(([a, label, hint]) => (
        <button key={a} className="rb" data-tip={`${label} · ${hint}`} aria-label={label} onClick={() => onAction(a)}>
          <RailIcon name={a} />
        </button>
      ))}
      {screenOk('settings') && viewBtn('settings', 'Settings', '⌘,')}
    </nav>
  )
}
