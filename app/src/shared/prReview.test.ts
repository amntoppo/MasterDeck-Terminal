import { describe, expect, it } from 'vitest'
import { prLabel, prRef, prReviewBriefing, prReviewContext, prReviewName, prReviewSpecError, reviewPrompt } from './prReview'
import { DEFAULT_PR_FILTERS, type TeamPr } from './teamPrs'

const PR: TeamPr = {
  url: 'https://github.com/acme/web/pull/123',
  repo: 'web',
  number: 123,
  title: 'Fix the redirect',
  state: 'open',
  draft: false,
  author: 'bob',
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-17T09:00:00Z',
  closedAt: null,
  mergedAt: null,
  headRef: 'fix-redirect',
  baseRef: 'main',
  additions: 10,
  deletions: 2,
  files: 3,
  reviewDecision: 'REVIEW_REQUIRED',
  labels: [{ name: 'bug', color: 'ff0000' }],
  requested: ['alice'],
  reviews: [{ login: 'carol', state: 'COMMENTED' }],
  unresolvedThreads: 1,
  ci: 'failure',
  issues: [45],
  issueRefs: [{ repo: 'acme/api', number: 45 }],
}
const NOW = Date.parse('2026-10-17T10:00:00Z')

describe('prRef', () => {
  it('a github.com PR URL only', () => {
    expect(prRef('https://github.com/acme/web/pull/123')).toEqual({ owner: 'acme', repo: 'web', number: 123 })
    expect(prRef('https://github.com/acme/web.js/pull/7/')).toEqual({ owner: 'acme', repo: 'web.js', number: 7 })
    for (const bad of ['https://github.com/acme/web/issues/1', 'http://github.com/acme/web/pull/1', 'https://evil.test/acme/web/pull/1', 'https://github.com/acme/web/pull/1/files', 'https://github.com/a b/web/pull/1', 5, null])
      expect(prRef(bad)).toBeNull()
  })
  it('labels and the prompt name the PR in full', () => {
    expect(prLabel(PR.url)).toBe('acme/web#123')
    expect(reviewPrompt(PR.url)).toBe('Review the selected PR, acme/web#123.')
    expect(reviewPrompt(PR.url).startsWith('/')).toBe(false)
    expect(prReviewName('prs-mine')).toBe('md-pr-review-prs-mine')
  })
})

describe('prReviewContext', () => {
  it("takes the selected PR's facts from MasterDeck's list, the owner from its URL", () => {
    const c = prReviewContext({ tabId: 'prs-mine', tab: 'Mine', account: 'alice', filters: { ...DEFAULT_PR_FILTERS, ci: 'failing' }, url: PR.url }, [PR], NOW)
    expect(c).toMatchObject({ tab: 'Mine', account: 'alice', selectedAt: '2026-10-17T10:00:00.000Z' })
    expect(c.filters.ci).toBe('failing')
    expect(c.selected).toEqual({
      url: PR.url,
      repo: 'acme/web',
      number: 123,
      title: 'Fix the redirect',
      author: 'bob',
      state: 'open',
      draft: false,
      branch: 'fix-redirect',
      base: 'main',
      ci: 'failure',
      reviewDecision: 'REVIEW_REQUIRED',
      reviews: [{ login: 'carol', state: 'COMMENTED' }],
      requested: ['alice'],
      labels: ['bug'],
      additions: 10,
      deletions: 2,
      files: 3,
      unresolvedThreads: 1,
      issues: ['acme/api#45'],
    })
  })
  it('bare issue numbers (an older list) are the PR\'s own repository\'s', () => {
    const c = prReviewContext({ tabId: 't', tab: 'x', filters: DEFAULT_PR_FILTERS, url: PR.url }, [{ ...PR, issueRefs: undefined }], NOW)
    expect(c.selected?.issues).toEqual(['acme/web#45'])
    expect(c.account).toBeNull()
  })
  it('nothing selected, a URL not in the list, or not a PR URL: null; bad filters are normalised', () => {
    const f = { tabId: 't', tab: 'x', filters: { state: 'bogus' } as never }
    expect(prReviewContext(f, [PR], NOW).selected).toBeNull()
    expect(prReviewContext({ ...f, url: 'https://github.com/acme/web/pull/9' }, [PR], NOW).selected).toBeNull()
    expect(prReviewContext({ ...f, url: 'javascript:alert(1)' }, [{ ...PR, url: 'javascript:alert(1)' }], NOW).selected).toBeNull()
    expect(prReviewContext(f, [PR], NOW).filters).toEqual(DEFAULT_PR_FILTERS)
  })
})

describe('prReviewBriefing', () => {
  it('re-reads the context, reads with gh, and posts only after a yes, through the script', () => {
    const b = prReviewBriefing('alice', "/h/pr-review-guard/post-review-t.sh")
    expect(b).toContain('`alice`')
    // Run by its absolute path (outside the folder), quoted, never a copy of the session's own.
    expect(b).toContain("'/h/pr-review-guard/post-review-t.sh' --pr <selected.url>")
    expect(b).not.toContain('./post-review.sh')
    expect(prReviewBriefing(null, "/it's/p.sh")).toContain("'/it'\\''s/p.sh' --pr")
    expect(b).toMatch(/Re-read `context.json` at the start of \*\*every\*\* answer/)
    for (const c of ['gh pr diff', 'gh pr view', 'gh pr checks', '--log-failed', '--dry-run', 'Never copy it'])
      expect(b).toContain(c)
    expect(b).toMatch(/Post only after a clear yes/)
    expect(prReviewBriefing(null, '/p.sh')).not.toContain('on GitHub` ')
  })
  it('automated reviews: the marked message, posted as a comment with --auto, never approve', () => {
    const post = '/h/pr-review-guard/post-review-a.sh'
    const b = prReviewBriefing('alice', post)
    expect(b).toContain('[MasterDeck auto-review]')
    expect(b).toContain('[MasterDeck PR watch]')
    // Bare, so the settings' prefix rule (`Bash(<post> --auto:*)`) matches it as typed.
    expect(b).toContain(`\n${post} --auto --pr`)
    expect(b).toMatch(/always a comment review: never approve, never request changes, never merge/)
    // A path that needs quotes is given quoted (it is then asked for, as any other run).
    expect(prReviewBriefing('alice', "/h o/post-review-a.sh")).toContain("\n'/h o/post-review-a.sh' --auto --pr")
  })
})

describe('prReviewSpecError', () => {
  const logins = ['alice', 'bob-work']
  it('always a tab; then the ticket builder\'s checks, named for the review', () => {
    expect(prReviewSpecError({}, logins)).toMatch(/without its tab/)
    expect(prReviewSpecError({ tab: '../x' }, logins)).toBe('refusing a PR review with a bad tab id')
    expect(prReviewSpecError({ tab: 't', account: 'mallory' }, logins)).toBe('refusing a PR review as an account that is not connected')
    expect(prReviewSpecError({ tab: 't', account: 'alice' }, logins, () => 'bob-work')).toMatch(/works as bob-work/)
    expect(prReviewSpecError({ tab: 't', account: 'Bob-Work' }, logins, () => 'bob-work')).toBeNull()
    expect(prReviewSpecError({ tab: 't' }, logins)).toBeNull()
  })
})
