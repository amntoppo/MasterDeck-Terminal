import { describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BatchItem } from '@shared/reviewBatch'
import type { TeamPr } from '@shared/teamPrs'
import { ReviewBatch } from './reviewBatch'

const url = (n: number) => `https://github.com/acme/web/pull/${n}`
const pr = (n: number, o: Partial<TeamPr> = {}): TeamPr => ({ url: url(n), repo: 'web', number: n, title: `PR ${n}`, state: 'open', ...o }) as TeamPr
const PRS = [pr(1), pr(2), pr(3), pr(4, { state: 'closed' })]

function world() {
  const home = mkdtempSync(join(tmpdir(), 'rb-'))
  const batches: Record<string, { url: string; id: string }[]> = {}
  const contexts: Record<string, BatchItem[]> = {}
  let changes = 0
  let t = 1000
  let seq = 0
  const deps = {
    logFile: (tab: string) => join(home, `${tab}.batch-log.jsonl`),
    writeBatch: (tab: string, e: { url: string; id: string }[]) => void (batches[tab] = e),
    writeContext: (tab: string, items: BatchItem[]) => void (contexts[tab] = JSON.parse(JSON.stringify(items))),
    onChange: () => void changes++,
  }
  const make = () => new ReviewBatch(join(home, 'review-batch.json'), deps, () => t, () => `id${++seq}`)
  const log = (tab: string, line: object) => appendFileSync(deps.logFile(tab), JSON.stringify(line) + '\n')
  return { home, batches, contexts, make, log, deps, changes: () => changes, tick: (ms: number) => (t += ms) }
}

describe('ReviewBatch', () => {
  it('Review selected: queues the PRs, writes the batch file and the context, answers the line to type', () => {
    const w = world()
    const b = w.make()
    const r = b.add('prs-mine', [url(1), url(2), url(4)], PRS)
    expect(r).toEqual({
      ok: true,
      message: 'Queued 2 PRs · acme/web#4: it is closed',
      prompt: '[MasterDeck batch-review] Review these PRs as "Batch reviews" in CLAUDE.md says: acme/web#1, acme/web#2.',
    })
    expect(w.batches['prs-mine']).toEqual([
      { url: url(1), id: 'id1' },
      { url: url(2), id: 'id2' },
    ])
    expect(w.contexts['prs-mine'].map((i) => [i.number, i.status])).toEqual([
      [1, 'queued'],
      [2, 'queued'],
    ])
    expect(b.view()['prs-mine']).toMatchObject({ running: true, summary: null })
    // Again during the batch: only the new one is queued and named.
    expect(b.add('prs-mine', [url(2), url(3)], PRS)).toMatchObject({ message: 'Queued 1 PR · 1 already in the batch', prompt: expect.stringContaining(': acme/web#3.') })
    expect(b.add('prs-mine', [url(2)], PRS)).toEqual({ ok: true, message: '1 already in the batch' })
    expect(b.add('../x', [url(1)], PRS).ok).toBe(false)
    expect(b.add('prs-mine', 'nope', PRS).ok).toBe(false)
  })

  it('reads the post script’s log as it grows: statuses, the summary, the batch file narrowing', () => {
    const w = world()
    const b = w.make()
    b.add('t', [url(1), url(2)], PRS)
    w.log('t', { id: 'id1', url: url(1), status: 'reviewing' })
    b.tick()
    expect(b.view().t.items.map((i) => i.status)).toEqual(['reviewing', 'queued'])
    // A line being written is read when whole.
    appendFileSync(w.deps.logFile('t'), '{"id":"id1","url":"' + url(1) + '","status":"posted","review":"r1","comm')
    b.tick()
    expect(b.view().t.items[0].status).toBe('reviewing')
    appendFileSync(w.deps.logFile('t'), 'ents":2}\n')
    w.log('t', { id: 'id2', url: url(2), status: 'skipped', note: 'no changes since the last review' })
    b.tick()
    expect(b.view().t).toMatchObject({ running: false, summary: 'Reviewed 2: 1 posted, 1 skipped (no changes since the last review)' })
    expect(b.view().t.items[0]).toMatchObject({ status: 'posted', reviewUrl: 'r1', comments: 2 })
    expect(w.batches.t).toEqual([])
    expect(w.contexts.t.map((i) => i.status)).toEqual(['posted', 'skipped'])
    // Nothing new in the log: nothing changes.
    const n = w.changes()
    b.tick()
    expect(w.changes()).toBe(n)
  })

  it('a new batch after the last one ended: the old PRs and log go', () => {
    const w = world()
    const b = w.make()
    b.add('t', [url(1)], PRS)
    w.log('t', { id: 'id1', url: url(1), status: 'posted', review: 'r' })
    b.tick()
    b.add('t', [url(2)], PRS)
    expect(b.view().t.items.map((i) => i.number)).toEqual([2])
    expect(readFileSync(w.deps.logFile('t'), 'utf8')).toBe('')
    w.log('t', { id: 'id2', url: url(2), status: 'reviewing' })
    b.tick()
    expect(b.view().t.items[0].status).toBe('reviewing')
  })

  it('Cancel batch stops what is not posted; Retry queues one again with a new id and its line', () => {
    const w = world()
    const b = w.make()
    b.add('t', [url(1), url(2), url(3)], PRS)
    w.log('t', { id: 'id1', url: url(1), status: 'posted', review: 'r' })
    w.log('t', { id: 'id2', url: url(2), status: 'failed', note: 'GitHub refused the review: HTTP 502' })
    b.tick()
    expect(w.batches.t.map((e) => e.url)).toEqual([url(2), url(3)])
    expect(b.retry('t', url(1))).toEqual({ ok: false, message: 'that PR is being reviewed or was posted' })
    expect(b.cancel('t')).toEqual({ ok: true, message: 'Cancelled 2 PRs' })
    expect(w.batches.t).toEqual([])
    expect(b.view().t.summary).toBe('Reviewed 3: 1 posted, 2 cancelled')
    // A line the session logs after the cancel changes nothing.
    w.log('t', { id: 'id3', url: url(3), status: 'skipped' })
    b.tick()
    expect(b.view().t.items[2].status).toBe('cancelled')
    const r = b.retry('t', url(2))
    expect(r).toEqual({ ok: true, message: 'Queued acme/web#2 again', prompt: '[MasterDeck batch-review] Review these PRs as "Batch reviews" in CLAUDE.md says: acme/web#2.' })
    expect(w.batches.t).toEqual([{ url: url(2), id: 'id4' }])
    expect(b.view().t.running).toBe(true)
  })

  it('a post that lands after Cancel batch is still read, also when a new batch starts', () => {
    const w = world()
    const b = w.make()
    b.add('t', [url(1), url(2)], PRS)
    b.cancel('t')
    w.log('t', { id: 'id1', url: url(1), status: 'posted', review: 'r1', comments: 1 })
    b.tick()
    expect(b.view().t.items[0]).toMatchObject({ status: 'posted', reviewUrl: 'r1' })
    // Retry never offers a second review of it.
    expect(b.retry('t', url(1)).ok).toBe(false)
    w.log('t', { id: 'id2', url: url(2), status: 'posted', review: 'r2' })
    mkdirSync(`${w.deps.logFile('t')}.d/id2`, { recursive: true })
    // Read before the log is emptied for the new batch, and the old claims go with it.
    b.add('t', [url(3)], PRS)
    expect(existsSync(`${w.deps.logFile('t')}.d`)).toBe(false)
    expect(b.view().t.items.map((i) => i.number)).toEqual([3])
  })

  it('refuses a tab id that is not one (a browser’s __proto__)', () => {
    const b = world().make()
    expect(b.cancel('__proto__')).toEqual({ ok: true, message: 'no batch' })
    expect(b.retry('constructor', url(1)).ok).toBe(false)
  })

  it('is kept across a restart, with the log offset (no line applied twice); forget drops a closed tab', () => {
    const w = world()
    const b = w.make()
    b.add('t', [url(1), url(2)], PRS)
    w.log('t', { id: 'id1', url: url(1), status: 'failed', note: 'x' })
    b.tick()
    b.retry('t', url(1))
    const again = w.make()
    again.load()
    expect(again.view().t.items.map((i) => [i.id, i.status])).toEqual([
      ['id3', 'queued'],
      ['id2', 'queued'],
    ])
    expect(w.batches.t.map((e) => e.id)).toEqual(['id3', 'id2'])
    again.tick()
    expect(again.view().t.items[0].status).toBe('queued')
    again.cancel('t', true)
    expect(again.view().t).toBeUndefined()
    expect(w.batches.t).toEqual([])
    expect(existsSync(join(w.home, 'review-batch.json'))).toBe(true)
    writeFileSync(join(w.home, 'review-batch.json'), 'not json')
    const broken = w.make()
    broken.load()
    expect(broken.view()).toEqual({})
  })
})
