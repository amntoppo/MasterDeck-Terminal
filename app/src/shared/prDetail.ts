import { safeRef, type PrRef } from './prWatch'

/**
 * A PR in depth, for Session details → GitHub (#103): its checks, the latest review of each
 * reviewer, unresolved review threads and comments. Read once when its row opens (and again when
 * the PR changes), never kept in AppState.
 */

export type CheckState = 'success' | 'failure' | 'pending' | 'neutral'

export interface PrCheck {
  name: string
  state: CheckState
  url: string | null
}
export interface PrReview {
  author: string
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED */
  state: string
  at: number | null
  url: string | null
}
export interface PrThread {
  path: string
  author: string
  text: string
  url: string | null
}
export interface PrComment {
  author: string
  at: number | null
  text: string
  url: string | null
}
export interface PrDetail {
  checks: PrCheck[]
  reviews: PrReview[]
  threads: PrThread[]
  comments: PrComment[]
}

export const TEXT_MAX = 300

// ponytail: windows of the newest 100 checks, 50 reviews, 100 threads and 50 comments; page if a PR outgrows them.
// Never put the word for a GraphQL write in here: ghcache would take the read for one.
const FIELDS =
  'commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}} ' +
  'reviews(last:50){nodes{state submittedAt url author{login}}} ' +
  'reviewThreads(last:100){nodes{isResolved isOutdated path comments(last:1){nodes{body url author{login}}}}} ' +
  'comments(last:50){nodes{createdAt body url author{login}}}'

export function prDetailQuery(ref: PrRef): string {
  if (!safeRef(ref)) throw new Error('unsafe PR reference')
  return `query{repository(owner:"${ref.owner}",name:"${ref.repo}"){pullRequest(number:${ref.number}){${FIELDS}}}}`
}

type J = Record<string, unknown>
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const nodes = (v: unknown): J[] => (Array.isArray(o(v).nodes) ? (o(v).nodes as unknown[]).map(o) : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const login = (v: unknown): string => s(o(v).login) || 'ghost'
const time = (v: unknown): number | null => {
  const t = Date.parse(s(v))
  return Number.isFinite(t) ? t : null
}
const link = (v: unknown): string | null => (/^https:\/\//.test(s(v)) ? s(v) : null)

/** One line of at most TEXT_MAX characters, with control and direction characters taken out. */
export function clipLine(t: string, max = TEXT_MAX): string {
  // eslint-disable-next-line no-control-regex
  const flat = t.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function checkRun(n: J): PrCheck {
  const status = s(n.status)
  const c = s(n.conclusion)
  const state: CheckState =
    status !== 'COMPLETED'
      ? 'pending'
      : c === 'SUCCESS'
        ? 'success'
        : c === 'NEUTRAL' || c === 'SKIPPED' || c === 'STALE'
          ? 'neutral'
          : 'failure'
  return { name: s(n.name) || 'check', state, url: link(n.detailsUrl) }
}

function statusContext(n: J): PrCheck {
  const st = s(n.state)
  const state: CheckState = st === 'SUCCESS' ? 'success' : st === 'PENDING' || st === 'EXPECTED' ? 'pending' : 'failure'
  return { name: s(n.context) || 'status', state, url: link(n.targetUrl) }
}

const CHECK_ORDER: CheckState[] = ['failure', 'pending', 'success', 'neutral']

/** The answer to `prDetailQuery`; null when it holds no PR (gone, no access, not JSON). */
export function parsePrDetail(text: string): PrDetail | null {
  let pr: J
  try {
    pr = o(o(o(o(JSON.parse(text)).data).repository).pullRequest)
  } catch {
    return null
  }
  if (!Object.keys(pr).length) return null
  const commit = o(nodes(pr.commits)[0]?.commit)
  const checks = nodes(o(o(commit.statusCheckRollup).contexts))
    .map((n) => (n.__typename === 'StatusContext' ? statusContext(n) : checkRun(n)))
    .sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state) || a.name.localeCompare(b.name))
  // The latest review of each reviewer (GitHub lists them oldest first); a lone COMMENTED after a
  // decision does not hide that decision.
  const byAuthor = new Map<string, PrReview>()
  for (const r of nodes(pr.reviews)) {
    const review = { author: login(r.author), state: s(r.state), at: time(r.submittedAt), url: link(r.url) }
    if (!review.state || review.state === 'PENDING') continue
    const had = byAuthor.get(review.author)
    if (had && review.state === 'COMMENTED' && had.state !== 'COMMENTED') continue
    byAuthor.set(review.author, review)
  }
  const reviews = [...byAuthor.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const threads = nodes(pr.reviewThreads)
    .filter((t) => t.isResolved !== true && t.isOutdated !== true)
    .map((t) => {
      const c = nodes(t.comments)[0] ?? {}
      return { path: s(t.path), author: login(c.author), text: clipLine(s(c.body)), url: link(c.url) }
    })
    .reverse()
  const comments = nodes(pr.comments)
    .map((c) => ({ author: login(c.author), at: time(c.createdAt), text: clipLine(s(c.body)), url: link(c.url) }))
    .reverse()
  return { checks, reviews, threads, comments }
}

export function checkCounts(checks: PrCheck[]): { passed: number; failed: number; pending: number } {
  return {
    passed: checks.filter((c) => c.state === 'success' || c.state === 'neutral').length,
    failed: checks.filter((c) => c.state === 'failure').length,
    pending: checks.filter((c) => c.state === 'pending').length,
  }
}

/** What one PR's line shows, as Session details reads it from prLive and the snapshot. */
export interface PrStatusLine {
  done: boolean
  ci: 'success' | 'failure' | 'pending' | null
  threads: number
  review: string | null
}

export type PrWorst = 'ci-failing' | 'changes' | 'threads' | 'ci-running' | 'ok' | 'done' | null

/** The worst of the open PRs, for the collapsed Pull requests row; 'done' when every PR ended. */
export function worstPrStatus(rows: PrStatusLine[]): PrWorst {
  if (!rows.length) return null
  const open = rows.filter((r) => !r.done)
  if (!open.length) return 'done'
  if (open.some((r) => r.ci === 'failure')) return 'ci-failing'
  if (open.some((r) => r.review === 'CHANGES_REQUESTED')) return 'changes'
  if (open.some((r) => r.threads > 0)) return 'threads'
  if (open.some((r) => r.ci === 'pending')) return 'ci-running'
  return 'ok'
}
