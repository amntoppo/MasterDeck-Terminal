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
}

/** The jq filter for the REST answer: one compact object per line, the repository as owner/name. */
export const SUB_ISSUES_JQ = '.[] | {number, title, state, url: .html_url, repo: ((.repository_url // "") | sub("^.*/repos/"; ""))}'

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/** The lines `gh api … --jq SUB_ISSUES_JQ` prints, as sub-issues; a malformed line is skipped. */
export function parseSubIssues(stdout: string, parentRepo: string | null = null): SubIssue[] {
  const out: SubIssue[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let o: { number?: unknown; title?: unknown; state?: unknown; url?: unknown; repo?: unknown } | null
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
