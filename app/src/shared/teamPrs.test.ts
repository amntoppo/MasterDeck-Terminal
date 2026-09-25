import { describe, expect, it } from 'vitest'
import { activeFilterCount, ageText, DEFAULT_PR_FILTERS, filterPrs, normalizePrFilters, parseTeamPrs, prFilterOptions, reviewLabel, teamPrSearches, type PrFilters } from './teamPrs'

const NOW = Date.parse('2026-09-25T12:00:00Z')
const node = (o: Record<string, unknown>) => ({
  url: `https://github.com/O/${o.repo ?? 'app'}/pull/${o.number}`,
  number: o.number,
  title: o.title ?? `PR ${o.number}`,
  state: o.state ?? 'OPEN',
  isDraft: o.draft ?? false,
  createdAt: o.createdAt ?? '2026-09-20T00:00:00Z',
  updatedAt: o.updatedAt ?? '2026-09-24T00:00:00Z',
  closedAt: null,
  mergedAt: null,
  headRefName: o.head ?? 'feat/x',
  baseRefName: 'dev',
  additions: o.add ?? 10,
  deletions: 2,
  changedFiles: 1,
  repository: { name: o.repo ?? 'app' },
  author: { login: o.author ?? 'alice' },
  reviewDecision: o.decision ?? 'REVIEW_REQUIRED',
  labels: { nodes: (o.labels as string[] | undefined)?.map((name) => ({ name, color: 'fff' })) ?? [] },
  reviewRequests: { nodes: ((o.requested as string[] | undefined) ?? []).map((login) => ({ requestedReviewer: { login } })) },
  latestReviews: { nodes: ((o.reviews as [string, string][] | undefined) ?? []).map(([login, state]) => ({ state, author: { login } })) },
  reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }].slice(0, (o.threads as number) ?? 1) },
  commits: { nodes: [{ commit: { statusCheckRollup: o.ci ? { state: o.ci } : null } }] },
  closingIssuesReferences: { nodes: [{ number: 900 + (o.number as number) }] },
})
const page = (...ns: Record<string, unknown>[]) => ({ data: { search: { nodes: ns.map(node) } } })

const prs = parseTeamPrs([
  page(
    { number: 1, author: 'alice', ci: 'FAILURE', updatedAt: '2026-09-25T10:00:00Z' },
    { number: 2, author: 'bob', repo: 'backend', requested: ['alice'], ci: 'SUCCESS', labels: ['bug'] },
    { number: 3, author: 'carol', state: 'MERGED', decision: 'APPROVED', reviews: [['alice', 'APPROVED']], updatedAt: '2026-09-01T00:00:00Z', add: 500 },
  ),
  page({ number: 4, author: 'carol', state: 'CLOSED', draft: true, threads: 0, updatedAt: '2026-09-10T00:00:00Z' }, { number: 1, author: 'alice' }),
])
const f = (o: Partial<PrFilters>) => ({ ...DEFAULT_PR_FILTERS, ...o })
const nums = (o: Partial<PrFilters>) => filterPrs(prs, f(o), 'alice', NOW).map((p) => p.number)

describe('team PRs', () => {
  it('parses pages, drops duplicates, newest first', () => {
    expect(prs.map((p) => p.number)).toEqual([1, 2, 4, 3])
    expect(prs[0]).toMatchObject({ state: 'open', ci: 'failure', unresolvedThreads: 1, issues: [901], author: 'alice' })
    expect(prs.find((p) => p.number === 3)).toMatchObject({ state: 'merged', reviewDecision: 'APPROVED' })
    expect(parseTeamPrs([{ nope: 1 }, null])).toEqual([])
  })
  it('filters by state, author, repo', () => {
    expect(nums({})).toEqual([1, 2])
    expect(nums({ state: 'merged' })).toEqual([3])
    expect(nums({ state: 'unmerged' })).toEqual([4])
    expect(nums({ state: 'closed' })).toEqual([4, 3])
    expect(nums({ state: 'all', author: '@me' })).toEqual([1])
    expect(nums({ state: 'all', author: 'carol' })).toEqual([4, 3])
    expect(nums({ repo: 'backend' })).toEqual([2])
  })
  it('filters by review, CI, drafts, age, label, threads, search', () => {
    expect(nums({ review: 'needs-me' })).toEqual([2])
    expect(nums({ state: 'all', review: 'reviewed-by-me' })).toEqual([3])
    expect(nums({ state: 'all', review: 'approved' })).toEqual([3])
    expect(nums({ ci: 'failing' })).toEqual([1])
    expect(nums({ ci: 'passing' })).toEqual([2])
    expect(nums({ state: 'all', drafts: 'only' })).toEqual([4])
    expect(nums({ state: 'all', drafts: 'exclude' })).toEqual([1, 2, 3])
    expect(nums({ state: 'all', updated: 7 })).toEqual([1, 2])
    expect(nums({ state: 'all', updated: -14 })).toEqual([4, 3])
    expect(nums({ label: 'bug' })).toEqual([2])
    expect(nums({ state: 'all', threads: 'unresolved' })).toEqual([1, 2, 3])
    expect(nums({ state: 'all', search: 'backend' })).toEqual([2])
    expect(nums({ state: 'all', search: '#903' })).toEqual([3])
  })
  it('sorts', () => {
    expect(nums({ state: 'all', sort: 'size' })[0]).toBe(3)
    expect(nums({ state: 'all', sort: 'oldest' })).toHaveLength(4)
  })
  it('builds options with me left out of authors', () => {
    expect(prFilterOptions(prs, 'alice')).toEqual({ repos: ['app', 'backend'], authors: ['bob', 'carol'], labels: ['bug'] })
  })
  it('normalizes stored filters and counts active ones', () => {
    expect(normalizePrFilters({ state: 'bogus', repo: 'x', updated: 'y' })).toEqual({ ...DEFAULT_PR_FILTERS, repo: 'x' })
    expect(activeFilterCount(f({ repo: 'x', sort: 'size' }))).toBe(1)
  })
  it('labels reviews and ages', () => {
    expect(reviewLabel(prs.find((p) => p.number === 2)!)).toEqual({ text: 'waiting on alice', tone: 'wait' })
    expect(reviewLabel(prs.find((p) => p.number === 3)!).tone).toBe('ok')
    expect(ageText('2026-09-25T09:00:00Z', NOW)).toBe('3h')
    expect(ageText('2026-09-20T12:00:00Z', NOW)).toBe('5d')
  })
  it('searches open PRs and the last 30 days of closed ones', () => {
    expect(teamPrSearches('O', NOW).closed).toBe('org:O is:pr is:closed closed:>=2026-08-26 sort:updated-desc')
  })
})
