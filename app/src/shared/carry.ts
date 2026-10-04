import { ticketKey } from './ticket'
import type { Session } from './types'

/** A babysit-ticket link: which issue, and when it was made. */
export interface LinkInfo {
  issue: number
  /** The issue's repo (owner/name); null or missing: the primary issue repo. */
  repo?: string | null
  linkedAt: number | null
}

/** Every session id a background session (by background id) has had, oldest first. */
export type SessionHistory = Record<string, string[]>

export interface Carry {
  bgId: string
  sessionId: string
  issue: number
  repo: string | null
  cwd: string
  /** The link being replaced: none, or babysit-ticket's automatic branch link. */
  replaces: number | null
}

/** A link made this soon after the session (re)started came from babysit-ticket's branch lookup. */
export const ADOPTION_WINDOW_MS = 120_000

/**
 * Record each background session's current session id. A background id is the first 8 characters
 * of the session's original session id, so a linked id starting with it is an earlier id too, even
 * one resumed while the app was closed. Returns true when anything changed.
 */
export function recordHistory(history: SessionHistory, sessions: Session[], linkedIds: Iterable<string> = []): boolean {
  let changed = false
  const linked = [...linkedIds]
  for (const s of sessions) {
    if (s.kind !== 'background' || !s.bgId) continue
    const ids = (history[s.bgId] ??= [])
    for (const id of linked) {
      if (id.startsWith(`${s.bgId}-`) && !ids.includes(id)) {
        ids.unshift(id)
        changed = true
      }
    }
    if (!ids.includes(s.sessionId)) {
      ids.push(s.sessionId)
      changed = true
    }
  }
  return changed
}

/**
 * Links to carry across a resume. A resumed background session gets a new session id, and
 * babysit-ticket keys links by session id, so the link is lost (or replaced by an automatic
 * branch link, which can point at the wrong ticket). For each background session whose current
 * id has no link, or only an automatic one to a different issue, carry over the most recent link
 * of one of its earlier ids.
 */
export function linksToCarry(history: SessionHistory, sessions: Session[], links: Map<string, LinkInfo>): Carry[] {
  const out: Carry[] = []
  for (const s of sessions) {
    if (s.kind !== 'background' || !s.bgId || s.state === 'done') continue
    const earlier = (history[s.bgId] ?? []).filter((id) => id !== s.sessionId)
    const previous = earlier
      .map((id) => links.get(id))
      .filter((l): l is LinkInfo => !!l)
      .sort((a, b) => (b.linkedAt ?? 0) - (a.linkedAt ?? 0))[0]
    if (!previous) continue
    const current = links.get(s.sessionId)
    if (current && ticketKey(current.repo, current.issue) === ticketKey(previous.repo, previous.issue)) continue
    const automatic = current !== undefined && current.linkedAt !== null && s.startedAt > 0 && current.linkedAt - s.startedAt <= ADOPTION_WINDOW_MS
    if (current && !automatic) continue // linked on purpose to something else: leave it
    out.push({ bgId: s.bgId, sessionId: s.sessionId, issue: previous.issue, repo: previous.repo ?? null, cwd: s.cwd, replaces: current?.issue ?? null })
  }
  return out
}

/**
 * A resume as another account (or name) started a copy under a new background id. The copy is the
 * same work: it gets the old session's earlier ids (so linksToCarry gives it the ticket link once
 * it shows up) and the PRs known for it. True when anything changed.
 */
export function carryCopy(history: SessionHistory, prs: Record<string, string[]>, old: { bgId: string; sessionId: string }, copyBg: string): boolean {
  if (!copyBg || copyBg === old.bgId) return false
  let changed = false
  const ids = (history[copyBg] ??= [])
  const earlier = [...(history[old.bgId] ?? []), old.sessionId].filter((id, i, all) => all.indexOf(id) === i && !ids.includes(id))
  if (earlier.length) {
    ids.unshift(...earlier)
    changed = true
  }
  const have = (prs[copyBg] ??= [])
  const more = (prs[old.bgId] ?? []).filter((u) => !have.includes(u))
  if (more.length) {
    have.unshift(...more)
    changed = true
  }
  if (!have.length) delete prs[copyBg]
  return changed
}
