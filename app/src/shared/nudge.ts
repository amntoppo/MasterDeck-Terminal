import { MASTER_NAME, proposalTicket, sessionTicket } from './derive'
import { sameTicket } from './ticket'
import type { Proposal, Session } from './types'

export interface Nudge {
  session: Session
  /** idle: working a ticket but quiet; waiting: blocked on a prompt. */
  kind: 'idle' | 'waiting'
  /** Minutes since the last transcript write. */
  minutes: number
}

/**
 * Sessions to nudge: blocked on a prompt, or working a ticket (their latest non-CHAT proposal is
 * `sent`) yet quiet, for at least `minutes`. Master and parked sessions are left alone.
 */
export function idleNudges(sessions: Session[], proposals: Proposal[], lastActivity: Record<string, number>, minutes: number, now: number): Nudge[] {
  const out: Nudge[] = []
  for (const s of sessions) {
    if (s.name === MASTER_NAME || s.state === 'done' || s.state === 'suspended' || s.state === 'working') continue
    // Waiting on its own Monitor or background task: quiet on purpose.
    if (s.state === 'idle' && (s.waitingOn || s.busyWith)) continue
    const last = lastActivity[s.sessionId]
    if (last === undefined) continue
    const quiet = Math.floor((now - last) / 60_000)
    if (quiet < minutes) continue
    if (s.state === 'needs-input') {
      out.push({ session: s, kind: 'waiting', minutes: quiet })
      continue
    }
    const mine = proposals
      .filter((p) => p.kind !== 'CHAT' && (p.target.session === s.name || p.target.spawn?.name === s.name || sameTicket(sessionTicket(s), proposalTicket(p))))
      .sort((a, b) => b.id - a.id)[0]
    if (mine?.status === 'sent') out.push({ session: s, kind: 'idle', minutes: quiet })
  }
  return out.sort((a, b) => b.minutes - a.minutes)
}
