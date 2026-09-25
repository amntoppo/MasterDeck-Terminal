import { MASTER_NAME } from './derive'
import type { Session } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Resolved =
  | { kind: 'session'; session: Session }
  /** A full session id that `claude agents` doesn't list (an ended session); linkable by id alone. */
  | { kind: 'id'; sessionId: string }
  | { kind: 'ambiguous'; matches: Session[] }
  | { kind: 'none' }

/**
 * Find the session a typed value means: a session id, a background id, a session-id prefix
 * (6+ characters), or a session name (case-insensitive). Master is never a candidate.
 */
export function resolveSession(input: string, sessions: Session[]): Resolved {
  const q = input.trim()
  if (!q) return { kind: 'none' }
  const pool = sessions.filter((s) => s.name !== MASTER_NAME && s.state !== 'done')
  const lower = q.toLowerCase()
  const exact = pool.filter(
    (s) => s.sessionId.toLowerCase() === lower || (s.bgId ?? '').toLowerCase() === lower || s.name.toLowerCase() === lower,
  )
  if (exact.length === 1) return { kind: 'session', session: exact[0] }
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact }
  if (q.length >= 6) {
    const prefix = pool.filter((s) => s.sessionId.toLowerCase().startsWith(lower))
    if (prefix.length === 1) return { kind: 'session', session: prefix[0] }
    if (prefix.length > 1) return { kind: 'ambiguous', matches: prefix }
  }
  if (UUID.test(q)) return { kind: 'id', sessionId: q.toLowerCase() }
  return { kind: 'none' }
}

/** Sessions to suggest while typing: name or id contains the text; unlinked ones first. */
export function suggestSessions(input: string, sessions: Session[], limit = 8): Session[] {
  const q = input.trim().toLowerCase()
  return sessions
    .filter((s) => s.name !== MASTER_NAME && s.state !== 'done')
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.sessionId.toLowerCase().startsWith(q) || (s.bgId ?? '').startsWith(q))
    .sort((a, b) => Number(a.issue !== null) - Number(b.issue !== null) || b.startedAt - a.startedAt)
    .slice(0, limit)
}
