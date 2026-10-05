import { accountForRepo, isMulti } from './accounts'
import type { AppConfig, ProjectConfig } from './appConfig'
import { boardForAccount } from './boardFilter'
import { sessionForIssue } from './derive'
import type { PastSession } from './pastSessions'
import { ticketKey, ticketOf } from './ticket'
import type { Board, BoardCard, Session } from './types'

/**
 * A Board for an account that has repositories but no GitHub project board: its repositories'
 * issues, in columns MasterDeck works out from what it knows. Nothing is stored on GitHub.
 * `master board` delivers facts (issue state, linked PRs); the columns are worked out here, on
 * every state build, so a session linking or a PR opening moves the card at once.
 */
export const DERIVED_COLUMNS = ['Todo', 'In Dev', 'PR Raised', 'Done'] as const
export type DerivedColumn = (typeof DERIVED_COLUMNS)[number]
/** A closed issue stays in Done this long. */
export const DERIVED_DONE_DAYS = 14

const account = (login: string | null | undefined, c: AppConfig) => (login && isMulti(c) ? c.accounts.find((a) => a.login === login) : undefined)

/** The boards a Board tab shows: its account's with two or more accounts, else every selected board. */
export function boardsOf(login: string | null | undefined, c: AppConfig): ProjectConfig[] {
  return login && isMulti(c) ? (account(login, c)?.projects ?? []) : c.projects
}

/** The repositories ticked for a Board tab's account (one account: every selected one). */
export function reposOf(login: string | null | undefined, c: AppConfig): string[] {
  return login && isMulti(c) ? (account(login, c)?.repos ?? []) : c.repos
}

/** Repositories but no board: the Board shows the repositories' issues. The one place that asks. */
export function boardless(login: string | null | undefined, c: AppConfig): boolean {
  return c.configured && reposOf(login, c).length > 0 && boardsOf(login, c).length === 0
}

/** Is this repository's account one with no board? `repo` null: the primary issue repo. */
export function repoBoardless(repo: string | null | undefined, c: AppConfig): boolean {
  return boardless(isMulti(c) ? accountForRepo(repo, c) : null, c)
}

export interface DeriveCtx {
  sessions: Session[]
  /** Stopped sessions that can be resumed, by ticketKey (AppState.pastSessions). */
  past: Record<string, PastSession[]>
  /** PRs MasterDeck recorded for the sessions linked to a ticket, by ticketKey (ticketPrMap). */
  linkPrs: Record<string, string[]>
  /** The PRs MasterDeck follows, by URL: fresher than the card's hourly read. */
  prLive: Record<string, { state: string; isDraft: boolean } | undefined>
  now: number
}

/** OPEN (ready), DRAFT, MERGED or CLOSED for each of the card's PRs whose state is known. */
function prStates(card: BoardCard, ctx: Pick<DeriveCtx, 'linkPrs' | 'prLive'>): string[] {
  const urls = new Set([...card.prs.map((p) => p.url), ...(ctx.linkPrs[ticketKey(card.repo, card.number)] ?? [])])
  const out: string[] = []
  for (const url of urls) {
    const live = ctx.prLive[url]
    const state = live ? (live.state === 'OPEN' && live.isDraft ? 'DRAFT' : live.state) : (card.prs.find((p) => p.url === url)?.state ?? null)
    if (state) out.push(state)
  }
  return out
}

/**
 * The column, first match wins: a closed issue is Done; a PR open and ready is PR Raised (also
 * beside a merged one: work is still open); a draft is In Dev; a merged PR is Done; a linked
 * session, live or stopped, is In Dev; else Todo. A PR closed without merging counts for nothing.
 */
export function derivedStatus(card: BoardCard, ctx: DeriveCtx): DerivedColumn {
  if (card.state === 'CLOSED') return 'Done'
  const states = prStates(card, ctx)
  if (states.includes('OPEN')) return 'PR Raised'
  if (states.includes('DRAFT')) return 'In Dev'
  if (states.includes('MERGED')) return 'Done'
  const t = ticketOf(card)
  if (sessionForIssue(ctx.sessions, t) || (ctx.past[ticketKey(t.repo, t.number)]?.length ?? 0) > 0) return 'In Dev'
  return 'Todo'
}

/** The board with every derived card in its column; closed ones older than DERIVED_DONE_DAYS are left out. A board with no derived card is returned as is. */
export function deriveBoard(b: Board | null, ctx: DeriveCtx): Board | null {
  if (!b || !b.cards.some((c) => c.derived)) return b
  const cutoff = ctx.now - DERIVED_DONE_DAYS * 86_400_000
  const cards = b.cards.flatMap((c) => {
    if (!c.derived) return [c]
    if (c.state === 'CLOSED' && !(c.closedAt && Date.parse(c.closedAt) >= cutoff)) return []
    return [{ ...c, status: derivedStatus(c, ctx) }]
  })
  return { ...b, cards }
}

/** The sprint board proper (Summary, burndown): derived cards are not part of any sprint. */
export function withoutDerived(b: Board): Board {
  return b.cards.some((c) => c.derived) ? { ...b, cards: b.cards.filter((c) => !c.derived) } : b
}

/** What a Board tab shows: its account's boards exactly as before; for an account with no board, its repositories' issues in MasterDeck's columns. */
export function tabBoard(b: Board | null, login: string | null, c: AppConfig): Board | null {
  if (!b) return null
  const own = login ? boardForAccount(b, login, c) : b
  if (boardless(login, c)) return { ...own, cards: own.cards.filter((x) => x.derived), columns: [...DERIVED_COLUMNS], projects: [] }
  return withoutDerived(own)
}

export type BoardEmpty = 'cards' | 'filtered' | 'no-issues' | 'nothing-selected'

/** Why a tab shows no card: the filters hide them (also a board's empty sprint, as before), its repositories have no open issue, or nothing is selected for its account. */
export function boardEmpty(o: { login: string | null; total: number; shown: number }, c: AppConfig): BoardEmpty {
  if (o.shown > 0) return 'cards'
  if (boardsOf(o.login, c).length === 0) {
    if (reposOf(o.login, c).length === 0) return 'nothing-selected'
    if (o.total === 0) return 'no-issues'
  }
  return 'filtered'
}

const names = (repos: string[]) => repos.map((r) => r.split('/')[1] ?? r).join(', ')

/** What the read left out, for the hint line of an account with no board. */
export function derivedNotes(b: Board | null, login: string | null): string[] {
  const part = (b?.derived ?? []).find((d) => (d.account ?? null) === (login ?? null))
  if (!part) return []
  const out: string[] = []
  if (part.shown < part.total) out.push(`Showing the first ${part.shown} of ${part.total} open issues.`)
  if (part.skipped.length) out.push(`Not read (more than ${part.repos.length} ${part.repos.length === 1 ? 'repository' : 'repositories'}): ${names(part.skipped)}.`)
  if (part.missing.length) out.push(`GitHub did not answer for ${names(part.missing)}.`)
  return out
}
