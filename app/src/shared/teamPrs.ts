/** Every PR in the org (mine and the team's), for the PRs view: parsing, filtering and sorting. */

export type PrState = 'open' | 'merged' | 'closed'
export type Ci = 'success' | 'failure' | 'pending' | null
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null

export interface TeamPr {
  url: string
  repo: string
  number: number
  title: string
  state: PrState
  draft: boolean
  author: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  mergedAt: string | null
  headRef: string
  baseRef: string
  additions: number
  deletions: number
  files: number
  reviewDecision: ReviewDecision
  labels: { name: string; color: string }[]
  /** Users (and teams, as "team:<name>") asked to review and not yet reviewed. */
  requested: string[]
  /** Each reviewer's latest review. */
  reviews: { login: string; state: string }[]
  unresolvedThreads: number
  ci: Ci
  issues: number[]
}

/** The GraphQL query MasterDeck runs (one search page of 100). */
export const TEAM_PR_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        url number title state isDraft createdAt updatedAt closedAt mergedAt headRefName baseRefName
        additions deletions changedFiles
        repository { name }
        author { login }
        reviewDecision
        labels(first: 10) { nodes { name color } }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
        latestReviews(first: 10) { nodes { state author { login } } }
        reviewThreads(first: 50) { nodes { isResolved } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        closingIssuesReferences(first: 3) { nodes { number } }
      }
    }
  }
}`

/**
 * Closed and merged PRs: the same fields minus review threads, review requests and CI, which
 * matter only while a PR is open. The full query times out (HTTP 502) on 100 closed PRs.
 */
export const TEAM_PR_CLOSED_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        url number title state isDraft createdAt updatedAt closedAt mergedAt headRefName baseRefName
        additions deletions changedFiles
        repository { name }
        author { login }
        reviewDecision
        labels(first: 5) { nodes { name color } }
        latestReviews(first: 5) { nodes { state author { login } } }
        closingIssuesReferences(first: 3) { nodes { number } }
      }
    }
  }
}`

/** Closed or merged PRs are fetched for this many days back, newest first, at most this many. */
export const CLOSED_DAYS = 30
export const CLOSED_MAX = 300

/** Search strings: every open PR, and PRs closed or merged in the last `days` days. */
export function teamPrSearches(owner: string, now: number, days = CLOSED_DAYS, qualifier: 'org' | 'user' = 'org'): { open: string; closed: string } {
  const since = new Date(now - days * 86_400_000).toISOString().slice(0, 10)
  return {
    open: `${qualifier}:${owner} is:pr is:open sort:updated-desc`,
    closed: `${qualifier}:${owner} is:pr is:closed closed:>=${since} sort:updated-desc`,
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const nodes = (v: unknown): Obj[] => {
  const n = obj(v).nodes
  return Array.isArray(n) ? n.map(obj) : []
}

function ciOf(rollup: unknown): Ci {
  switch (str(obj(rollup).state)) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return null
  }
}

export function parseTeamPr(raw: unknown): TeamPr | null {
  const n = obj(raw)
  const url = str(n.url)
  if (!url || typeof n.number !== 'number') return null
  const st = str(n.state)
  const decision = str(n.reviewDecision)
  const commit = obj(nodes(n.commits)[0]?.commit)
  return {
    url,
    repo: str(obj(n.repository).name),
    number: n.number,
    title: str(n.title),
    state: st === 'MERGED' ? 'merged' : st === 'CLOSED' ? 'closed' : 'open',
    draft: n.isDraft === true,
    author: str(obj(n.author).login) || 'ghost',
    createdAt: str(n.createdAt),
    updatedAt: str(n.updatedAt),
    closedAt: str(n.closedAt) || null,
    mergedAt: str(n.mergedAt) || null,
    headRef: str(n.headRefName),
    baseRef: str(n.baseRefName),
    additions: num(n.additions),
    deletions: num(n.deletions),
    files: num(n.changedFiles),
    reviewDecision: decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED' ? decision : null,
    labels: nodes(n.labels).map((l) => ({ name: str(l.name), color: str(l.color) })).filter((l) => l.name),
    requested: nodes(n.reviewRequests)
      .map((r) => obj(r.requestedReviewer))
      .map((r) => (r.login ? str(r.login) : r.name ? `team:${str(r.name)}` : ''))
      .filter(Boolean),
    reviews: nodes(n.latestReviews)
      .map((r) => ({ login: str(obj(r.author).login), state: str(r.state) }))
      .filter((r) => r.login && r.state),
    unresolvedThreads: nodes(n.reviewThreads).filter((t) => t.isResolved === false).length,
    ci: ciOf(commit.statusCheckRollup),
    issues: nodes(n.closingIssuesReferences).map((i) => num(i.number)).filter((x) => x > 0),
  }
}

/** Search result pages to PRs, newest first and without duplicates. */
export function parseTeamPrs(pages: unknown[]): TeamPr[] {
  const seen = new Map<string, TeamPr>()
  for (const page of pages)
    for (const raw of nodes(obj(obj(obj(page).data).search))) {
      const pr = parseTeamPr(raw)
      if (pr && !seen.has(pr.url)) seen.set(pr.url, pr)
    }
  return [...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// --- filters ---------------------------------------------------------------------------------

export interface PrFilters {
  state: 'open' | 'closed' | 'merged' | 'unmerged' | 'all'
  /** '' = anyone, '@me' = me, else a login. */
  author: string
  repo: string
  review: 'any' | 'needs-me' | 'approved' | 'changes' | 'waiting' | 'reviewed-by-me'
  ci: 'any' | 'failing' | 'passing' | 'pending'
  drafts: 'include' | 'exclude' | 'only'
  /** Updated within N days (0 = any); negative = stale, not updated for -N days. */
  updated: number
  label: string
  threads: 'any' | 'unresolved'
  search: string
  sort: 'updated' | 'created' | 'oldest' | 'size'
}

export const DEFAULT_PR_FILTERS: PrFilters = {
  state: 'open',
  author: '',
  repo: '',
  review: 'any',
  ci: 'any',
  drafts: 'include',
  updated: 0,
  label: '',
  threads: 'any',
  search: '',
  sort: 'updated',
}

export function normalizePrFilters(v: unknown): PrFilters {
  const o = obj(v)
  const pick = <K extends keyof PrFilters>(k: K, ok: (x: unknown) => boolean): PrFilters[K] => (ok(o[k]) ? (o[k] as PrFilters[K]) : DEFAULT_PR_FILTERS[k])
  const oneOf = (...xs: string[]) => (x: unknown) => typeof x === 'string' && xs.includes(x)
  const isStr = (x: unknown) => typeof x === 'string'
  return {
    state: pick('state', oneOf('open', 'closed', 'merged', 'unmerged', 'all')),
    author: pick('author', isStr),
    repo: pick('repo', isStr),
    review: pick('review', oneOf('any', 'needs-me', 'approved', 'changes', 'waiting', 'reviewed-by-me')),
    ci: pick('ci', oneOf('any', 'failing', 'passing', 'pending')),
    drafts: pick('drafts', oneOf('include', 'exclude', 'only')),
    updated: pick('updated', (x) => typeof x === 'number' && Number.isFinite(x)),
    label: pick('label', isStr),
    threads: pick('threads', oneOf('any', 'unresolved')),
    search: pick('search', isStr),
    sort: pick('sort', oneOf('updated', 'created', 'oldest', 'size')),
  }
}

/** How many filters differ from the defaults (for "Reset filters"). */
export function activeFilterCount(f: PrFilters): number {
  return (Object.keys(DEFAULT_PR_FILTERS) as (keyof PrFilters)[]).filter((k) => k !== 'sort' && f[k] !== DEFAULT_PR_FILTERS[k]).length
}

export function matchesPr(p: TeamPr, f: PrFilters, me: string | null, now: number): boolean {
  if (f.state === 'unmerged' ? p.state !== 'closed' : f.state === 'closed' ? p.state === 'open' : f.state !== 'all' && p.state !== f.state) return false
  const author = f.author === '@me' ? me : f.author
  if (author && p.author.toLowerCase() !== author.toLowerCase()) return false
  if (f.repo && p.repo !== f.repo) return false
  const isMe = (l: string) => !!me && l.toLowerCase() === me.toLowerCase()
  switch (f.review) {
    case 'needs-me':
      if (!p.requested.some(isMe)) return false
      break
    case 'approved':
      if (p.reviewDecision !== 'APPROVED') return false
      break
    case 'changes':
      if (p.reviewDecision !== 'CHANGES_REQUESTED') return false
      break
    case 'waiting':
      if (p.reviewDecision === 'APPROVED' || p.reviewDecision === 'CHANGES_REQUESTED' || p.state !== 'open') return false
      break
    case 'reviewed-by-me':
      if (!p.reviews.some((r) => isMe(r.login))) return false
      break
  }
  if (f.ci !== 'any' && p.ci !== ({ failing: 'failure', passing: 'success', pending: 'pending' } as const)[f.ci]) return false
  if (f.drafts === 'exclude' && p.draft) return false
  if (f.drafts === 'only' && !p.draft) return false
  if (f.updated) {
    const age = now - Date.parse(p.updatedAt)
    const days = Math.abs(f.updated) * 86_400_000
    if (f.updated > 0 ? age > days : age < days) return false
  }
  if (f.label && !p.labels.some((l) => l.name === f.label)) return false
  if (f.threads === 'unresolved' && p.unresolvedThreads === 0) return false
  const q = f.search.trim().toLowerCase()
  if (q) {
    const hay = `${p.title} #${p.number} ${p.repo}#${p.number} ${p.headRef} ${p.author} ${p.issues.map((i) => `#${i}`).join(' ')}`.toLowerCase()
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false
  }
  return true
}

export function filterPrs(prs: TeamPr[], f: PrFilters, me: string | null, now: number): TeamPr[] {
  const out = prs.filter((p) => matchesPr(p, f, me, now))
  const by: Record<PrFilters['sort'], (a: TeamPr, b: TeamPr) => number> = {
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    size: (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  }
  return out.sort(by[f.sort])
}

/** Dropdown options from the loaded PRs; me first among authors. */
export function prFilterOptions(prs: TeamPr[], me: string | null): { repos: string[]; authors: string[]; labels: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const authors = uniq(prs.map((p) => p.author)).filter((a) => !me || a.toLowerCase() !== me.toLowerCase())
  return { repos: uniq(prs.map((p) => p.repo)), authors, labels: uniq(prs.flatMap((p) => p.labels.map((l) => l.name))) }
}

/** Short review text for the table. */
export function reviewLabel(p: TeamPr): { text: string; tone: 'ok' | 'bad' | 'wait' | 'muted' } {
  const count = (s: string) => p.reviews.filter((r) => r.state === s).length
  if (p.reviewDecision === 'CHANGES_REQUESTED') return { text: `changes requested (${count('CHANGES_REQUESTED') || 1})`, tone: 'bad' }
  if (p.reviewDecision === 'APPROVED') return { text: `approved (${count('APPROVED') || 1})`, tone: 'ok' }
  if (p.draft) return { text: 'draft', tone: 'muted' }
  if (p.requested.length) return { text: `waiting on ${p.requested.map((r) => r.replace(/^team:/, '')).slice(0, 2).join(', ')}${p.requested.length > 2 ? ` +${p.requested.length - 2}` : ''}`, tone: 'wait' }
  if (count('COMMENTED')) return { text: `commented (${count('COMMENTED')})`, tone: 'muted' }
  return { text: p.state === 'open' ? 'no reviews yet' : '—', tone: 'muted' }
}

/** "3h", "2d", "5w" since an ISO time. */
export function ageText(iso: string | null, now: number): string {
  if (!iso) return '—'
  const m = Math.max(0, (now - Date.parse(iso)) / 60_000)
  if (m < 60) return `${Math.round(m)}m`
  if (m < 60 * 24) return `${Math.round(m / 60)}h`
  if (m < 60 * 24 * 14) return `${Math.round(m / 1440)}d`
  return `${Math.round(m / 10_080)}w`
}
