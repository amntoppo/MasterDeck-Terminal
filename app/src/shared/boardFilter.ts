import { fullRepo, ticketLabel, ticketRef } from './ticket'
import { sessionForIssue } from './derive'
import { accountForProject, accountForRepo, isMulti } from './accounts'
import { projectKey, type AppConfig } from './appConfig'
import type { Board, BoardCard, BoardPr, Session } from './types'

export const UNASSIGNED = '(unassigned)'

export interface FilterState {
  /** Empty means everyone. Logins, or UNASSIGNED. */
  assignees: string[]
  labels: string[]
  milestone: string | null
  hasPr: 'any' | 'with' | 'without'
  search: string
  /** Columns the user hid. */
  hiddenColumns: string[]
  /** Repos (owner/name) to show; empty: every repo. */
  repos: string[]
  /** Boards (owner/number) to show; empty: every board. */
  projects: string[]
}

export function defaultFilters(me: string | null): FilterState {
  return { assignees: me ? [me] : [], labels: [], milestone: null, hasPr: 'any', search: '', hiddenColumns: [], repos: [], projects: [] }
}

/** How many filters differ from the defaults (each filter counts once, search included). */
export function activeBoardFilterCount(f: FilterState, me: string | null): number {
  return [f.labels.length > 0, !!f.milestone, f.hasPr !== 'any', !!f.search, f.hiddenColumns.length > 0, f.repos.length > 0, f.projects.length > 0, f.assignees.join() !== (me ?? '')].filter(Boolean).length
}

/** Saved filters from an older version lack the newer fields: fill them in. */
export function normalizeFilters(f: Partial<FilterState> | null | undefined, me: string | null): FilterState {
  const d = defaultFilters(me)
  if (!f || typeof f !== 'object') return d
  const arr = (v: unknown, dflt: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : dflt)
  return {
    assignees: arr(f.assignees, d.assignees),
    labels: arr(f.labels, []),
    milestone: typeof f.milestone === 'string' ? f.milestone : null,
    hasPr: f.hasPr === 'with' || f.hasPr === 'without' ? f.hasPr : 'any',
    search: typeof f.search === 'string' ? f.search : '',
    hiddenColumns: arr(f.hiddenColumns, []),
    repos: arr(f.repos, []),
    projects: arr(f.projects, []),
  }
}

/** A tab of the Board view: its own name and filters (all tabs show the same fetched board). */
export interface BoardTab {
  id: string
  name: string
  filters: FilterState
  /** The GitHub account it shows (its repos, boards and "Mine"); absent: the primary. */
  account?: string
}

/** A tab's account: absent (old tabs) or no longer connected means the primary. */
export function tabAccount(t: { account?: string }, logins: string[]): string | undefined {
  return t.account && logins.includes(t.account) ? t.account : undefined
}

/** A tab for each newly connected account, once (`added` remembers which got one, so a closed tab stays closed). */
export function withAccountTabs<T extends { id: string; account?: string }>(
  tabs: T[],
  logins: string[],
  primary: string | null,
  added: string[],
  make: (login: string) => T,
): { tabs: T[]; added: string[] } {
  if (logins.length < 2) return { tabs, added }
  const fresh = logins.filter((l) => l !== primary && !added.includes(l) && !tabs.some((t) => t.account === l))
  return fresh.length ? { tabs: [...tabs, ...fresh.map(make)], added: [...added, ...fresh] } : { tabs, added }
}

/** The board as one account sees it: its boards' cards (a card on no board: by its repo) and columns. */
export function boardForAccount(b: Board, login: string | null, c: AppConfig): Board {
  if (!login || !isMulti(c)) return b
  const keys = new Set(c.accounts.find((a) => a.login === login)?.projects.map(projectKey) ?? [])
  const cards = b.cards.filter((card) => (card.project ? accountForProject(card.project, c) : accountForRepo(card.repo, c)) === login)
  const boards = (b.projects ?? []).filter((p) => keys.has(p.key))
  return { ...b, cards, projects: boards, columns: boards.length ? [...new Set(boards.flatMap((p) => p.columns))] : b.columns }
}

export interface FilterOptions {
  assignees: string[]
  labels: string[]
  milestones: string[]
}

/** The values present on the board, for the filter menus. `me` first among assignees. */
export function filterOptions(b: Board, me: string | null, users: string[] = []): FilterOptions {
  const who = new Set<string>(users)
  const labels = new Set<string>()
  const milestones = new Set<string>()
  for (const c of b.cards) {
    c.assignees.forEach((a) => who.add(a))
    c.labels.forEach((l) => labels.add(l))
    if (c.milestone) milestones.add(c.milestone)
  }
  const people = [...who].filter((u) => u !== me).sort((a, x) => a.localeCompare(x, undefined, { sensitivity: 'base' }))
  return { assignees: [...(me ? [me] : []), ...people], labels: [...labels].sort(), milestones: [...milestones].sort() }
}

export function matches(c: BoardCard, f: FilterState): boolean {
  if (f.repos?.length && !f.repos.some((r) => r.toLowerCase() === fullRepo(c.repo).toLowerCase())) return false
  if (f.projects?.length && (!c.project || !f.projects.includes(c.project))) return false
  if (f.assignees.length) {
    const hit = c.assignees.some((a) => f.assignees.includes(a)) || (c.assignees.length === 0 && f.assignees.includes(UNASSIGNED))
    if (!hit) return false
  }
  if (f.labels.length && !f.labels.some((l) => c.labels.includes(l))) return false
  if (f.milestone && c.milestone !== f.milestone) return false
  if (f.hasPr === 'with' && c.prs.length === 0) return false
  if (f.hasPr === 'without' && c.prs.length > 0) return false
  const q = f.search.trim().toLowerCase().replace(/^#/, '')
  if (q && !c.title.toLowerCase().includes(q) && !String(c.number).startsWith(q)) return false
  return true
}

/** The cards the filters let through; with some boards picked, only those boards' columns. */
export function applyFilters(b: Board, f: FilterState): Board {
  const cards = b.cards.filter((c) => matches(c, f))
  const boards = f.projects?.length ? (b.projects ?? []).filter((p) => f.projects.includes(p.key)) : []
  const columns = boards.length ? [...new Set(boards.flatMap((p) => p.columns))] : b.columns
  return { ...b, cards, columns }
}

/** The repos to offer in a board filter: the selected ones and any seen on cards. */
export function repoOptions(b: Board | null, selected: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of [...selected, ...(b?.cards ?? []).map((c) => fullRepo(c.repo))])
    if (r && !seen.has(r.toLowerCase())) {
      seen.add(r.toLowerCase())
      out.push(r)
    }
  return out
}

export type CardAction = 'session' | 'start' | 'pr' | 'assign'

/**
 * What clicking a card does: open its session; start one (mine, none yet); show the PR (someone
 * else's, with a PR); or assign it (someone else's or unassigned, no PR).
 */
export function cardAction(c: BoardCard, me: string | null, sessions: Session[]): CardAction {
  if (sessionForIssue(sessions, { repo: c.repo ?? null, number: c.number })) return 'session'
  const mine = me !== null && c.assignees.includes(me)
  if (mine) return 'start'
  return c.prs.length > 0 ? 'pr' : 'assign'
}

const OPEN = new Set(['OPEN', 'DRAFT'])

/** The PR to show first: the newest open one, else the newest. */
export function pickPr(prs: BoardPr[]): BoardPr | null {
  if (prs.length === 0) return null
  const open = prs.filter((p) => OPEN.has(p.state ?? ''))
  const pool = open.length ? open : prs
  return [...pool].sort((a, b) => b.number - a.number)[0]
}

/** A free session name for reviewing a PR: review-<repo>-<n>, then -2, -3, … */
export function reviewName(repo: string, n: number, sessions: Session[]): string {
  const base = `review-${repo.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}-${n}`
  const taken = new Set(sessions.filter((s) => s.state !== 'done').map((s) => s.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

export interface ReviewTarget {
  url: string
  repo: string
  number: number
  title: string
  author: string
  issue: number
  /** The issue's repo (owner/name); null or missing: the primary issue repo. */
  issueRepo?: string | null
}

/** `n`: the ticket's label, #12 or name#12. */
const REPLY = (n: string) =>
  `When you are done, blocked or have a question, tell master-agent with SendMessage. First line: '${n}: done', ` +
  `'${n}: blocked — <reason>' or '${n}: question — <question>'. When you have a question, ALSO ask the user directly in ` +
  `this session (so they see it here too), and wait for the answer from either place. If the user answers you here, tell ` +
  `master-agent '${n}: answered — <answer>'.`

/** The first message of a PR review session: read-only against the diff, review posted on GitHub. */
export function composeReviewPrompt(t: ReviewTarget, instructions: string): string {
  const [owner, repo] = new URL(t.url).pathname.split('/').filter(Boolean)
  const lines = [
    `Review ${owner}/${repo}#${t.number} (${t.title}) by @${t.author}, for ${ticketRef(t.issueRepo, t.issue)}. ${t.url}`,
    '',
    'Work read-only against the diff:',
    `- Read it with \`gh pr view ${t.url}\`, \`gh pr diff ${t.url}\` and, for full files, \`gh api repos/${owner}/${repo}/contents/<path>?ref=<head sha>\`.`,
    '- Do not check out the branch, create a worktree, commit, push or merge.',
    '',
    'Post the review on GitHub as ONE review with inline comments:',
    `- \`gh api repos/${owner}/${repo}/pulls/${t.number}/reviews\` with event "COMMENT", a short summary body, and a comment per finding (path, line, body).`,
    "- Never approve or request changes unless the user's instructions below say so.",
    '- Only comment on real problems (bugs, security, broken behaviour, missing tests on risky paths); no style nits.',
    '',
    REPLY(ticketLabel(t.issueRepo, t.issue)).replace(`'${ticketLabel(t.issueRepo, t.issue)}: done'`, `'${ticketLabel(t.issueRepo, t.issue)}: done — reviewed ${t.url}'`),
  ]
  const own = instructions.trim()
  if (own) lines.push('', "## The user's review instructions", '', own)
  return lines.join('\n')
}
