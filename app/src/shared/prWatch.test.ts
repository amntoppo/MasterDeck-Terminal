import { describe, expect, it } from 'vitest'
import { fresh, heavyQuery, lightQuery, parseHeavy, parseLight, prItems, prWatchMessage, safeRef, STALL_MS, type HeavyPr } from './prWatch'

const ref = { owner: 'acme', repo: 'web', number: 12 }
const base: HeavyPr = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'dev', updatedAt: '2026-10-03T10:00:00Z', createdAt: '2026-10-03T09:00:00Z', author: 'me', threads: [], reviews: [], comments: [] }
const note = (id: number, author: string, body: string, updatedAt = '2026-10-03T10:00:00Z') => ({ id, author, body, updatedAt })
const NOW = Date.parse('2026-10-03T10:30:00Z')

describe('queries', () => {
  it('aliases one pullRequest per PR and refuses unsafe names', () => {
    const q = lightQuery([ref, { owner: 'acme', repo: 'api.v2', number: 3 }])
    expect(q).toContain('p0: repository(owner:"acme",name:"web"){pullRequest(number:12)')
    expect(q).toContain('p1: repository(owner:"acme",name:"api.v2"){pullRequest(number:3)')
    expect(q).not.toContain('reviewThreads')
    expect(heavyQuery([ref])).toContain('reviewThreads(first:50)')
    expect(safeRef({ owner: 'a"){x}', repo: 'r', number: 1 })).toBe(false)
    expect(() => lightQuery([{ owner: 'a"', repo: 'r', number: 1 }])).toThrow()
  })
  it('parses aligned results, null for a missing PR', () => {
    const text = JSON.stringify({ data: { p0: { pullRequest: { state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', baseRefName: 'dev', updatedAt: 'u', createdAt: 'c', author: { login: 'me' } } }, p1: null } })
    expect(parseLight(text, 2)).toEqual([{ state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', baseRefName: 'dev', updatedAt: 'u', createdAt: 'c', author: 'me' }, null])
    const heavy = JSON.stringify({ data: { p0: { pullRequest: { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'dev', updatedAt: 'u', createdAt: 'c', author: { login: 'me' },
      reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ databaseId: 7, updatedAt: 'u', author: { login: 'bob' }, body: 'nit' }] } }] },
      reviews: { nodes: [{ databaseId: 8, state: 'CHANGES_REQUESTED', submittedAt: 's', author: { login: 'bob' }, body: '' }] },
      comments: { nodes: [{ databaseId: 9, updatedAt: 'u', author: null, body: 'hi' }] } } } } })
    const [h] = parseHeavy(heavy, 1)
    expect(h!.threads).toEqual([{ isResolved: false, last: { id: 7, updatedAt: 'u', author: 'bob', body: 'nit' } }])
    expect(h!.reviews).toEqual([{ id: 8, updatedAt: 's', author: 'bob', body: '', state: 'CHANGES_REQUESTED' }])
    expect(h!.comments[0].author).toBe('ghost')
    expect(parseLight('not json', 1)).toEqual([null])
  })
})

describe('prItems', () => {
  it("others' unresolved threads, comments and reviews that ask something; never mine", () => {
    const { items } = prItems({
      ...base,
      threads: [{ isResolved: false, last: note(1, 'bob', 'rename this') }, { isResolved: true, last: note(2, 'bob', 'old') }, { isResolved: false, last: note(3, 'Me', 'done') }],
      comments: [note(4, 'alice', 'why?'), note(5, 'me', 'mine')],
      reviews: [{ ...note(6, 'bob', ''), state: 'CHANGES_REQUESTED' }, { ...note(7, 'bob', ''), state: 'APPROVED' }, { ...note(8, 'carol', 'looks off'), state: 'COMMENTED' }],
    }, 'me', NOW)
    expect(items.map((i) => i.key)).toEqual(['T:1:2026-10-03T10:00:00Z', 'C:4:2026-10-03T10:00:00Z', 'R:6', 'R:8'])
  })
  it('edits fire again (the key carries updatedAt)', () => {
    const a = prItems({ ...base, comments: [note(4, 'alice', 'x', 't1')] }, 'me', NOW).items
    const b = prItems({ ...base, comments: [note(4, 'alice', 'x2', 't2')] }, 'me', NOW).items
    expect(fresh(b, a.map((i) => i.key))).toHaveLength(1)
  })
  it("a Claude status comment in progress is a stall candidate, not a comment; stalled after 10 minutes", () => {
    const busy = note(9, 'claude[bot]', "Claude is reviewing this PR\n\n- [x] read\n- [ ] review", '2026-10-03T10:25:00Z')
    const r1 = prItems({ ...base, comments: [busy] }, 'me', NOW)
    expect(r1.items).toEqual([])
    expect(r1.stallAt).toBe(Date.parse('2026-10-03T10:25:00Z') + STALL_MS)
    const r2 = prItems({ ...base, comments: [{ ...busy, updatedAt: '2026-10-03T10:10:00Z' }] }, 'me', NOW)
    expect(r2.items.map((i) => i.key)).toEqual(['S:9'])
    const finished = prItems({ ...base, comments: [{ ...busy, body: 'Claude finished @me\'s task\n- [ ] left', updatedAt: '2026-10-03T10:10:00Z' }] }, 'me', NOW)
    expect(finished.items.map((i) => i.kind)).toEqual(['comment'])
  })
  it('conflicts while CONFLICTING (and again after they were gone); merged and closed end it', () => {
    expect(prItems({ ...base, mergeable: 'CONFLICTING' }, 'me', NOW).items.map((i) => i.key)).toEqual(['X:dev'])
    expect(prItems({ ...base, mergeable: 'UNKNOWN' }, 'me', NOW).items).toEqual([])
    expect(prItems({ ...base, state: 'MERGED', comments: [note(4, 'a', 'x')] }, 'me', NOW).items.map((i) => i.kind)).toEqual(['merged'])
    expect(prItems({ ...base, state: 'CLOSED' }, 'me', NOW).items.map((i) => i.kind)).toEqual(['closed'])
  })
})

describe('prWatchMessage', () => {
  const items = (k: HeavyPr) => prItems(k, 'me', NOW).items
  it('says what is new and what to do, clipped to 180 characters', () => {
    const long = 'x'.repeat(300)
    const { text } = prWatchMessage(ref, items({ ...base, threads: [{ isResolved: false, last: note(1, 'bob', long) }, { isResolved: false, last: note(2, 'bob', 'b') }] }), 0)
    expect(text).toBe(`[MasterDeck PR watch] web#12: 2 new review threads: "${'x'.repeat(179)}…", "b". Fix valid ones, reply on each thread, resolve only threads you addressed. Never force-push. Do not merge.`)
  })
  it('comments and reviews, then conflicts, one line each', () => {
    const { text } = prWatchMessage(ref, items({ ...base, mergeable: 'CONFLICTING', comments: [note(4, 'alice', 'why?')], reviews: [{ ...note(6, 'bob', 'split it'), state: 'CHANGES_REQUESTED' }] }), 0)
    expect(text.split('\n')).toEqual([
      '[MasterDeck PR watch] web#12: 2 new PR comments: alice: "why?", bob (changes requested): "split it". Read them (gh pr view 12 --repo acme/web --comments), fix what is valid and reply on the PR. Never force-push. Do not merge.',
      '[MasterDeck PR watch] web#12: merge conflict with dev. Merge origin/dev, never rebase; stop and tell me if lockfiles or migrations conflict.',
    ])
  })
  it('nudges a stalled review at most twice, then says to stop', () => {
    const stall = items({ ...base, comments: [note(9, 'claude', 'Claude is reviewing this PR', '2026-10-03T10:00:00Z')] })
    const a = prWatchMessage(ref, stall, 0)
    expect(a.text).toContain('Comment `@claude review` on the PR once (gh pr comment 12 --repo acme/web --body "@claude review")')
    expect(a.nudges).toBe(1)
    expect(prWatchMessage(ref, stall, 2)).toEqual({ text: '[MasterDeck PR watch] web#12: the automated Claude review is stuck again. Do not nudge it again; tell me it is not completing.', nudges: 3 })
    expect(prWatchMessage(ref, stall, 3)).toEqual({ text: '', nudges: 3 })
  })
  it('merged and closed', () => {
    expect(prWatchMessage(ref, items({ ...base, state: 'MERGED' }), 0).text).toBe('[MasterDeck PR watch] web#12: merged. The PR watch has ended.')
    expect(prWatchMessage(ref, items({ ...base, state: 'CLOSED' }), 0).text).toBe('[MasterDeck PR watch] web#12: closed without merging. The PR watch has ended.')
  })
})
