import { describe, expect, it } from 'vitest'
import { checkCounts, clipLine, parsePrDetail, prDetailQuery, worstPrStatus } from './prDetail'

const answer = (pr: unknown) => JSON.stringify({ data: { repository: { pullRequest: pr } } })

const PR = {
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/web/runs/1' },
                { __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/web/runs/2' },
                { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null },
                { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
                { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING', targetUrl: 'javascript:alert(1)' },
              ],
            },
          },
        },
      },
    ],
  },
  reviews: {
    nodes: [
      { state: 'CHANGES_REQUESTED', submittedAt: '2026-10-01T10:00:00Z', url: 'https://github.com/r/1', author: { login: 'ann' } },
      { state: 'COMMENTED', submittedAt: '2026-10-01T11:00:00Z', url: 'https://github.com/r/2', author: { login: 'ann' } },
      { state: 'APPROVED', submittedAt: '2026-10-01T12:00:00Z', url: 'https://github.com/r/3', author: { login: 'bob' } },
      { state: 'PENDING', submittedAt: null, author: { login: 'me' } },
    ],
  },
  reviewThreads: {
    nodes: [
      { isResolved: true, isOutdated: false, path: 'a.ts', comments: { nodes: [{ body: 'done', author: { login: 'ann' } }] } },
      { isResolved: false, isOutdated: true, path: 'b.ts', comments: { nodes: [{ body: 'old', author: { login: 'ann' } }] } },
      { isResolved: false, isOutdated: false, path: 'c.ts', comments: { nodes: [{ body: 'first\nline', url: 'https://github.com/t/1', author: { login: 'ann' } }] } },
      { isResolved: false, isOutdated: false, path: 'd.ts', comments: { nodes: [{ body: 'second', author: null }] } },
    ],
  },
  comments: {
    nodes: [
      { createdAt: '2026-10-01T09:00:00Z', body: 'older', url: 'https://github.com/c/1', author: { login: 'bob' } },
      { createdAt: '2026-10-01T13:00:00Z', body: 'newer', url: 'https://github.com/c/2', author: { login: 'ann' } },
    ],
  },
}

describe('prDetailQuery', () => {
  it('names the PR and never reads as a write to ghcache', () => {
    const q = prDetailQuery({ owner: 'acme', repo: 'web', number: 7 })
    expect(q).toContain('repository(owner:"acme",name:"web"){pullRequest(number:7)')
    expect(q.toLowerCase()).not.toContain('mutation')
  })
  it('refuses an unsafe reference', () => {
    expect(() => prDetailQuery({ owner: 'a"b', repo: 'web', number: 1 })).toThrow()
  })
})

describe('parsePrDetail', () => {
  const d = parsePrDetail(answer(PR))!

  it('reads checks, failing first, and only https links', () => {
    expect(d.checks.map((c) => [c.name, c.state])).toEqual([
      ['tests', 'failure'],
      ['ci/legacy', 'pending'],
      ['lint', 'pending'],
      ['build', 'success'],
      ['docs', 'neutral'],
    ])
    expect(d.checks.find((c) => c.name === 'ci/legacy')!.url).toBeNull()
    expect(checkCounts(d.checks)).toEqual({ passed: 2, failed: 1, pending: 2 })
  })

  it('keeps the latest decision per reviewer, newest first', () => {
    expect(d.reviews.map((r) => [r.author, r.state])).toEqual([
      ['bob', 'APPROVED'],
      ['ann', 'CHANGES_REQUESTED'],
    ])
  })

  it('lists unresolved, current threads newest first, on one line', () => {
    expect(d.threads).toEqual([
      { path: 'd.ts', author: 'ghost', text: 'second', url: null },
      { path: 'c.ts', author: 'ann', text: 'first line', url: 'https://github.com/t/1' },
    ])
  })

  it('lists comments newest first', () => {
    expect(d.comments.map((c) => c.text)).toEqual(['newer', 'older'])
    expect(d.comments[0].at).toBe(Date.parse('2026-10-01T13:00:00Z'))
  })

  it('is null without a PR, and empty lists with no fields', () => {
    expect(parsePrDetail('not json')).toBeNull()
    expect(parsePrDetail(answer(null))).toBeNull()
    expect(parsePrDetail(answer({ title: 'x' }))).toEqual({ checks: [], reviews: [], threads: [], comments: [] })
  })
})

describe('clipLine', () => {
  it('flattens and cuts', () => {
    expect(clipLine('a‮\nb   c')).toBe('a b c')
    expect(clipLine('x'.repeat(10), 5)).toBe('xxxx…')
  })
})

describe('worstPrStatus', () => {
  const row = (o: Partial<{ done: boolean; ci: 'success' | 'failure' | 'pending' | null; threads: number; review: string | null }>) => ({ done: false, ci: null, threads: 0, review: null, ...o })
  it('ranks failing CI over changes, threads and running CI', () => {
    expect(worstPrStatus([])).toBeNull()
    expect(worstPrStatus([row({ done: true })])).toBe('done')
    expect(worstPrStatus([row({ ci: 'pending' }), row({ threads: 2 })])).toBe('threads')
    expect(worstPrStatus([row({ review: 'CHANGES_REQUESTED' }), row({ ci: 'failure' })])).toBe('ci-failing')
    expect(worstPrStatus([row({ ci: 'pending' })])).toBe('ci-running')
    expect(worstPrStatus([row({ ci: 'success' }), row({ done: true, ci: 'failure' })])).toBe('ok')
  })
})
