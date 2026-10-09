import { primaryLogin } from './accounts'
import type { AppConfig } from './appConfig'
import { boardless, tabBoard } from './derivedBoard'
import { sameTicket, ticketLabel, ticketRef, ticketUrl } from './ticket'
import type { AppState, Board, Session } from './types'

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
  /** The board this session's account sees: `deck/boards/<boardKey>.json` (`modBoard`). */
  boardKey?: string
  /**
   * Mods switched off for this session in Session details → Mods, by plugin name. MasterDeck's own
   * feature mods read it and go quiet; the core refuses any other when it loads.
   */
  offMods?: string[]
}

/** MasterDeck's core mod (mods/masterdeck): the switching and the heartbeat; never switched off. */
export const MOD_CORE = 'masterdeck'

/** The mods' version this MasterDeck goes with (each mod's plugin.json; shared/modsShared.test.ts checks). */
export const MOD_VERSION = '0.5.0'

/**
 * The session runs MasterDeck's mods from before they were updated or installed: a running session
 * takes new or changed mods only at /reload-plugins (or its next start).
 */
export function modsStale(live: { version: string; mods: readonly ModSeen[] }): boolean {
  return live.version !== MOD_VERSION || MASTERDECK_MODS.some((m) => !live.mods.some((s) => s.name === m.name))
}

/** MasterDeck's feature mods (mods/<name>), as the Mods tab names them; each switches itself at once. */
export const MASTERDECK_MODS: readonly { name: string; title: string; about: string }[] = [
  { name: 'masterdeck-ticket', title: 'Ticket line', about: 'The ticket, its column, the PR and linked sessions above the prompt; /md-ticket' },
  { name: 'masterdeck-alerts', title: 'Alerts', about: 'Toasts when the card moves, a review thread opens, CI changes or the PR merges' },
  { name: 'masterdeck-note', title: 'Note command', about: '/md-note <text> adds to the ticket\'s note in Notes' },
  { name: 'masterdeck-loop', title: 'Agent loop', about: '/md-loop <check> -- <goal>: rounds until the check passes, with progress above the prompt' },
  { name: 'masterdeck-board', title: 'Board', about: '/md-board shows this account\'s board in a pane, read only' },
]

/** What to write for a session: its band with the mods switched off there. */
export function bandFor(band: ModBand, offMods: readonly string[]): ModBand {
  return offMods.length ? { ...band, offMods: [...offMods] } : band
}

/** A mod the MasterDeck mod saw load (or refused) in a session: `plugin.register`. */
export interface ModSeen {
  name: string
  /** `<name>@<marketplace>`, `<name>@inline` (`--plugin-dir`), `<name>@builtin`. */
  provenance: string
  version: string | null
  /** `user` (installed by the person), `prepend` / `append` (managed), `builtin`. */
  tier: string
  /** False: refused in that session (switched off). */
  loaded: boolean
}

const MOD_NAME = /^[A-Za-z0-9._-]{1,64}$/

function parseSeen(raw: unknown): ModSeen[] {
  if (!Array.isArray(raw)) return []
  const out: ModSeen[] = []
  for (const m of raw.slice(0, 50)) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    if (typeof o.name !== 'string' || !MOD_NAME.test(o.name) || typeof o.provenance !== 'string' || typeof o.tier !== 'string') continue
    out.push({
      name: o.name,
      provenance: o.provenance.slice(0, 200),
      version: typeof o.version === 'string' ? o.version.slice(0, 40) : null,
      tier: o.tier.slice(0, 20),
      loaded: o.loaded !== false,
    })
  }
  return out
}

/** A mod MasterDeck has seen in any session (`mod-catalog.json`): what Session details → Mods lists. */
export interface ModEntry {
  name: string
  provenance: string
  version: string | null
  tier: string
}

/** The catalog with what a session reported; null when nothing changed. */
export function mergeCatalog(catalog: readonly ModEntry[], seen: readonly ModSeen[]): ModEntry[] | null {
  let changed = false
  const out = [...catalog]
  for (const m of seen) {
    const entry = { name: m.name, provenance: m.provenance, version: m.version, tier: m.tier }
    const i = out.findIndex((e) => e.name === m.name)
    if (i < 0) out.push(entry)
    else if (JSON.stringify(out[i]) !== JSON.stringify(entry)) out[i] = entry
    else continue
    changed = true
  }
  return changed ? out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200) : null
}

/** How a mod stands in one session, for Session details → Mods. */
export type ModRowStatus =
  | 'on'
  /** Switched off and refused (or, for MasterDeck's own, quiet). */
  | 'off'
  /** Switched off while it runs: it goes when the session starts again. */
  | 'off-next-start'
  /** Switched on after a refusal: it joins at the reload the MasterDeck mod asks for. */
  | 'turning-on'
  /** Not seen in this session (not installed then, or loaded before MasterDeck's core). */
  | 'not-seen'

export interface ModRow {
  name: string
  /** What the tab calls it: MasterDeck's own by what they do, any other by its plugin name. */
  title: string
  /** One line on what it does (MasterDeck's own only). */
  about: string | null
  provenance: string
  version: string | null
  /** The core, a managed or a built-in mod: not switched from MasterDeck. */
  locked: boolean
  /** One of MasterDeck's: the core or a feature mod. */
  isMasterDeck: boolean
  isOff: boolean
  status: ModRowStatus
}

/**
 * The rows of Session details → Mods: MasterDeck's core (locked: it does the switching), its
 * feature mods (always listed; they switch themselves at once), then every other mod seen anywhere.
 */
export function modRows(
  catalog: readonly ModEntry[],
  live: { version: string; mods: readonly ModSeen[] },
  offMods: readonly string[],
): ModRow[] {
  const off = new Set(offMods)
  const core: ModRow = {
    name: MOD_CORE, title: 'MasterDeck core', about: 'Switches the mods in this list and tells MasterDeck which run here',
    provenance: `${MOD_CORE}@${MOD_CORE}`, version: live.version, locked: true, isMasterDeck: true, isOff: false, status: 'on',
  }
  const known = (name: string) => live.mods.find((m) => m.name === name) ?? catalog.find((e) => e.name === name)
  const ours = MASTERDECK_MODS.map((m): ModRow => {
    const here = live.mods.find((s) => s.name === m.name)
    const isOff = off.has(m.name)
    return {
      name: m.name, title: m.title, about: m.about, provenance: known(m.name)?.provenance ?? `${m.name}@${MOD_CORE}`,
      version: known(m.name)?.version ?? null, locked: false, isMasterDeck: true, isOff,
      status: !here ? 'not-seen' : isOff ? 'off' : 'on',
    }
  })
  const family = new Set([MOD_CORE, ...MASTERDECK_MODS.map((m) => m.name)])
  const names = [...new Set([...catalog.map((e) => e.name), ...live.mods.map((m) => m.name)])].filter((n) => !family.has(n))
  const others = names.map((name): ModRow => {
    const here = live.mods.find((m) => m.name === name)
    const entry = known(name)!
    const isOff = off.has(name)
    const status: ModRowStatus = !here ? 'not-seen' : here.loaded ? (isOff ? 'off-next-start' : 'on') : isOff ? 'off' : 'turning-on'
    return { name, title: name, about: null, provenance: entry.provenance, version: entry.version, locked: entry.tier !== 'user', isMasterDeck: false, isOff, status }
  })
  return [core, ...ours, ...others.sort((a, b) => Number(a.locked) - Number(b.locked) || a.name.localeCompare(b.name))]
}

/** The mod's heartbeat, `deck/mods/<sessionId>.json`: it runs in that session now. */
export interface ModBeat {
  /** The mod's version (its plugin.json). */
  version: string
  /** Claude Code's version in that session. */
  claude: string
  at: number
  /** The mods it saw load after it in that session. */
  mods: ModSeen[]
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
  return { version: b.version.slice(0, 40), claude: typeof b.claude === 'string' ? b.claude.slice(0, 40) : '', at: b.at, mods: parseSeen(b.mods) }
}

/** The board file a session reads: its account's login, else the primary's; `_` with no login known. */
export function boardKeyOf(s: Session, c: AppConfig): string {
  return s.account ?? primaryLogin(c) ?? '_'
}

/** What `/md-board` (mods/masterdeck-board) shows: an account's board, read only. `deck/boards/<key>.json`. */
export interface ModBoard {
  v: 1
  account: string | null
  sprint: string | null
  /** The account has no GitHub board: MasterDeck's own columns from its repositories' issues. */
  derived: boolean
  columns: { name: string; count: number; cards: { label: string; title: string; url: string; assignees: string[] }[] }[]
}

/** Cards listed per column (the count says how many there are); a title is cut at this many characters. */
const BOARD_CARDS = 30
const BOARD_TITLE = 120

/** The board of the account behind `key` (see boardKeyOf), as `/md-board` shows it; null before a board is read. */
export function modBoard(board: Board | null, key: string, c: AppConfig): ModBoard | null {
  const login = key === '_' ? null : key
  const b = tabBoard(board, login, c)
  if (!b) return null
  const names = [...b.columns]
  const loose = b.cards.filter((x) => !x.status || !names.includes(x.status))
  if (loose.length) names.push('No status')
  // An account with no GitHub board: MasterDeck's columns, and no sprint (that is another board's).
  const derived = boardless(login, c)
  return {
    v: 1,
    account: login,
    sprint: derived ? null : b.sprint,
    derived,
    columns: names.map((name) => {
      const cards = name === 'No status' ? loose : b.cards.filter((x) => x.status === name)
      return {
        name,
        count: cards.length,
        cards: cards.slice(0, BOARD_CARDS).map((x) => ({
          label: ticketLabel(x.repo ?? null, x.number),
          title: x.title.length > BOARD_TITLE ? `${x.title.slice(0, BOARD_TITLE - 1)}…` : x.title,
          url: x.url,
          assignees: x.assignees.slice(0, 3),
        })),
      }
    }),
  }
}

/**
 * The band for one session: always one (the ticket, its PR and links when there are, and the board
 * key for /md-board); the ticket line draws only when it has a ticket, a PR or a link.
 */
export function modBand(state: Pick<AppState, 'sessions' | 'issues' | 'board' | 'prs' | 'prLive' | 'sessionPrs' | 'peers'>, s: Session, boardKey?: string): ModBand {
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
  return { v: 1, name: s.name, ticket, status, pr, peers, ...(boardKey ? { boardKey } : {}) }
}
