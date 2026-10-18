import { describe, expect, it } from 'vitest'
import type { LightPr } from './prWatch'
import type { Session } from './types'
import { parsePrInput, primaryRepoOf, reviewWatchLine, targetText, watchNoticeText, watchOwner, watchReadError, watchReady, watchTip, type PrWatchRow } from './watchPr'

describe('parsePrInput', () => {
  const ok = (text: string, primary: string | null = 'acme/web') => {
    const r = parsePrInput(text, primary)
    if ('error' in r) throw new Error(r.error)
    return r
  }
  it('takes a link, with anything after the number', () => {
    expect(ok('https://github.com/acme/api/pull/123').url).toBe('https://github.com/acme/api/pull/123')
    expect(ok(' https://github.com/acme/api/pull/123/files?w=1 ').ref).toEqual({ owner: 'acme', repo: 'api', number: 123 })
    expect(ok('github.com/acme/api/pull/7#discussion_r1').ref.number).toBe(7)
  })
  it('takes owner/repo#n', () => {
    expect(ok('acme/api#42').url).toBe('https://github.com/acme/api/pull/42')
  })
  it('takes #n and n in the primary repository', () => {
    expect(ok('#12').url).toBe('https://github.com/acme/web/pull/12')
    expect(ok('12').url).toBe('https://github.com/acme/web/pull/12')
  })
  it('refuses a bare number without a primary repository', () => {
    expect(parsePrInput('12', null)).toHaveProperty('error')
  })
  it('refuses anything else', () => {
    for (const t of ['', 'hello', 'https://github.com/acme/api/issues/3', '#0', 'acme/api#x', 'https://evil.com/acme/api/pull/3', 'ac"me/api#3', 'acme/a b#3'])
      expect(parsePrInput(t, 'acme/web'), t).toHaveProperty('error')
  })
})

describe('primaryRepoOf', () => {
  it('prefers the tab’s Repo filter under the account’s owner', () => {
    expect(primaryRepoOf('api', 'acme', 'web')).toBe('acme/api')
  })
  it('falls back to the issue repository', () => {
    expect(primaryRepoOf('', 'acme', 'web')).toBe('acme/web')
    expect(primaryRepoOf('', null, 'acme/web')).toBe('acme/web')
    expect(primaryRepoOf('', null, '')).toBeNull()
  })
})

const row = (o: Partial<PrWatchRow> = {}): PrWatchRow => ({
  url: 'https://github.com/acme/web/pull/1', repo: 'acme/web', number: 1, title: 'T', manual: true, tabId: 'prs-1', tabName: 'Team',
  account: null, target: { review: 'prs-1' }, lastEvent: null, startedAt: 0, error: null, ...o,
})

describe('targetText and watchTip', () => {
  it('names the session, this tab or another tab', () => {
    expect(targetText(row({ target: { session: { key: 'k', name: 'settings-notifications-section' } } }))).toBe('session settings-notifications-section')
    expect(targetText(row(), 'prs-1')).toBe('this tab’s Review with Claude session')
    expect(targetText(row(), 'prs-2')).toBe('the Review with Claude session of tab Team')
  })
  it('says not watched, or who watches it', () => {
    expect(watchTip(undefined)).toBe('Not watched: click to watch')
    expect(watchTip(row({ manual: false, target: { session: { key: 'k', name: 's' } } }))).toMatch(/^Watched automatically .*session s/)
  })
})

const light = (o: Partial<LightPr> = {}): LightPr => ({
  state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'main', updatedAt: '', createdAt: '', author: 'bob', title: 'T',
  head: 'abc', decision: 'APPROVED', mergeState: 'CLEAN', checks: 'SUCCESS', ...o,
})

describe('watchReady', () => {
  it('is ready when approved, green and clean', () => {
    expect(watchReady(light())).toBe(true)
    expect(watchReady(light({ checks: null }))).toBe(true)
  })
  it('is not ready otherwise', () => {
    for (const o of [{ isDraft: true }, { decision: 'REVIEW_REQUIRED' }, { checks: 'PENDING' }, { mergeState: 'BLOCKED' }, { mergeable: 'CONFLICTING' }, { state: 'MERGED' }])
      expect(watchReady(light(o)), JSON.stringify(o)).toBe(false)
  })
})

describe('watchReadError', () => {
  const ref = { owner: 'acme', repo: 'web', number: 9 }
  it('says what GitHub meant', () => {
    expect(watchReadError("GraphQL: Could not resolve to a Repository with the name 'acme/web'.", ref)).toMatch(/repository not found/)
    expect(watchReadError('GraphQL: Could not resolve to a PullRequest with the number of 9.', ref)).toBe('No PR #9 in acme/web')
    expect(watchReadError('', ref)).toBe('GitHub did not answer')
  })
})

describe('watchOwner and watchNoticeText', () => {
  const s = (key: string, sessionId: string, state: Session['state'] = 'idle'): Session => ({ key, sessionId, name: key, kind: 'background', bgId: key, pid: 1, cwd: '/w', state, rawState: state, startedAt: 0, issue: null })
  it('is the session that lists the PR, never a finished one', () => {
    const u = 'https://github.com/acme/web/pull/3'
    expect(watchOwner(u, { sessions: [s('a', 'A'), s('b', 'B')], sessionPrs: { B: [u] }, prs: [] })?.key).toBe('b')
    expect(watchOwner(u, { sessions: [s('b', 'B', 'done')], sessionPrs: { B: [u] }, prs: [] })).toBeNull()
    expect(watchOwner(u, { sessions: [s('a', 'A')], sessionPrs: {}, prs: [] })).toBeNull()
  })
  it('names the PR and what happened', () => {
    const ref = { owner: 'acme', repo: 'web', number: 3 }
    expect(watchNoticeText(ref, 'Fix', 'ready').title).toBe('acme/web#3 is ready to merge')
    expect(watchNoticeText(ref, 'Fix', 'closed').title).toBe('acme/web#3 was closed without merging')
    expect(watchNoticeText(ref, 'Fix', 'gone').body).toMatch(/watch has ended/)
  })
})

describe('reviewWatchLine', () => {
  const ref = { owner: 'acme', repo: 'web', number: 5 }
  it('asks for a summary of comments, reviews and threads, in one line', () => {
    const line = reviewWatchLine(ref, 'Fix login', [
      { key: 'C:1', kind: 'comment', text: 'why\nthis?', by: 'alice' },
      { key: 'R:2', kind: 'review', text: 'no', by: 'bob', state: 'CHANGES_REQUESTED' },
      { key: 'T:3', kind: 'thread', text: 'typo', by: 'carol' },
    ])
    expect(line.startsWith('[MasterDeck PR watch] acme/web#5 "Fix login" has 3 new comments')).toBe(true)
    expect(line).toContain('bob (changes requested): "no"')
    expect(line).toContain('carol (on a line): "typo"')
    expect(line).toContain('Do not post on the PR, push or merge.')
    expect(line).not.toMatch(/[\n\r]/)
  })
  it('tells a conflict, and nothing for a stall alone', () => {
    expect(reviewWatchLine(ref, 'T', [{ key: 'X:main', kind: 'conflict', text: '', base: 'main' }])).toContain('a merge conflict with main')
    expect(reviewWatchLine(ref, 'T', [{ key: 'S:1', kind: 'stall', text: '' }])).toBe('')
  })
})
