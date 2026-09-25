import { useEffect, useMemo, useRef, useState } from 'react'
import { MASTER_NAME, sessionForIssue } from '@shared/derive'
import { rank } from '@shared/fuzzy'
import type { AppState, Issue, Session } from '@shared/types'

export type PaletteAction =
  | 'refresh'
  | 'view:terminals'
  | 'view:board'
  | 'view:prs'
  | 'view:costs'
  | 'view:janitor'
  | 'view:history'
  | 'broadcast'
  | 'standup'
  | 'sprint-summary'
  | 'settings'
  | 'new-shell'
  | 'start-master'

interface Item {
  id: string
  group: 'Action' | 'Session' | 'Issue' | 'PR'
  label: string
  hint: string
  run: () => void
}

interface Props {
  state: AppState
  onClose: () => void
  onAction: (a: PaletteAction) => void
  onOpenSession: (s: Session) => void
  onIssue: (i: Issue) => void
  onPr: (url: string, issue: number | null, title: string) => void
}

const ACTIONS: [PaletteAction, string, string][] = [
  ['refresh', 'Refresh from GitHub', 'issues, PRs and the board'],
  ['view:terminals', 'Go to Terminals', 'view'],
  ['view:board', 'Go to Board View', 'view'],
  ['view:prs', 'Go to PRs', 'my PRs, review queue'],
  ['view:costs', 'Go to Costs', 'spend per day, ticket, session'],
  ['view:janitor', 'Go to Janitor', 'worktrees and parked sessions'],
  ['view:history', 'Search session history', 'full-text over transcripts'],
  ['broadcast', 'Broadcast a message…', 'to several sessions'],
  ['standup', 'Standup…', "yesterday's commits, PRs and reports"],
  ['sprint-summary', 'Sprint summary…', 'done, in progress, blocked, burndown'],
  ['settings', 'Settings…', 'nudges, budget, context, dock'],
  ['new-shell', 'New shell tab', 'terminal'],
  ['start-master', 'Start master-agent', 'when it is not running'],
]

export function CommandPalette({ state, onClose, onAction, onOpenSession, onIssue, onPr }: Props) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const all = useMemo<Item[]>(() => {
    const done = (fn: () => void) => () => {
      onClose()
      fn()
    }
    const items: Item[] = ACTIONS.filter(([id]) => id !== 'start-master' || state.config.masterEnabled).map(([id, label, hint]) => ({ id: `a:${id}`, group: 'Action', label, hint, run: done(() => onAction(id)) }))
    for (const s of state.sessions) {
      if (s.state === 'done' || s.name === MASTER_NAME) continue
      items.push({
        id: `s:${s.key}`,
        group: 'Session',
        label: s.name,
        hint: `${s.issue !== null ? `#${s.issue} · ` : ''}${s.state}${s.kind === 'interactive' ? ' · other terminal' : ''}`,
        run: done(() => onOpenSession(s)),
      })
    }
    const issues = new Map<number, Issue>()
    for (const i of state.issues) issues.set(i.number, i)
    for (const c of state.board?.cards ?? [])
      if (!issues.has(c.number)) issues.set(c.number, { number: c.number, title: c.title, url: c.url, status: c.status, currentSprint: true, assignedToMe: state.me ? c.assignees.includes(state.me) : false })
    for (const i of issues.values()) {
      const s = sessionForIssue(state.sessions, i.number)
      items.push({ id: `i:${i.number}`, group: 'Issue', label: `#${i.number} ${i.title}`, hint: s ? `open ${s.name}` : (i.status ?? 'start a session'), run: done(() => (s ? onOpenSession(s) : onIssue(i))) })
    }
    for (const p of state.prs) {
      items.push({
        id: `p:${p.url}`,
        group: 'PR',
        label: `${p.repo}#${p.number} ${p.title}`,
        hint: p.refsIssue ? `#${p.refsIssue}` : 'PR',
        run: done(() => onPr(p.url, p.refsIssue, p.title)),
      })
    }
    return items
  }, [state, onClose, onAction, onOpenSession, onIssue, onPr])

  const shown = useMemo(() => rank(q, all, (i) => `${i.label} ${i.hint}`, 60), [q, all])
  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.pal-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      setSel((i) => Math.min(shown.length - 1, i + 1))
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setSel((i) => Math.max(0, i - 1))
      e.preventDefault()
    } else if (e.key === 'Enter') shown[sel]?.run()
  }

  return (
    <div className="backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Jump to a session, issue or PR, or run an action…" spellCheck={false} />
        <div className="pal-list" ref={listRef}>
          {shown.length === 0 && <div className="empty">No match.</div>}
          {shown.map((it, i) => (
            <div key={it.id} className={`pal-row ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={it.run}>
              <span className={`pal-group g-${it.group.toLowerCase()}`}>{it.group}</span>
              <span className="label">{it.label}</span>
              <span className="sub">{it.hint}</span>
            </div>
          ))}
        </div>
        <div className="pal-foot">↑↓ to move · ↵ to open · esc to close</div>
      </div>
    </div>
  )
}
