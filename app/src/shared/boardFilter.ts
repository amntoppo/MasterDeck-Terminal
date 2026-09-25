import { issueRef } from './appConfig'
import { sessionForIssue } from './derive'
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
}

export function defaultFilters(me: string | null): FilterState {
  return { assignees: me ? [me] : [], labels: [], milestone: null, hasPr: 'any', search: '', hiddenColumns: [] }
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

export function applyFilters(b: Board, f: FilterState): Board {
  return { ...b, cards: b.cards.filter((c) => matches(c, f)) }
}

export type CardAction = 'session' | 'start' | 'pr' | 'assign'

/**
 * What clicking a card does: open its session; start one (mine, none yet); show the PR (someone
 * else's, with a PR); or assign it (someone else's or unassigned, no PR).
 */
export function cardAction(c: BoardCard, me: string | null, sessions: Session[]): CardAction {
  if (sessionForIssue(sessions, c.number)) return 'session'
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
}

const REPLY = (n: number) =>
  `When you are done, blocked or have a question, tell master-agent with SendMessage. First line: '#${n}: done', ` +
  `'#${n}: blocked — <reason>' or '#${n}: question — <question>'. When you have a question, ALSO ask the user directly in ` +
  `this session (so they see it here too), and wait for the answer from either place. If the user answers you here, tell ` +
  `master-agent '#${n}: answered — <answer>'.`

/** The first message of a PR review session: read-only against the diff, review posted on GitHub. */
export function composeReviewPrompt(t: ReviewTarget, instructions: string): string {
  const [owner, repo] = new URL(t.url).pathname.split('/').filter(Boolean)
  const lines = [
    `Review ${owner}/${repo}#${t.number} (${t.title}) by @${t.author}, for ${issueRef()}#${t.issue}. ${t.url}`,
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
    REPLY(t.issue).replace("'#" + t.issue + ": done'", `'#${t.issue}: done — reviewed ${t.url}'`),
  ]
  const own = instructions.trim()
  if (own) lines.push('', "## The user's review instructions", '', own)
  return lines.join('\n')
}
