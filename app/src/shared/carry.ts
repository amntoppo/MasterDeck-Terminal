import type { Session } from './types'

/** A babysit-ticket link: which issue, and when it was made. */
export interface LinkInfo {
  issue: number
  linkedAt: number | null
}

/** Every session id a background session (by background id) has had, oldest first. */
export type SessionHistory = Record<string, string[]>

export interface Carry {
  bgId: string
  sessionId: string
  issue: number
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
    if (current?.issue === previous.issue) continue
    const automatic = current !== undefined && current.linkedAt !== null && s.startedAt > 0 && current.linkedAt - s.startedAt <= ADOPTION_WINDOW_MS
    if (current && !automatic) continue // linked on purpose to something else: leave it
    out.push({ bgId: s.bgId, sessionId: s.sessionId, issue: previous.issue, cwd: s.cwd, replaces: current?.issue ?? null })
  }
  return out
}
