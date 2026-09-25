import type { Issue, MasterState, NeedsItem, Pr, Proposal, Session } from './types'

export const MASTER_NAME = 'master-agent'

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function s(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export interface ParsedSnapshot {
  issues: Issue[]
  prs: Pr[]
  sessionIssue: Map<string, number>
  /** PR URLs babysit-ticket linked to each session. */
  sessionPrs: Map<string, string[]>
  sources: Record<string, boolean>
  takenAt: string | null
}

export function parseSnapshot(raw: unknown): ParsedSnapshot {
  const r = obj(raw)
  const issues: Issue[] = []
  for (const i of arr(r.issues).map(obj)) {
    const number = n(i.number)
    if (number === null) continue
    issues.push({
      number,
      title: s(i.title) ?? `#${number}`,
      url: s(i.url) ?? '',
      status: s(i.status),
      currentSprint: i.current_sprint === true,
      assignedToMe: i.assigned_to_me !== false,
    })
  }
  const prs: Pr[] = []
  for (const p of arr(r.prs).map(obj)) {
    const number = n(p.number)
    const url = s(p.url)
    if (number === null || !url) continue
    prs.push({
      url,
      repo: s(p.repo) ?? '',
      number,
      title: s(p.title) ?? '',
      unresolvedThreads: n(p.unresolved_threads) ?? 0,
      ci: s(p.ci),
      headRef: s(p.head_ref) ?? '',
      refsIssue: n(p.refs_issue),
      authorIsMe: p.author_is_me === true,
      reviewRequested: p.review_requested === true,
      updatedAt: s(p.updated_at),
    })
  }
  const sessionIssue = new Map<string, number>()
  const sessionPrs = new Map<string, string[]>()
  for (const x of arr(r.sessions).map(obj)) {
    const id = s(x.session_id)
    const issue = n(x.issue)
    if (id && issue !== null) sessionIssue.set(id, issue)
    const prs = arr(x.prs).filter((u): u is string => typeof u === 'string' && /\/pull\/\d+$/.test(u))
    if (id && prs.length) sessionPrs.set(id, prs)
  }
  const sources: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(obj(r.sources))) sources[k] = v === true
  return { issues, prs, sessionIssue, sessionPrs, sources, takenAt: s(r.taken_at) }
}

export function parseLedger(raw: unknown): { proposals: Proposal[]; lastSnapshot: unknown } {
  const r = obj(raw)
  const proposals: Proposal[] = []
  for (const p of arr(r.proposals).map(obj)) {
    const id = n(p.id)
    if (id === null) continue
    const t = obj(p.target)
    const spawn = obj(t.spawn)
    proposals.push({
      id,
      kind: s(p.kind) ?? '?',
      issue: n(p.issue) ?? 0,
      status: s(p.status) ?? '?',
      summary: s(p.summary) ?? '',
      message: s(p.message) ?? '',
      note: s(p.note),
      closedAt: s(p.closed_at),
      target: {
        session: s(t.session) ?? undefined,
        spawn: s(spawn.name)
          ? {
              name: s(spawn.name)!,
              cwd: s(spawn.cwd) ?? undefined,
              prompt: s(spawn.prompt) ?? undefined,
              resume: s(spawn.resume) ?? undefined,
            }
          : undefined,
      },
    })
  }
  return { proposals, lastSnapshot: r.last_snapshot ?? null }
}

export function attachIssues(sessions: Session[], sessionIssue: Map<string, number>): Session[] {
  return sessions.map((x) => ({ ...x, issue: sessionIssue.get(x.sessionId) ?? null }))
}

function live(x: Session): boolean {
  return x.state !== 'done'
}

/** The session that owns issue n: not done, background preferred, then the newest. */
export function sessionForIssue(sessions: Session[], issue: number): Session | null {
  const c = sessions.filter((x) => x.issue === issue && live(x) && x.name !== MASTER_NAME)
  c.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'background' ? -1 : 1
    return b.startedAt - a.startedAt
  })
  return c[0] ?? null
}

export function deriveMaster(sessions: Session[]): MasterState {
  const rows = sessions.filter((x) => x.name === MASTER_NAME && live(x))
  if (rows.length > 1) return { kind: 'duplicate', count: rows.length }
  if (rows.length === 0) return { kind: 'absent' }
  const m = rows[0]
  return m.kind === 'background' && m.bgId ? { kind: 'attached', session: m } : { kind: 'elsewhere', session: m }
}

const ATTENTION = new Set(['question', 'blocked', 'held'])

export function deriveNeedsYou(proposals: Proposal[], sessions: Session[]): NeedsItem[] {
  const proposed = proposals.filter((p) => p.status === 'proposed').sort((a, b) => b.id - a.id)
  const attention = proposals.filter((p) => ATTENTION.has(p.status)).sort((a, b) => b.id - a.id)
  const waiting = sessions.filter((x) => x.state === 'needs-input' && x.name !== MASTER_NAME)
  return [
    ...proposed.map((proposal): NeedsItem => ({ kind: 'proposal', proposal })),
    ...attention.map((proposal): NeedsItem => ({ kind: 'attention', proposal })),
    ...waiting.map((session): NeedsItem => ({ kind: 'session', session })),
  ]
}

/** An ASSIGN proposal for issue n that has not been dispatched yet. */
export function pendingAssign(proposals: Proposal[], issue: number): Proposal | null {
  const c = proposals.filter((p) => p.kind === 'ASSIGN' && p.issue === issue && (p.status === 'proposed' || p.status === 'approved'))
  c.sort((a, b) => b.id - a.id)
  return c[0] ?? null
}

export type IssueMark = 'session' | 'pending' | 'none'

export function issueSessionMark(issue: number, sessions: Session[], proposals: Proposal[]): IssueMark {
  if (sessionForIssue(sessions, issue)) return 'session'
  const p = pendingAssign(proposals, issue)
  return p && p.status === 'approved' ? 'pending' : 'none'
}

/** The session a proposal is about: its target session, or the owner of its issue. */
export function sessionForProposal(p: Proposal, sessions: Session[]): Session | null {
  if (p.target.session) {
    const byName = sessions.find((x) => x.name === p.target.session && live(x))
    if (byName) return byName
  }
  if (p.target.spawn) {
    const byName = sessions.find((x) => x.name === p.target.spawn!.name && live(x))
    if (byName) return byName
  }
  return p.issue ? sessionForIssue(sessions, p.issue) : null
}

/** Sidebar order: needs-input, working, idle, suspended; newest first inside each group. */
export function sortSessions(sessions: Session[]): Session[] {
  const rank: Record<string, number> = { 'needs-input': 0, working: 1, idle: 2, suspended: 3, done: 4 }
  return [...sessions].sort((a, b) => rank[a.state] - rank[b.state] || b.startedAt - a.startedAt)
}
