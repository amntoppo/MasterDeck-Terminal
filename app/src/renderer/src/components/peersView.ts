import type { AppState, Session, SessionState } from '@shared/types'
import type { PeerFact } from '@shared/deckHooks'
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

/** Candidates for the Start dialogs' picker: live sessions not already chosen. */
export function pickable(state: AppState, chosen: string[], text: string, limit = 8): Session[] {
  const taken = new Set(chosen)
  return suggestSessions(text, state.sessions.filter((s) => !taken.has(s.key)), limit)
}

/** A chosen peer's saved summary (summaryGet), null when it has none; missing while loading. */
export type PeerSummaries = Record<string, { at: number; text: string } | null>

/** What a new session's first prompt says about the sessions it is linked to. */
export function peerFactsFor(state: AppState, keys: string[], summaries: PeerSummaries = {}): PeerFact[] {
  const facts: PeerFact[] = []
  for (const k of keys) {
    const s = state.sessions.find((x) => x.key === k)
    if (!s) continue
    facts.push({
      key: s.key,
      name: s.name,
      cwd: state.stats[s.sessionId]?.currentDir ?? s.cwd,
      branch: state.git[s.sessionId]?.branch ?? null,
      ticket: s.issue !== null ? ticketLabel(s.issueRepo, s.issue) : null,
      state: s.state,
      summary: summaries[s.key] ?? null,
    })
  }
  return facts
}
