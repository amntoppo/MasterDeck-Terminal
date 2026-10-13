import { storedRepo, ticketKey } from './ticket'
import type { BoardCard } from './types'

/** A sub-issue as GitHub lists it under its parent (REST `issues/{n}/sub_issues`). */
export interface SubIssue {
  /** owner/name; null: the primary issue repo. */
  repo: string | null
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  /** Its description (Markdown), '' when it has none; cut at SUB_BODY_MAX characters. */
  body: string
  /** The read cut the description. */
  bodyCut: boolean
  /** Logins. */
  assignees: string[]
  /** color: six hex digits, null when GitHub gave none we can use. */
  labels: { name: string; color: string | null }[]
}

/**
 * A description longer than this is cut in the read: 100 sub-issues (GitHub's limit) stay near 1 MB,
 * an answer the web app also gets over the bridge.
 */
export const SUB_BODY_MAX = 10000

/** The jq filter for the REST answer: one compact object per line, the repository as owner/name. */
export const SUB_ISSUES_JQ =
  '.[] | {number, title, state, url: .html_url, repo: ((.repository_url // "") | sub("^.*/repos/"; "")), ' +
  `body: ((.body // "") | .[0:${SUB_BODY_MAX}]), bodyCut: ((.body // "") | length > ${SUB_BODY_MAX}), ` +
  'assignees: [.assignees[]?.login], labels: [.labels[]? | {name, color}]}'

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const LOGIN = /^[A-Za-z0-9-]{1,39}$/
const COLOR = /^[0-9a-f]{6}$/i

function labelsOf(v: unknown): SubIssue['labels'] {
  if (!Array.isArray(v)) return []
  const out: SubIssue['labels'] = []
  for (const l of v) {
    if (!l || typeof l !== 'object' || typeof (l as { name?: unknown }).name !== 'string') continue
    const { name, color } = l as { name: string; color?: unknown }
    out.push({ name, color: typeof color === 'string' && COLOR.test(color) ? color.toLowerCase() : null })
  }
  return out
}

/** The lines `gh api … --jq SUB_ISSUES_JQ` prints, as sub-issues; a malformed line is skipped. */
export function parseSubIssues(stdout: string, parentRepo: string | null = null): SubIssue[] {
  const out: SubIssue[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown> | null
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || typeof o.number !== 'number' || !Number.isInteger(o.number) || o.number <= 0) continue
    const repo = typeof o.repo === 'string' && REPO.test(o.repo) ? storedRepo(o.repo) : parentRepo
    out.push({
      repo,
      number: o.number,
      title: typeof o.title === 'string' ? o.title : '',
      url: typeof o.url === 'string' && o.url.startsWith('https://github.com/') ? o.url : '',
      state: o.state === 'closed' ? 'closed' : 'open',
      body: typeof o.body === 'string' ? o.body.replace(/\r\n/g, '\n').trim() : '',
      bodyCut: o.bodyCut === true,
      assignees: Array.isArray(o.assignees) ? o.assignees.filter((a): a is string => typeof a === 'string' && LOGIN.test(a)) : [],
      labels: labelsOf(o.labels),
    })
  }
  return out
}

export interface SubIssueRow extends SubIssue {
  /** Its board column when a card holds it, else "Open" / "Closed". */
  status: string
  /** Closed on GitHub: what "done" means for the progress line, as on GitHub. */
  done: boolean
}

/** Each sub-issue with the status the popup shows: its column on the board, else open or closed. */
export function subIssueRows(subs: SubIssue[], cards: BoardCard[] = []): SubIssueRow[] {
  const byKey = new Map(cards.map((c) => [ticketKey(c.repo, c.number), c]))
  return subs.map((s) => {
    const card = byKey.get(ticketKey(s.repo, s.number))
    return { ...s, status: card?.status || (s.state === 'closed' ? 'Closed' : 'Open'), done: s.state === 'closed' }
  })
}

/** "2 / 5 done". */
export function subIssueProgress(rows: { done: boolean }[]): string {
  return `${rows.filter((r) => r.done).length} / ${rows.length} done`
}
