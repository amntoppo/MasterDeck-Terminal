import { ticketSpend } from './costs'
import type { AppState, NotifyEvent } from './types'

/** Desktop notifications for state transitions. Silent on the first load. */
export function diffEvents(prev: AppState | null, next: AppState, focusedSessionId: string | null): NotifyEvent[] {
  if (!prev) return []
  const out: NotifyEvent[] = []
  const before = new Map(prev.sessions.map((s) => [s.key, s]))
  for (const s of next.sessions) {
    const p = before.get(s.key)
    if (!p) continue
    if (s.state === 'needs-input' && p.state !== 'needs-input') {
      out.push({ title: `${s.name} needs input`, body: 'Waiting on a prompt or permission.', target: { sessionKey: s.key } })
    } else if (s.state === 'idle' && p.state === 'working' && s.sessionId !== focusedSessionId) {
      out.push({ title: `${s.name} finished`, body: 'The session went idle.', target: { sessionKey: s.key } })
    }
  }
  const prevStatus = new Map(prev.proposals.map((p) => [p.id, p.status]))
  const fresh = next.proposals.filter((p) => p.status === 'proposed' && !prevStatus.has(p.id))
  if (fresh.length > 0) {
    out.push({
      title: fresh.length === 1 ? 'New proposal' : `${fresh.length} new proposals`,
      body: fresh.map((p) => `${p.kind} #${p.issue} ${p.summary}`).join('\n'),
      target: { needsYou: true },
    })
  }
  for (const p of next.proposals) {
    const was = prevStatus.get(p.id)
    if (was === undefined || was === p.status) continue
    if (p.status === 'question' || p.status === 'blocked') {
      out.push({
        title: `#${p.issue}: ${p.status}`,
        body: p.note ?? p.summary,
        target: { needsYou: true },
      })
    }
  }
  // Budget: a ticket's spend crossing the cap.
  const cap = next.settings.budgetPerTicketUsd
  if (cap > 0) {
    const before = ticketSpend(prev.costBook)
    for (const [issue, spend] of Object.entries(ticketSpend(next.costBook))) {
      if (spend > cap && (before[Number(issue)] ?? 0) <= cap) {
        out.push({ title: `#${issue} passed its $${cap} budget`, body: `Its sessions have spent $${spend.toFixed(2)}.`, target: { needsYou: true } })
      }
    }
  }
  return out
}

/**
 * Context warnings: once per live session when it reaches the warning level; `warned` remembers
 * who was warned and forgets a session only after it drops under 60% (so 84↔86 doesn't repeat).
 */
export function contextAlerts(warned: Set<string>, next: AppState): NotifyEvent[] {
  const out: NotifyEvent[] = []
  const warn = next.settings.contextWarnPct
  for (const s of next.sessions) {
    if (s.state === 'done') continue
    const pct = next.allStats[s.sessionId]?.contextPct
    if (pct == null) continue
    if (pct < 60) warned.delete(s.sessionId)
    else if (pct >= warn && !warned.has(s.sessionId)) {
      warned.add(s.sessionId)
      out.push({ title: `${s.name} is at ${Math.round(pct)}% context`, body: 'Compact it now to keep it working well.', target: { sessionKey: s.key } })
    }
  }
  return out
}

/** Sessions that just started needing input (for auto-open). */
export function newlyNeedsInput(prev: AppState | null, next: AppState): string[] {
  if (!prev) return []
  const before = new Map(prev.sessions.map((s) => [s.key, s.state]))
  return next.sessions.filter((s) => s.state === 'needs-input' && before.has(s.key) && before.get(s.key) !== 'needs-input').map((s) => s.key)
}
