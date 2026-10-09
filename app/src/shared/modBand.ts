import { sameTicket, ticketLabel, ticketRef, ticketUrl } from './ticket'
import type { AppState, Session } from './types'

/**
 * What the MasterDeck mod (mods/masterdeck) draws inside a session: `deck/band/<sessionId>.json`.
 * The mod only reads this file, so the app stays the one place that talks to GitHub.
 *
 * ponytail: the mod keeps its own copy of this shape (mods/masterdeck/hooks/band.ts); a change here
 * bumps `v` and updates that file. Shared types between the app and a mod need a build step.
 */
export interface ModBand {
  v: 1
  name: string
  ticket: { label: string; ref: string; title: string | null; url: string } | null
  /** The card's column on its board (or the derived one); null: not on a board. */
  status: string | null
  pr: {
    number: number
    url: string
    /** OPEN, MERGED, CLOSED (GitHub's), null while not read yet. */
    state: string | null
    ci: 'success' | 'failure' | 'pending' | null
    threads: number
    draft: boolean
  } | null
  peers: { name: string; state: Session['state'] }[]
  /** Switched off in Session details: the mod draws nothing and its commands say so. */
  off?: true
}

/** What to write for a session: its band, or, switched off, a band that says only that (always written). */
export function bandFor(band: ModBand | null, name: string, off: boolean): ModBand | null {
  if (!off) return band
  return { ...(band ?? { v: 1, name, ticket: null, status: null, pr: null, peers: [] }), off: true }
}

/** The mod's heartbeat, `deck/mods/<sessionId>.json`: it runs in that session now. */
export interface ModBeat {
  /** The mod's version (its plugin.json). */
  version: string
  /** Claude Code's version in that session. */
  claude: string
  at: number
}

/** The mod writes every 15 s; three missed beats and the session counts as without it. */
export const MOD_BEAT_STALE_MS = 45_000

/** A heartbeat file's text, when it is one and still fresh (an ended session writes `ended`). */
export function parseModBeat(text: string, now: number): ModBeat | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const b = o as Record<string, unknown>
  if (b.v !== 1 || b.ended === true || typeof b.at !== 'number' || typeof b.version !== 'string') return null
  if (!(now - b.at < MOD_BEAT_STALE_MS)) return null
  return { version: b.version.slice(0, 40), claude: typeof b.claude === 'string' ? b.claude.slice(0, 40) : '', at: b.at }
}

/** The band for one session: null when MasterDeck has nothing to show for it (no ticket, no links). */
export function modBand(state: Pick<AppState, 'sessions' | 'issues' | 'board' | 'prs' | 'prLive' | 'sessionPrs' | 'peers'>, s: Session): ModBand | null {
  const peers = (state.peers[s.key] ?? [])
    .map((k) => state.sessions.find((x) => x.key === k))
    .filter((x): x is Session => !!x && x.state !== 'done')
    .map((x) => ({ name: x.name, state: x.state }))
  let ticket: ModBand['ticket'] = null
  let status: string | null = null
  if (s.issue !== null) {
    const t = { repo: s.issueRepo ?? null, number: s.issue }
    const card = state.board?.cards.find((c) => sameTicket(c, t))
    const issue = state.issues.find((i) => sameTicket(i, t))
    ticket = {
      label: ticketLabel(t.repo, t.number),
      ref: ticketRef(t.repo, t.number),
      title: card?.title ?? issue?.title ?? null,
      url: card?.url ?? issue?.url ?? ticketUrl(t.repo, t.number),
    }
    status = card?.status ?? issue?.status ?? null
  }
  const urls = state.sessionPrs[s.sessionId] ?? []
  const url = urls[urls.length - 1]
  let pr: ModBand['pr'] = null
  if (url) {
    const live = state.prLive[url]
    const mine = state.prs.find((p) => p.url === url)
    const number = live?.number ?? mine?.number ?? Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0)
    pr = {
      number,
      url,
      state: live?.state ?? null,
      ci: live?.ci ?? null,
      threads: mine?.unresolvedThreads ?? 0,
      draft: live?.isDraft ?? false,
    }
  }
  if (!ticket && !pr && !peers.length) return null
  return { v: 1, name: s.name, ticket, status, pr, peers }
}
