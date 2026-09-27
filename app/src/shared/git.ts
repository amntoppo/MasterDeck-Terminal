import type { PrLive } from './types'

/** Parse `git status --porcelain=v2 --branch`. */
export function parseBranchStatus(text: string): { branch: string | null; ahead: number; behind: number } {
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const b = line.slice('# branch.head '.length).trim()
      branch = b === '(detached)' ? null : b
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    }
  }
  return { branch, ahead, behind }
}

/** Parse `git diff --numstat`. Binary files (`-\t-`) count as files with no lines. */
export function parseNumstat(text: string): { added: number; removed: number; files: number } {
  let added = 0
  let removed = 0
  let files = 0
  for (const line of text.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    files++
    if (parts[0] !== '-') added += Number(parts[0]) || 0
    if (parts[1] !== '-') removed += Number(parts[1]) || 0
  }
  return { added, removed, files }
}

const FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'EXPECTED', 'REQUESTED'])

/** Parse `gh pr view --json number,url,state,reviewDecision,statusCheckRollup`. */
function time(v: unknown): number | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

function latest(ts: (number | null)[]): number | null {
  const ok = ts.filter((t): t is number => t !== null)
  return ok.length ? Math.max(...ok) : null
}

/** `gh pr view` fields, with comments and reviews cut to their times (their bodies can be long). */
export const PR_VIEW_ARGS = [
  '--json',
  'number,title,url,state,reviewDecision,statusCheckRollup,isDraft,createdAt,comments,reviews',
  '--jq',
  '{number,title,url,state,reviewDecision,statusCheckRollup,isDraft,createdAt,comments:[.comments[]|{createdAt}],reviews:[.reviews[]|{submittedAt}]}',
]

export function parsePrView(text: string): PrLive | null {
  let r: Record<string, unknown>
  try {
    r = JSON.parse(text)
  } catch {
    return null
  }
  if (!r || typeof r.number !== 'number' || typeof r.url !== 'string') return null
  const checks = Array.isArray(r.statusCheckRollup) ? (r.statusCheckRollup as Record<string, unknown>[]) : []
  let ci: PrLive['ci'] = null
  if (checks.length > 0) {
    const states = checks.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase())
    if (states.some((s) => FAIL.has(s))) ci = 'failure'
    else if (states.some((s) => PENDING.has(s) || s === '')) ci = 'pending'
    else ci = 'success'
  }
  return {
    number: r.number,
    title: typeof r.title === 'string' ? r.title : null,
    url: r.url,
    state: typeof r.state === 'string' ? r.state : 'OPEN',
    reviewDecision: typeof r.reviewDecision === 'string' && r.reviewDecision ? r.reviewDecision : null,
    ci,
    isDraft: r.isDraft === true,
    createdAt: time(r.createdAt),
    lastCommentAt: latest([
      ...(Array.isArray(r.comments) ? (r.comments as Record<string, unknown>[]).map((c) => time(c?.createdAt)) : []),
      ...(Array.isArray(r.reviews) ? (r.reviews as Record<string, unknown>[]).map((c) => time(c?.submittedAt)) : []),
    ]),
  }
}
