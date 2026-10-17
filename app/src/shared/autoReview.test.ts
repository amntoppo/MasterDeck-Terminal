import { describe, expect, it } from 'vitest'
import {
  autoPrompt, autoQuery, inputBoxRows, autoSearch, autoStatusLine, mergeArgs, mergeGuard, normalizeTab, parseAutoAnswer, parseTurn, readyToMerge, reconcile, trackKey,
  MISS_MAX, STALL_MS, type AutoPr, type AutoReviewTab, type AutoTrack, type ReconcileIn,
} from './autoReview'
import { DEFAULT_PR_FILTERS } from './teamPrs'

const URL1 = 'https://github.com/acme/web/pull/12'
const URL2 = 'https://github.com/acme/api/pull/7'

const pr = (over: Partial<AutoPr> = {}): AutoPr => ({
  url: URL1, repo: 'acme/web', number: 12, title: 'Fix login', author: 'bob', draft: false, state: 'OPEN', head: 'aaa', base: 'main', branch: 'fix-login',
  mergeable: 'MERGEABLE', mergeState: 'CLEAN', decision: 'APPROVED', checks: 'SUCCESS', additions: 10, deletions: 2, files: 3, method: 'SQUASH', reviews: [],
  ...over,
})

const tab = (over: Partial<AutoReviewTab> = {}): AutoReviewTab => ({ review: true, merge: false, name: 'Mine', account: null, filters: DEFAULT_PR_FILTERS, since: 1, ...over })

const track = (over: Partial<AutoTrack> = {}): AutoTrack => ({
  key: trackKey(null, URL1), url: URL1, repo: 'acme/web', number: 12, title: 'Fix login', author: 'bob', tabId: 't1', account: null,
  status: 'reviewing', head: 'aaa', sentHead: 'aaa', sentAt: 1_000, reviewUrl: null, comments: 0, told: [], mergeTried: null, note: null, at: 1_000, misses: 0,
  ...over,
})

const run = (over: Partial<ReconcileIn>) =>
  reconcile({ tabId: 't1', tab: tab(), viewer: 'alice', requested: [], tracked: new Map(), tracks: [], now: 10_000, ...over })

const review = (over: Partial<AutoPr['reviews'][number]> = {}) => ({ login: 'alice', state: 'COMMENTED', at: new Date(2_000).toISOString(), url: 'https://github.com/acme/web/pull/12#pullrequestreview-1', commit: 'aaa', comments: 3, ...over })

describe('autoSearch', () => {
  it('asks for review requests to me, scoped to the repo, else the owner', () => {
    expect(autoSearch('acme', 'organization', 'web')).toBe('is:pr is:open review-requested:@me archived:false sort:updated-desc repo:acme/web')
    expect(autoSearch('acme', 'organization', '')).toMatch(/ org:acme$/)
    expect(autoSearch('bob', 'user', '')).toMatch(/ user:bob$/)
    expect(autoSearch(null, 'organization', 'web')).not.toMatch(/repo:|org:/)
    // Nothing odd reaches the query.
    expect(autoSearch('acme', 'organization', 'web repo:evil/x')).toMatch(/ org:acme$/)
    expect(autoSearch('ac me', 'organization', '')).not.toMatch(/org:/)
  })
})

describe('autoQuery', () => {
  it('reads the search and the tracked PRs in one query, never a write', () => {
    const q = autoQuery([{ owner: 'acme', repo: 'web', number: 12 }], true)
    expect(q).toContain('search(query:$q')
    expect(q).toContain('t0: repository(owner:"acme",name:"web"){pullRequest(number:12)')
    expect(q).toContain('viewerDefaultMergeMethod')
    expect(q.toLowerCase()).not.toContain('mutation')
    expect(autoQuery([], false)).toBe('query{viewer{login} }')
    expect(() => autoQuery([{ owner: 'a"b', repo: 'web', number: 1 }], false)).toThrow()
  })
})

describe('parseAutoAnswer', () => {
  const raw = {
    url: URL1, number: 12, title: 'Fix login', isDraft: false, state: 'OPEN', headRefOid: 'aaa', baseRefName: 'main', headRefName: 'fix-login', mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', additions: 10, deletions: 2, changedFiles: 3, author: { login: 'bob' },
    repository: { nameWithOwner: 'acme/web', viewerDefaultMergeMethod: 'SQUASH' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    latestReviews: { nodes: [{ state: 'COMMENTED', submittedAt: '2026-10-17T10:00:00Z', url: 'u', author: { login: 'alice' }, commit: { oid: 'aaa' }, comments: { totalCount: 2 } }] },
  }
  it('reads the viewer, the search and the tracked PRs', () => {
    const a = parseAutoAnswer(JSON.stringify({ data: { viewer: { login: 'alice' }, s: { nodes: [raw, {}] }, t0: { pullRequest: raw }, t1: { pullRequest: null } } }), 2)
    expect(a.viewer).toBe('alice')
    expect(a.requested).toHaveLength(1)
    expect(a.requested![0]).toMatchObject({ repo: 'acme/web', head: 'aaa', checks: 'SUCCESS', method: 'SQUASH', reviews: [{ login: 'alice', comments: 2, commit: 'aaa' }] })
    expect(a.tracked[0]?.url).toBe(URL1)
    expect(a.tracked[1]).toBeNull()
  })
  it('without a search, requested is null; garbage is nothing', () => {
    expect(parseAutoAnswer(JSON.stringify({ data: { viewer: { login: 'alice' } } }), 0).requested).toBeNull()
    expect(parseAutoAnswer('not json', 1)).toEqual({ viewer: null, requested: null, tracked: [null] })
  })
})

describe('reconcile: request detection and de-duplication', () => {
  it('queues a new request once', () => {
    const a = run({ requested: [pr({ decision: 'REVIEW_REQUIRED' })] })
    expect(a.tracks).toHaveLength(1)
    expect(a.tracks[0]).toMatchObject({ status: 'queued', tabId: 't1', head: 'aaa', sentHead: null })
    expect(a.events[0]).toContain('review requested: acme/web#12')
    // The next poll still sees the request: nothing new.
    const b = run({ requested: [pr({ decision: 'REVIEW_REQUIRED' })], tracks: a.tracks })
    expect(b.tracks).toHaveLength(1)
    expect(b.events).toEqual([])
  })
  it('skips drafts and closed PRs', () => {
    expect(run({ requested: [pr({ draft: true }), pr({ url: URL2, state: 'CLOSED' })] }).tracks).toEqual([])
  })
  it('another tab of the same account never reviews it twice; another account does', () => {
    const a = run({ requested: [pr()] })
    const b = run({ tabId: 't2', requested: [pr()], tracks: a.tracks })
    expect(b.tracks).toHaveLength(1)
    expect(b.tracks[0].tabId).toBe('t1')
    const c = run({ tabId: 't3', tab: tab({ account: 'carol' }), requested: [pr()], tracks: a.tracks })
    expect(c.tracks.map((t) => t.tabId).sort()).toEqual(['t1', 't3'])
  })
  it('a merged PR asked for again is a new review', () => {
    const a = run({ requested: [pr()], tracks: [track({ status: 'merged', at: 9_000 })] })
    expect(a.tracks[0]).toMatchObject({ status: 'queued', sentHead: null })
  })
})

describe('reconcile: following a review', () => {
  it('comments sent: once, with the count and a link', () => {
    const p = pr({ decision: 'REVIEW_REQUIRED', reviews: [review()] })
    const a = run({ tracked: new Map([[URL1, p]]), tracks: [track()] })
    expect(a.tracks[0]).toMatchObject({ status: 'commented', comments: 3, reviewUrl: review().url })
    expect(a.notices).toEqual([expect.objectContaining({ kind: 'sent', title: 'Review comments sent on acme/web#12', url: review().url })])
    expect(a.notices[0].body).toContain('3 inline comments')
    expect(run({ tracked: new Map([[URL1, p]]), tracks: a.tracks }).notices).toEqual([])
  })
  it('someone else’s review does not count', () => {
    const a = run({ tracked: new Map([[URL1, pr({ reviews: [review({ login: 'dave' })] })]]), tracks: [track()] })
    expect(a.tracks[0].status).toBe('reviewing')
  })
  it('no review after an hour is stalled, and not sent again', () => {
    const a = run({ now: 1_000 + STALL_MS + 1, tracked: new Map([[URL1, pr()]]), tracks: [track()] })
    expect(a.tracks[0].status).toBe('stalled')
  })
  it('reviewed again only when new commits arrive', () => {
    const same = run({ requested: [pr()], tracked: new Map([[URL1, pr({ decision: null, reviews: [review()] })]]), tracks: [track({ status: 'commented' })] })
    expect(same.tracks[0].status).not.toBe('queued')
    const pushed = run({ tracked: new Map([[URL1, pr({ head: 'bbb', decision: null, reviews: [review()] })]]), tracks: [track({ status: 'commented' })] })
    expect(pushed.tracks[0]).toMatchObject({ status: 'queued', head: 'bbb', note: 'changes pushed' })
    expect(pushed.events.join()).toContain('changes pushed')
    const stalled = run({ tracked: new Map([[URL1, pr({ head: 'bbb' })]]), tracks: [track({ status: 'stalled' })] })
    expect(stalled.tracks[0].status).toBe('queued')
  })
  it('ready to merge: told once per head, merged only with the switch on', () => {
    const p = pr({ reviews: [review()] })
    const off = run({ tracked: new Map([[URL1, p]]), tracks: [track({ status: 'commented' })] })
    expect(off.tracks[0].status).toBe('ready')
    expect(off.notices.map((n) => n.title)).toEqual(['acme/web#12 is ready to merge'])
    expect(off.merges).toEqual([])
    const on = run({ tab: tab({ merge: true }), tracked: new Map([[URL1, p]]), tracks: off.tracks })
    expect(on.notices).toEqual([])
    expect(on.merges).toHaveLength(1)
    expect(on.tracks[0]).toMatchObject({ status: 'merging', mergeTried: 'aaa' })
  })
  it('merged and closed end it; a tracked PR not returned three times goes', () => {
    expect(run({ tracked: new Map([[URL1, pr({ state: 'MERGED' })]]), tracks: [track()] }).tracks[0].status).toBe('merged')
    expect(run({ tracked: new Map([[URL1, pr({ state: 'CLOSED' })]]), tracks: [track()] }).tracks[0].status).toBe('closed')
    let ts = [track()]
    for (let i = 0; i < MISS_MAX; i++) ts = run({ tracked: new Map([[URL1, null]]), tracks: ts }).tracks
    expect(ts).toEqual([])
  })
  it('leaves other tabs’ tracks alone', () => {
    const a = run({ tracked: new Map([[URL1, pr({ state: 'MERGED' })]]), tracks: [track({ tabId: 't2' })] })
    expect(a.tracks[0].status).toBe('reviewing')
  })
})

describe('readyToMerge', () => {
  it('ready only when everything is green and reviewed at this head', () => {
    expect(readyToMerge(pr(), 'aaa')).toBeNull()
    expect(readyToMerge(pr({ checks: null }), 'aaa')).toBeNull()
  })
  it.each([
    [{ state: 'CLOSED' as const }, 'closed'],
    [{ draft: true }, 'draft'],
    [{ mergeable: 'CONFLICTING' }, 'conflicts'],
    [{ mergeable: 'UNKNOWN' }, 'not worked out'],
    [{ decision: 'REVIEW_REQUIRED' }, 'not approved'],
    [{ decision: null }, 'not approved'],
    [{ decision: 'CHANGES_REQUESTED' }, 'changes are requested'],
    [{ checks: 'PENDING' }, 'still running'],
    [{ checks: 'FAILURE' }, 'failing'],
    [{ checks: 'ERROR' }, 'failing'],
    [{ mergeState: 'BLOCKED' }, 'branch protection'],
    [{ mergeState: 'BEHIND' }, 'behind'],
    [{ mergeState: 'UNSTABLE' }, 'failing'],
    [{ mergeState: 'UNKNOWN' }, 'not worked out'],
  ])('%o is not ready', (over, why) => {
    expect(readyToMerge(pr(over), 'aaa')).toContain(why)
  })
  it('unreviewed commits are not ready', () => {
    expect(readyToMerge(pr({ head: 'bbb' }), 'aaa')).toContain('not reviewed')
    expect(readyToMerge(pr(), null)).toContain('not reviewed')
  })
})

describe('mergeGuard', () => {
  const t = track({ status: 'ready' })
  it('lets a ready PR through with the switch on', () => {
    expect(mergeGuard(t, pr(), tab({ merge: true }), 't1')).toBeNull()
  })
  it('refuses when off, not this tab, tried at this head, method unknown, or not ready', () => {
    expect(mergeGuard(t, pr(), tab(), 't1')).toContain('off')
    expect(mergeGuard(t, pr(), tab({ merge: true, review: false }), 't1')).toContain('off')
    expect(mergeGuard(t, pr(), undefined, 't1')).toContain('not this tab')
    expect(mergeGuard(t, pr(), tab({ merge: true }), 't2')).toContain('not this tab')
    expect(mergeGuard({ ...t, mergeTried: 'aaa' }, pr(), tab({ merge: true }), 't1')).toContain('already tried')
    expect(mergeGuard(t, pr({ method: null }), tab({ merge: true }), 't1')).toContain('merge method')
    expect(mergeGuard(t, pr({ checks: 'PENDING' }), tab({ merge: true }), 't1')).toContain('running')
  })
  it('merges with the default method at the checked head, never bypassing protection', () => {
    const a = mergeArgs(pr())
    expect(a).toEqual(['pr', 'merge', URL1, '--squash', '--match-head-commit', 'aaa'])
    expect(a).not.toContain('--admin')
    expect(a).not.toContain('--auto')
  })
})

describe('autoPrompt', () => {
  it('one line with the PR, never a slash command', () => {
    const line = autoPrompt(pr({ title: '/clear\nrm -rf \u0007x', author: 'bob' }))
    expect(line.startsWith('[MasterDeck auto-review] Review acme/web#12')).toBe(true)
    expect(line).not.toMatch(/[\u0000-\u001f]/)
    expect(line).toContain(URL1)
    expect(line).toContain('+10 −2 in 3 files')
    expect(line).toContain('checks: passing')
    expect(line).toContain('./post-review.sh --auto')
  })
})

describe('small parts', () => {
  it('parseTurn', () => {
    expect(parseTurn('idle\n')).toBe('idle')
    expect(parseTurn('busy')).toBe('busy')
    expect(parseTurn('start')).toBe('start')
    expect(parseTurn('x')).toBeNull()
    expect(parseTurn(null)).toBeNull()
  })
  it('normalizeTab: merge needs review; since kept while on', () => {
    expect(normalizeTab({ review: false, merge: true })).toMatchObject({ review: false, merge: false })
    const on = normalizeTab({ review: true, merge: true, name: 'Mine', account: 'alice' }, undefined, 5)
    expect(on).toMatchObject({ review: true, merge: true, account: 'alice', since: 5 })
    expect(normalizeTab({ review: true }, on, 9).since).toBe(5)
  })
  it('autoStatusLine', () => {
    const prs = [
      { url: URL1, repo: 'acme/web', number: 12, title: '', author: '', tabId: 't1', status: 'reviewing' as const, at: 0, reviewUrl: null, comments: 0, note: null },
      { url: URL2, repo: 'acme/api', number: 7, title: '', author: '', tabId: 't1', status: 'queued' as const, at: 0, reviewUrl: null, comments: 0, note: null },
    ]
    expect(autoStatusLine({ review: true, merge: false, lastCheck: 0, error: null, pane: null }, prs, 't1', 60_000)).toBe('Watching · 2 reviews in progress · last check 1 min ago')
    expect(autoStatusLine({ review: false, merge: false, lastCheck: null, error: null, pane: null }, prs, 't1', 0)).toBe('Off')
    expect(autoStatusLine({ review: true, merge: false, lastCheck: null, error: 'rate limited', pane: null }, [], 't1', 0)).toBe("Can't check: rate limited · checking…")
  })
})

describe('inputBoxRows', () => {
  const rule = '─'.repeat(40)
  it('finds the rules around the prompt', () => {
    expect(inputBoxRows(['hello', '', rule, '> ', rule, '  ? for shortcuts'])).toEqual({ top: 2, bottom: 4 })
    // A prompt of several lines.
    expect(inputBoxRows([rule, '> one', '  two', rule, ''])).toEqual({ top: 0, bottom: 3 })
  })
  it('finds the rounded box', () => {
    expect(inputBoxRows(['x', `╭${'─'.repeat(30)}╮`, '│ > review it │', `╰${'─'.repeat(30)}╯`])).toEqual({ top: 1, bottom: 3 })
  })
  it('none on screen, or rules with no prompt between', () => {
    expect(inputBoxRows(['a', 'b'])).toBeNull()
    expect(inputBoxRows([rule, 'just text', rule])).toBeNull()
    expect(inputBoxRows([])).toBeNull()
  })
})
