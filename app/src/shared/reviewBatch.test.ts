import { describe, expect, it } from 'vitest'
import { activeEntries, addToBatch, applyLine, BATCH_MAX, batchPrompt, batchSummary, batchTabView, cancelBatch, parseLogLines, retryItem, type BatchTab } from './reviewBatch'
import type { TeamPr } from './teamPrs'

const pr = (n: number, o: Partial<TeamPr> = {}): TeamPr =>
  ({ url: `https://github.com/acme/web/pull/${n}`, repo: 'web', number: n, title: `PR ${n}`, state: 'open', ...o }) as TeamPr
const PRS = [pr(1), pr(2), pr(3), pr(4, { state: 'merged' })]
const url = (n: number) => `https://github.com/acme/web/pull/${n}`
let seq = 0
const id = () => `b${++seq}`

const start = (ns: number[]): BatchTab => addToBatch(undefined, ns.map(url), PRS, 1000, id).tab

describe('addToBatch', () => {
  it('queues PRs from MasterDeck’s list, with their facts, and refuses the rest', () => {
    const r = addToBatch(undefined, [url(1), url(2), url(4), url(9), url(1)], PRS, 1000, id)
    expect(r.added.map((i) => [i.repo, i.number, i.status, i.title])).toEqual([
      ['acme/web', 1, 'queued', 'PR 1'],
      ['acme/web', 2, 'queued', 'PR 2'],
    ])
    expect(r.refused).toEqual([
      { url: url(4), why: 'it is merged' },
      { url: url(9), why: 'not in MasterDeck’s PR list' },
    ])
    expect(r.tab.startedAt).toBe(1000)
    expect(new Set(r.tab.items.map((i) => i.id)).size).toBe(2)
  })
  it('during a batch: adds new PRs, keeps the running ones, queues an ended one again with a new id', () => {
    const t = start([1, 2])
    const old = t.items[1].id
    applyLine(t, { id: old, url: url(2), status: 'skipped', note: 'no changes' }, 1100)
    const r = addToBatch(t, [url(1), url(2), url(3)], PRS, 1200, id)
    expect(r.kept).toEqual([url(1)])
    expect(r.added.map((i) => i.number)).toEqual([2, 3])
    expect(r.tab.items.find((i) => i.number === 2)!.id).not.toBe(old)
    expect(r.tab.startedAt).toBe(1000)
  })
  it('after a batch ended: a new batch, the ended PRs dropped; nothing new keeps the old one on screen', () => {
    const t = start([1])
    applyLine(t, { id: t.items[0].id, url: url(1), status: 'posted', review: 'r', comments: 2 }, 1100)
    expect(addToBatch(t, [url(9)], PRS, 1200, id).tab).toBe(t)
    const r = addToBatch(t, [url(2)], PRS, 1300, id)
    expect(r.tab.items.map((i) => i.number)).toEqual([2])
    expect(r.tab.startedAt).toBe(1300)
  })
  it(`holds at most ${BATCH_MAX} active PRs`, () => {
    const many = Array.from({ length: BATCH_MAX + 2 }, (_, i) => pr(100 + i))
    const r = addToBatch(undefined, many.map((p) => p.url), many, 1, id)
    expect(r.added).toHaveLength(BATCH_MAX)
    expect(r.refused).toHaveLength(2)
  })
})

describe('applyLine', () => {
  it('moves a PR through reviewing to posted, with its review and comment count', () => {
    const t = start([1])
    const i = t.items[0]
    expect(applyLine(t, { id: i.id, url: i.url, status: 'reviewing' }, 2)).toBe(true)
    expect(applyLine(t, { id: i.id, url: i.url, status: 'reviewing' }, 3)).toBe(false)
    expect(applyLine(t, { id: i.id, url: i.url, status: 'posted', review: 'https://github.com/acme/web/pull/1#pullrequestreview-9', comments: 3 }, 4)).toBe(true)
    expect(t.items[0]).toMatchObject({ status: 'posted', comments: 3, reviewUrl: 'https://github.com/acme/web/pull/1#pullrequestreview-9', at: 4 })
  })
  it('skipped and failed keep a cleaned reason; a failed one may still post', () => {
    const t = start([1, 2])
    applyLine(t, { id: t.items[0].id, url: url(1), status: 'skipped', note: 'no changes\nsince the last review' }, 2)
    expect(t.items[0]).toMatchObject({ status: 'skipped', note: 'no changes since the last review' })
    applyLine(t, { id: t.items[1].id, url: url(2), status: 'failed', note: 'x'.repeat(500) }, 2)
    expect(t.items[1].note).toHaveLength(300)
    expect(applyLine(t, { id: t.items[1].id, url: url(2), status: 'posted', review: 'r' }, 3)).toBe(true)
  })
  it('ignores an unknown id, another PR’s id, and anything but posted for a cancelled PR', () => {
    const t = start([1, 2])
    expect(applyLine(t, { id: 'nope', url: url(1), status: 'reviewing' }, 2)).toBe(false)
    expect(applyLine(t, { id: t.items[0].id, url: url(2), status: 'reviewing' }, 2)).toBe(false)
    cancelBatch(t, 3)
    expect(applyLine(t, { id: t.items[0].id, url: url(1), status: 'skipped' }, 4)).toBe(false)
    expect(t.items[0].status).toBe('cancelled')
    // It happened on GitHub: shown as it is.
    expect(applyLine(t, { id: t.items[1].id, url: url(2), status: 'posted', review: 'r' }, 5)).toBe(true)
  })
})

describe('the batch file, cancel and retry', () => {
  it('the post script may post to queued, reviewing and failed PRs only', () => {
    const t = start([1, 2, 3])
    applyLine(t, { id: t.items[0].id, url: url(1), status: 'posted', review: 'r' }, 2)
    applyLine(t, { id: t.items[1].id, url: url(2), status: 'failed', note: 'GitHub refused' }, 2)
    expect(activeEntries(t).map((e) => e.url)).toEqual([url(2), url(3)])
    expect(cancelBatch(t, 3)).toBe(2)
    expect(activeEntries(t)).toEqual([])
    expect(t.items.map((i) => i.status)).toEqual(['posted', 'cancelled', 'cancelled'])
  })
  it('retry queues one ended PR again with a new id; never a posted or running one', () => {
    const t = start([1, 2])
    applyLine(t, { id: t.items[0].id, url: url(1), status: 'failed', note: 'boom' }, 2)
    const old = t.items[0].id
    expect(retryItem(t, url(2), 3, id)).toBeNull()
    const r = retryItem(t, url(1), 3, id)!
    expect(r).toMatchObject({ status: 'queued', note: null })
    expect(r.id).not.toBe(old)
    expect(activeEntries(t).find((e) => e.url === url(1))!.id).toBe(r.id)
    applyLine(t, { id: r.id, url: url(1), status: 'posted', review: 'r' }, 4)
    expect(retryItem(t, url(1), 5, id)).toBeNull()
  })
})

describe('batchSummary', () => {
  it('says nothing while a PR runs, then what happened', () => {
    const t = start([1, 2, 3])
    expect(batchSummary(t.items)).toBeNull()
    const u = start([1, 2, 3])
    const [a, b, c] = u.items
    applyLine(u, { id: a.id, url: a.url, status: 'posted', review: 'r' }, 2)
    applyLine(u, { id: b.id, url: b.url, status: 'posted', review: 'r' }, 2)
    expect(batchSummary(u.items)).toBeNull()
    applyLine(u, { id: c.id, url: c.url, status: 'skipped', note: 'no changes' }, 2)
    expect(batchSummary(u.items)).toBe('Reviewed 3: 2 posted, 1 skipped (no changes)')
    expect(batchTabView(u)).toMatchObject({ running: false, summary: 'Reviewed 3: 2 posted, 1 skipped (no changes)' })
  })
  it('counts failed and cancelled', () => {
    const t = start([1, 2])
    applyLine(t, { id: t.items[0].id, url: url(1), status: 'failed', note: 'x' }, 2)
    cancelBatch(t, 3)
    expect(batchSummary(t.items)).toBe('Reviewed 2: 2 cancelled')
  })
})

describe('parseLogLines and batchPrompt', () => {
  it('reads the JSON lines, skips anything else', () => {
    const text = [
      '{"id":"a","url":"u","status":"posted","review":"r","comments":2}',
      'not json',
      '{"id":"b","url":"u","status":"merged"}',
      '{"id":3,"url":"u","status":"skipped"}',
      '{"id":"c","url":"u","status":"skipped","note":"no changes"}',
      '',
    ].join('\n')
    expect(parseLogLines(text)).toEqual([
      { id: 'a', url: 'u', status: 'posted', review: 'r', comments: 2 },
      { id: 'c', url: 'u', status: 'skipped', note: 'no changes' },
    ])
  })
  it('the typed line names each PR and never starts with / or !', () => {
    const line = batchPrompt([
      { repo: 'acme/web', number: 1 },
      { repo: 'acme/api', number: 2 },
    ])
    expect(line).toBe('[MasterDeck batch-review] Review these PRs as "Batch reviews" in CLAUDE.md says: acme/web#1, acme/api#2.')
    expect(line).not.toMatch(/^[/!]/)
  })
})
