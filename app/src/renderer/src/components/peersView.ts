import type { AppState, Session, SessionState } from '@shared/types'
import { suggestSessions } from '@shared/link'
import { ticketLabel } from '@shared/ticket'

export interface PeerRow {
  key: string
  name: string
  state: SessionState
  folder: string
  ticket: string | null
}

const folderOf = (state: AppState, s: Session): string => {
  const dir = state.stats[s.sessionId]?.currentDir ?? s.cwd
  return dir.split('/').filter(Boolean).pop() ?? dir
}

/** The session's linked peers that are still on the deck, as detail rows. */
export function peerRows(state: AppState, key: string): PeerRow[] {
  const rows: PeerRow[] = []
  for (const k of state.peers[key] ?? []) {
    const p = state.sessions.find((s) => s.key === k)
    if (!p) continue
    rows.push({ key: p.key, name: p.name, state: p.state, folder: folderOf(state, p), ticket: p.issue !== null ? ticketLabel(p.issueRepo, p.issue) : null })
  }
  return rows
}

/** Sessions that can be linked to `key`: not itself, not done, not already linked. */
export function linkable(state: AppState, key: string, text: string, limit = 8): Session[] {
  const taken = new Set(state.peers[key] ?? [])
  return suggestSessions(text, state.sessions.filter((s) => s.key !== key && !taken.has(s.key)), limit)
}
