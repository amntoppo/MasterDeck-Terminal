import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CompiledLoop } from '@shared/flow'
import { LoopStore, PROGRESS_MAX } from './loops'

const SID = 'aaaaaaaa-1111-2222-3333-444444444444'
const SID2 = 'cccccccc-1111-2222-3333-444444444444'
const NOW = 1_760_000_000_000

const def = (id = 'lp', name = 'Fix'): CompiledLoop => ({
  id,
  name,
  check: { command: 'npm test', output: '', outputMode: 'match', timeoutMin: 5 },
  agentDone: { on: false, goal: '' },
  limits: { iterations: 10, minutes: 0, stall: 0 },
  plan: '1. Fix.',
  met: '',
  limit: '',
  then: '',
  after: null,
})

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'lp', step: 's', state: 'open', iteration: 2, startedAt: NOW - 60_000, history: [{ n: 1, at: NOW - 30_000, ms: 5, passed: false, said: false, exit: 1, tail: 'FAIL', hash: 'h' }], reason: null, lastCheck: null, ...over,
})

function setup(defs: CompiledLoop[] = [def()]) {
  const home = mkdtempSync(join(tmpdir(), 'loops-home-'))
  const dir = join(home, 'workflows', 'loops')
  mkdirSync(dir, { recursive: true })
  const put = (sid: string, loops: object[]) => writeFileSync(join(dir, `${sid}.json`), JSON.stringify({ loops }))
  const get = (sid = SID) => JSON.parse(readFileSync(join(dir, `${sid}.json`), 'utf8')).loops
  const store = new LoopStore(home, () => defs)
  return { home, dir, put, get, store }
}

describe('LoopStore', () => {
  it("reads every session's loops, cached by mtime", () => {
    const { put, dir, store } = setup()
    put(SID, [entry()])
    put(SID2, [entry({ state: 'met', reason: 'criterion met after 2 iterations', lastCheck: { n: 2, at: NOW - 1000, passed: true } })])
    const v = store.views([SID, SID2, 'dddddddd-0000-0000-0000-000000000000'], NOW)
    expect(Object.keys(v)).toEqual([SID, SID2])
    expect(v[SID][0]).toMatchObject({ name: 'Fix', iteration: 2, max: 10, state: 'open' })
    expect(v[SID2][0]).toMatchObject({ state: 'met' })
    // Same mtime: the cache answers, even if the text changed underneath.
    const f = join(dir, `${SID}.json`)
    const t = new Date(NOW)
    utimesSync(f, t, t)
    store.read(SID)
    writeFileSync(f, JSON.stringify({ loops: [entry({ iteration: 7 })] }))
    utimesSync(f, t, t)
    expect(store.read(SID)?.loops[0].iteration).toBe(2)
    utimesSync(f, new Date(NOW + 5000), new Date(NOW + 5000))
    expect(store.read(SID)?.loops[0].iteration).toBe(7)
  })

  it('a corrupt file reads as no loops', () => {
    const { dir, store } = setup()
    writeFileSync(join(dir, `${SID}.json`), '{nope')
    expect(store.views([SID], NOW)).toEqual({})
  })

  it('changed() notices a file appearing, changing and going', () => {
    const { put, dir, store } = setup()
    store.changed()
    expect(store.changed()).toBe(false)
    put(SID, [entry()])
    expect(store.changed()).toBe(true)
    expect(store.changed()).toBe(false)
    utimesSync(join(dir, `${SID}.json`), new Date(NOW), new Date(NOW))
    expect(store.changed()).toBe(true)
  })

  it('stop sets stopped with its reason, only an open loop', () => {
    const { put, get, store } = setup()
    put(SID, [entry(), entry({ id: 'done', state: 'met' })])
    expect(store.stop(SID, 'lp', NOW)).toEqual({ ok: true, message: 'loop stopped' })
    expect(get()[0]).toMatchObject({ state: 'stopped', reason: 'stopped by you', endedAt: NOW, iteration: 2 })
    expect(store.stop(SID, 'lp', NOW).ok).toBe(false)
    expect(store.stop(SID, 'done', NOW)).toEqual({ ok: false, message: 'the loop is not running' })
    expect(store.stop(SID, 'nope', NOW)).toEqual({ ok: false, message: 'no such loop' })
  })

  it('more gives a limit loop 5 more and opens it, with a fresh start and no old stall', () => {
    const { put, get, store } = setup()
    put(SID, [entry({ state: 'limit', iteration: 10, reason: 'stopped: no progress in 3 iterations', startedAt: NOW - 3_600_000 })])
    const r = store.more(SID, 'lp', NOW)
    expect(r).toEqual({ ok: true, message: '5 more iterations', name: 'Fix' })
    expect(get()[0]).toMatchObject({ state: 'open', reason: null, extra: 5, iteration: 10, startedAt: NOW, stallFrom: 10 })
    expect(store.views([SID], NOW)[SID][0]).toMatchObject({ max: 15, state: 'open' })
    // Again after the next limit: the extra adds up.
    put(SID, [{ ...get()[0], state: 'limit', iteration: 15 }])
    store.more(SID, 'lp', NOW)
    expect(get()[0]).toMatchObject({ extra: 10, stallFrom: 15 })
  })

  it('more refuses an open or met loop, and one while another loop runs', () => {
    const { put, store } = setup([def('lp'), def('b', 'B')])
    put(SID, [entry(), entry({ id: 'b', state: 'met' })])
    expect(store.more(SID, 'lp', NOW).ok).toBe(false)
    expect(store.more(SID, 'b', NOW).ok).toBe(false)
    put(SID, [entry({ state: 'limit' }), entry({ id: 'b' })])
    expect(store.more(SID, 'lp', NOW)).toEqual({ ok: false, message: 'another loop is running' })
  })

  it('history returns the entries and the progress file text (at most 64 KB, its end)', () => {
    const { put, dir, store } = setup()
    put(SID, [entry()])
    expect(store.history(SID, 'lp')).toMatchObject({ ok: true, name: 'Fix', progress: '', history: [{ n: 1, tail: 'FAIL' }] })
    writeFileSync(join(dir, `${SID}-lp.md`), 'a'.repeat(PROGRESS_MAX) + 'tried X\n')
    const h = store.history(SID, 'lp')
    if (!h.ok) throw new Error(h.message)
    expect(h.progress.length).toBe(PROGRESS_MAX)
    expect(h.progress.endsWith('tried X\n')).toBe(true)
  })

  it('rejects bad ids', () => {
    const { put, store } = setup()
    put(SID, [entry()])
    for (const [s, l] of [['../x', 'lp'], [SID, 'A B'], [SID, '../lp'], [3, 'lp'], [SID, null]] as const) {
      expect(store.stop(s, l).ok).toBe(false)
      expect(store.more(s, l).ok).toBe(false)
      expect(store.history(s, l).ok).toBe(false)
    }
    expect(store.read('../x')).toBeNull()
  })

  it('writes are atomic: no temp file left', () => {
    const { put, dir, store } = setup()
    put(SID, [entry()])
    store.stop(SID, 'lp', NOW)
    expect(readdirSync(dir)).toEqual([`${SID}.json`])
  })
})
