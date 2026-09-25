import { getConfig, statusRank } from './appConfig'
import { sessionForIssue } from './derive'
import type { Badge, Board, BoardCard, BoardPr, Proposal, Session } from './types'

/** Columns shown even when empty: the workflow from "ready" to "dev done", in board order. */
export function alwaysColumns(c = getConfig()): string[] {
  const s = c.statuses
  const want = new Set([...s.assignable.filter((x) => statusRank(x, c) <= statusRank(s.ready, c)), s.ready, s.inProgress, s.prRaised, s.devDone])
  const inBoard = c.columns.filter((x) => want.has(x))
  return inBoard.length ? inBoard : [...want]
}
export const NO_STATUS = 'No status'

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

const CI = new Set(['success', 'failure', 'pending'])

/** Parse `master board` output. Null for anything that isn't a board. */
export function parseBoard(raw: unknown): Board | null {
  const r = obj(raw)
  if (!Array.isArray(r.cards)) return null
  const cards: BoardCard[] = []
  for (const c of arr(r.cards).map(obj)) {
    if (typeof c.number !== 'number') continue
    const prs: BoardPr[] = []
    for (const p of arr(c.prs).map(obj)) {
      const url = str(p.url)
      if (!url || typeof p.number !== 'number') continue
      prs.push({
        url,
        repo: str(p.repo) ?? '',
        number: p.number,
        state: str(p.state),
        ci: CI.has(p.ci as string) ? (p.ci as BoardPr['ci']) : null,
        unresolved: typeof p.unresolved === 'number' ? p.unresolved : 0,
      })
    }
    const strs = (v: unknown) => arr(v).filter((x): x is string => typeof x === 'string')
    cards.push({
      number: c.number,
      title: str(c.title) ?? `#${c.number}`,
      url: str(c.url) ?? '',
      status: str(c.status),
      prs,
      assignees: strs(c.assignees),
      labels: strs(c.labels),
      milestone: str(c.milestone),
      type: str(c.type),
    })
  }
  const columns = arr(r.columns).filter((x): x is string => typeof x === 'string')
  return { takenAt: str(r.taken_at), sprint: str(r.sprint), columns: columns.length ? columns : alwaysColumns(), cards }
}

/** Always the five workflow columns; any other only when it has a card; "No status" first when needed. */
export function visibleColumns(b: Board): string[] {
  const used = new Set(b.cards.map((c) => c.status))
  const cols = b.columns.filter((c) => alwaysColumns().includes(c) || used.has(c))
  for (const c of alwaysColumns()) if (!cols.includes(c)) cols.push(c)
  for (const s of used) if (s && !cols.includes(s)) cols.push(s)
  return used.has(null) ? [NO_STATUS, ...cols] : cols
}

export function cardsIn(b: Board, column: string): BoardCard[] {
  return b.cards.filter((c) => (column === NO_STATUS ? c.status === null : c.status === column))
}

const LABEL: Record<Badge['kind'], string> = {
  question: 'Question',
  blocked: 'Blocked',
  'needs-input': 'Needs input',
  onboarding: 'Onboarding',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
  none: 'No session',
}

function badge(kind: Badge['kind'], detail?: string | null): Badge {
  return detail ? { kind, label: LABEL[kind], detail } : { kind, label: LABEL[kind] }
}

/**
 * The Claude task state of an issue, first match wins: question, blocked, needs input, onboarding,
 * working, done, idle, no session.
 */
export function cardBadge(issue: number, sessions: Session[], proposals: Proposal[]): Badge {
  const mine = proposals.filter((p) => p.issue === issue && p.kind !== 'CHAT').sort((a, b) => b.id - a.id)
  const q = mine.find((p) => p.status === 'question')
  if (q) return badge('question', q.note)
  const bl = mine.find((p) => p.status === 'blocked')
  if (bl) return badge('blocked', bl.note)
  const s = sessionForIssue(sessions, issue)
  if (s?.state === 'needs-input') return badge('needs-input')
  const assign = mine.find((p) => p.kind === 'ASSIGN' && p.status !== 'rejected')
  // Spawning, or spawned but not yet linked to the issue (babysit-ticket does that while setting up).
  if (assign && (assign.status === 'approved' || (assign.status === 'sent' && !s))) return badge('onboarding')
  if (s?.state === 'working') return badge('working')
  if (assign?.status === 'done') return badge('done', assign.note)
  if (s) return badge('idle')
  return badge('none')
}
