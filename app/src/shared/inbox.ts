import type { CostBook } from './costs'
import { ticketSpend } from './costs'
import { deriveNeedsYou, MASTER_NAME, proposalTicket, sessionTicket } from './derive'
import { idleNudges } from './nudge'
import { prOffers, type PrOffer } from './offers'
import type { Settings } from './settings'
import { parseTicket, ticketKey, ticketLabel, type Ticket } from './ticket'
import type { Pr, Proposal, Session } from './types'
import type { ScreenMenu } from './ask'

/**
 * Needs you, as one inbox: every item the user may act on, built in one place (the main process)
 * with a stable id, a kind, a priority, the full text and the actions it allows. The desktop cards,
 * notifications and (later) a phone are all views of it, and all act through the same `act`.
 */

export type InboxKind =
  | 'input' // waiting on a prompt or permission
  | 'menu' // an AskUserQuestion menu on its screen
  | 'question' // it asked master a question
  | 'blocked'
  | 'held'
  | 'proposal' // master proposes work
  | 'ci' // my PR's CI is failing
  | 'review' // my PR has unresolved review threads
  | 'budget'
  | 'context'
  | 'idle' // working a ticket but quiet
  | 'waiting' // blocked on a prompt for a while (another terminal)
  | 'error' // its turn ended on an API error (rate limit, overload…)

export type InboxActionType =
  | 'reply' // text typed into the session
  | 'option' // a listed choice, typed as "B: …"
  | 'menu' // an answer to the menu on screen
  | 'continue'
  | 'compact'
  | 'approve'
  | 'reject'
  | 'send' // a PR offer: master's proposal, or the message to the session
  | 'start' // open the Start dialog (the renderer does it)
  | 'open' // open the session (the renderer does it)

export interface InboxAction {
  type: InboxActionType
  label: string
  primary?: boolean
}

export type InboxDetail =
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'session' }
  | { type: 'nudge'; minutes: number }
  | { type: 'context'; pct: number }
  | { type: 'budget'; spend: number; cap: number }
  | { type: 'offer'; offer: PrOffer }

export interface InboxItem {
  /** Stable: the same situation keeps its id; a new situation (a new question, more context used…) gets a new one. */
  id: string
  kind: InboxKind
  /** Higher first. */
  priority: number
  sessionKey: string | null
  ticket: Ticket | null
  title: string
  /** The full text, not cut. */
  body: string
  actions: InboxAction[]
  detail: InboxDetail
}

export type InboxState = 'open' | 'snoozed' | 'dismissed' | 'resolved'

export interface InboxEntry {
  item: InboxItem
  state: InboxState
  firstSeen: number
  lastSeen: number
  snoozedUntil?: number | null
  resolvedAt?: number | null
  /** Why it closed: an action ("replied from desktop"), "dismissed", or what changed ("CI no longer failing"). */
  resolvedHow?: string | null
  lastAction?: { type: string; at: number; ok: boolean; message: string; by: string } | null
}

/** What the renderer (and later a phone) gets: open items by priority, snoozed ones, recent history. */
export interface InboxView {
  open: InboxEntry[]
  snoozed: InboxEntry[]
  history: InboxEntry[]
}

export const EMPTY_INBOX: InboxView = { open: [], snoozed: [], history: [] }

export const PRIORITY: Record<InboxKind, number> = {
  input: 100,
  menu: 100,
  error: 95,
  question: 90,
  blocked: 80,
  ci: 70,
  proposal: 60,
  review: 50,
  budget: 40,
  context: 30,
  waiting: 25,
  idle: 20,
  held: 10,
}

/** What happened when an item goes away without anyone acting on it. */
export const RESOLVED_BECAUSE: Record<InboxKind, string> = {
  input: 'answered in the session',
  menu: 'answered in the session',
  question: 'answered',
  blocked: 'unblocked',
  held: 'no longer held',
  proposal: 'decided',
  ci: 'CI no longer failing',
  review: 'threads resolved',
  budget: 'no longer over budget',
  context: 'context freed',
  idle: 'active again',
  waiting: 'active again',
  error: 'working again',
}

/** Actions an item of this kind takes (besides dismiss and snooze, which every item takes). */
export function allowed(item: InboxItem, type: string): boolean {
  if (type === 'reply' || type === 'option') return item.kind === 'question' || item.kind === 'blocked' || item.kind === 'menu' || item.kind === 'input'
  return item.actions.some((a) => a.type === type)
}

/** A short, stable hash of some text (ids for questions whose text is what makes them new). */
export function shortHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export interface InboxInput {
  sessions: Session[]
  /** Proposals still needing the user (questions answered in the session already left out). */
  proposals: Proposal[]
  menus: Record<string, ScreenMenu>
  lastActivity: Record<string, number>
  settings: Settings
  allStats: Record<string, { contextPct: number | null }>
  costBook: CostBook
  /** My PRs (the snapshot's, author is me). */
  prs: Pr[]
  sessionPrs: Record<string, string[]>
  /** Sessions whose last turn ended on an API error (MasterDeck's StopFailure hook), by Session.key. */
  failures?: Record<string, { type: string; message: string; at: number }>
  now: number
}

/** Every item that needs the user now. */
export function collectItems(x: InboxInput): InboxItem[] {
  const out: InboxItem[] = []
  const byKey = new Map(x.sessions.map((s) => [s.key, s]))
  const waitingOn = new Set<string>()

  for (const [key, f] of Object.entries(x.failures ?? {})) {
    const s = byKey.get(key)
    if (!s || s.state === 'done' || s.state === 'working') continue
    out.push({
      id: `error:${key}:${f.at}`,
      kind: 'error',
      priority: PRIORITY.error,
      sessionKey: key,
      ticket: sessionTicket(s),
      title: s.name,
      body: `Stopped on an API error (${f.type.replace(/_/g, ' ')}): ${f.message}`,
      actions: [{ type: 'continue', label: 'Continue', primary: true }, { type: 'open', label: 'Open' }],
      detail: { type: 'session' },
    })
  }

  for (const n of deriveNeedsYou(x.proposals, x.sessions)) {
    if (n.kind === 'session') {
      const s = n.session
      waitingOn.add(s.key)
      const menu = x.menus[s.key]
      out.push({
        // One item per wait: finding the menu on its screen (or its next question) is the same item.
        id: `wait:${s.key}:${x.lastActivity[s.sessionId] ?? 0}`,
        kind: menu ? 'menu' : 'input',
        priority: PRIORITY.input,
        sessionKey: s.key,
        ticket: sessionTicket(s),
        title: s.name,
        body: menu?.permission
          ? `Permission: ${menu.permission.title}${menu.permission.lines[0] ? ` · ${menu.permission.lines[0]}` : ''}`
          : menu?.question
            ? menu.question.question
            : menu?.review
              ? 'Ready to submit its answers.'
              : 'Waiting on a prompt or permission.',
        actions: menu ? [{ type: 'menu', label: menu.permission ? 'Allow / deny' : 'Answer', primary: true }, { type: 'open', label: 'Open' }] : [{ type: 'open', label: 'Open', primary: true }],
        detail: { type: 'session' },
      })
      continue
    }
    const p = n.proposal
    const t = proposalTicket(p)
    if (n.kind === 'proposal') {
      const startable = p.kind === 'ASSIGN' && !!p.target.spawn
      out.push({
        id: `proposal:${p.id}`,
        kind: 'proposal',
        priority: PRIORITY.proposal,
        sessionKey: null,
        ticket: t,
        title: `${p.kind} ${ticketLabel(t.repo, t.number)}`,
        body: p.summary,
        actions: [startable ? { type: 'start', label: 'Start…', primary: true } : { type: 'approve', label: 'Approve', primary: true }, { type: 'reject', label: 'Reject' }],
        detail: { type: 'proposal', proposal: p },
      })
      continue
    }
    const kind = p.status === 'question' ? 'question' : p.status === 'blocked' ? 'blocked' : 'held'
    out.push({
      // A new question on the same proposal replaces its note: a new item.
      id: `${kind}:${p.id}:${shortHash(p.note ?? '')}`,
      kind,
      priority: PRIORITY[kind],
      sessionKey: null,
      ticket: t,
      title: ticketLabel(t.repo, t.number),
      body: p.note ?? p.summary,
      actions: kind === 'held' ? [{ type: 'open', label: 'Open' }] : [{ type: 'reply', label: 'Reply', primary: true }, { type: 'open', label: 'Open' }],
      detail: { type: 'proposal', proposal: p },
    })
  }

  for (const n of idleNudges(x.sessions, x.proposals, x.lastActivity, x.settings.idleNudgeMinutes, x.now)) {
    // A session already listed as needing input keeps that item.
    if (n.kind === 'waiting' && waitingOn.has(n.session.key)) continue
    const s = n.session
    out.push({
      id: `${n.kind}:${s.key}:${x.lastActivity[s.sessionId] ?? 0}`,
      kind: n.kind,
      priority: PRIORITY[n.kind],
      sessionKey: s.key,
      ticket: sessionTicket(s),
      title: s.name,
      body: n.kind === 'idle' ? `Working a ticket but quiet for ${n.minutes} minutes. Nudge it to carry on?` : `Blocked on a prompt for ${n.minutes} minutes. Open it to answer.`,
      actions: n.kind === 'idle' ? [{ type: 'continue', label: 'Continue', primary: true }, { type: 'open', label: 'Open' }] : [{ type: 'open', label: 'Open', primary: true }],
      detail: { type: 'nudge', minutes: n.minutes },
    })
  }

  for (const s of x.sessions) {
    const pct = x.allStats[s.sessionId]?.contextPct
    if (s.state === 'done' || s.name === MASTER_NAME || pct == null || pct < x.settings.contextWarnPct) continue
    out.push({
      id: `context:${s.key}:${Math.floor(pct / 10)}`,
      kind: 'context',
      priority: PRIORITY.context,
      sessionKey: s.key,
      ticket: sessionTicket(s),
      title: s.name,
      body: `At ${Math.round(pct)}% of its context. Compacting keeps it working well.`,
      actions: [{ type: 'compact', label: 'Compact now', primary: true }, { type: 'open', label: 'Open' }],
      detail: { type: 'context', pct },
    })
  }

  const cap = x.settings.budgetPerTicketUsd
  if (cap > 0)
    for (const [k, spend] of Object.entries(ticketSpend(x.costBook))) {
      if (spend <= cap) continue
      const t = parseTicket(k)
      if (!t) continue
      out.push({
        id: `budget:${ticketKey(t.repo, t.number)}:${Math.floor(spend / cap)}`,
        kind: 'budget',
        priority: PRIORITY.budget,
        sessionKey: null,
        ticket: t,
        title: `${ticketLabel(t.repo, t.number)} spent $${spend.toFixed(2)} of $${cap}`,
        body: 'Its sessions passed the per-ticket budget (Settings).',
        actions: [{ type: 'open', label: 'Open' }],
        detail: { type: 'budget', spend, cap },
      })
    }

  for (const o of prOffers(x.prs, x.sessions, x.sessionPrs, x.proposals, new Set())) {
    out.push({
      id: `offer:${o.id}`,
      kind: o.kind,
      priority: PRIORITY[o.kind],
      sessionKey: o.owner?.key ?? null,
      ticket: o.pr.refsIssue !== null ? { repo: o.pr.refsRepo ?? null, number: o.pr.refsIssue } : null,
      title: `${o.pr.repo}#${o.pr.number} ${o.pr.title}`,
      body: o.kind === 'ci' ? 'CI is failing.' : `${o.pr.unresolvedThreads} unresolved review thread${o.pr.unresolvedThreads === 1 ? '' : 's'}.`,
      actions: [{ type: o.proposal || o.owner ? 'send' : 'start', label: o.proposal ? 'Approve & send' : o.owner ? 'Send to session' : 'Start session', primary: true }],
      detail: { type: 'offer', offer: o },
    })
  }

  // Sessions come and go: only items whose session is known (or that have none).
  return out.filter((i) => i.sessionKey === null || byKey.has(i.sessionKey)).sort((a, b) => b.priority - a.priority)
}

/** A new item's notification: its text, the item (clicking opens it), and what it can do from the
 * notification itself (macOS: a button for its main action, a reply field for a question). Held
 * items (parked on purpose) get none. */
export interface InboxNotice {
  title: string
  body: string
  target: { sessionKey?: string; needsYou?: true; itemId: string }
  /** Carried out by the inbox (not the ones the window does: open, start). */
  action: InboxAction | null
  reply: boolean
}

const RUNS_IN_MAIN = new Set<InboxActionType>(['continue', 'compact', 'approve', 'send'])

export function inboxNotice(e: InboxEntry): InboxNotice | null {
  const i = e.item
  if (i.kind === 'held') return null
  const target = { ...(i.sessionKey ? { sessionKey: i.sessionKey } : { needsYou: true as const }), itemId: i.id }
  const title =
    i.kind === 'input' || i.kind === 'menu'
      ? `${i.title} needs you`
      : i.kind === 'question' || i.kind === 'blocked'
        ? `${i.title}: ${i.kind}`
        : i.kind === 'proposal'
          ? `New proposal: ${i.title}`
          : i.kind === 'ci'
            ? `CI failing: ${i.title}`
            : i.kind === 'review'
              ? `Review threads: ${i.title}`
              : i.kind === 'context'
                ? `${i.title} is at ${Math.round(i.detail.type === 'context' ? i.detail.pct : 0)}% context`
                : i.kind === 'idle'
                  ? `${i.title} went quiet`
                  : i.kind === 'error'
                    ? `${i.title} stopped on an error`
                    : i.kind === 'waiting'
                    ? `${i.title} is waiting`
                    : i.title
  const action = i.actions.find((a) => a.primary && RUNS_IN_MAIN.has(a.type)) ?? null
  return { title, body: i.body.length > 240 ? `${i.body.slice(0, 240)}…` : i.body, target, action, reply: i.kind === 'question' || i.kind === 'blocked' }
}
