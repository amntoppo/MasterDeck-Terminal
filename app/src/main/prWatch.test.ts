import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CliResult, PrLive, Session } from '@shared/types'
import type { GhRunner } from './ghc'
import { PrWatch, prStates, type PrWatchDeps } from './prWatch'

const SID = '55555555-5555-4555-8555-555555555555'
const url = (n: number) => `https://github.com/acme/web/pull/${n}`
const sess = (state: Session['state'] = 'idle'): Session => ({ key: 'k1', sessionId: SID, name: 's', kind: 'background', bgId: 'k1', pid: 1, cwd: '/w', state, rawState: state, startedAt: 0, issue: null })
const live = (createdAt: number): PrLive => ({ number: 1, title: 't', url: '', state: 'OPEN', reviewDecision: null, ci: null, reviewCheck: null, buildCi: null, isDraft: false, createdAt, mergedAt: null, lastCommentAt: null })
const NOW = Date.parse('2026-10-03T10:30:00Z')
const tick = () => new Promise((r) => setTimeout(r, 0))

/** GitHub as a function of the query: `pr(i, heavy)` gives each aliased PR's fields; `viewer()` the login. Counts calls. */
function fakeGh(pr: (i: number, heavy: boolean) => object | null, viewer: () => string | null = () => 'me') {
  const calls: { heavy: boolean; n: number; ttl?: number }[] = []
  const gh: GhRunner = async (args, opts) => {
    const q = args.find((a) => a.startsWith('query='))!.slice(6)
    const n = (q.match(/ p\d+: /g) ?? []).length
    const heavy = q.includes('reviewThreads')
    calls.push({ heavy, n, ttl: opts?.ttl })
    const data: Record<string, unknown> = { viewer: viewer() ? { login: viewer() } : null }
    for (let i = 0; i < n; i++) data[`p${i}`] = pr(i, heavy) ? { pullRequest: pr(i, heavy) } : null
    return { code: 0, stdout: JSON.stringify({ data }), stderr: '' }
  }
  return { gh, calls }
}
const lightPr = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'dev', updatedAt: '2026-10-03T10:00:00Z', createdAt: '2026-10-03T10:25:00Z', author: { login: 'me' } }
const thread = (id: number, body: string) => ({ isResolved: false, comments: { nodes: [{ databaseId: id, updatedAt: 'u1', author: { login: 'bob' }, body }] } })
const withThreads = (...ts: object[]) => ({ ...lightPr, reviewThreads: { nodes: ts }, reviews: { nodes: [] }, comments: { nodes: [] } })
const withThread = (body: string) => withThreads(thread(1, body))

function make(gh: GhRunner, file = join(mkdtempSync(join(tmpdir(), 'pw-')), 'pr-watch.json')) {
  const sent: string[] = []
  const deps: PrWatchDeps = { gh, paused: () => false, send: async (_s, t): Promise<CliResult> => (sent.push(t), { ok: true, message: 'sent' }), onChange: () => {} }
  return { w: new PrWatch(file, deps), sent, file, deps }
}
const one = (createdAt: number, n = 1) => ({ sessions: [sess()], sessionPrs: { [SID]: [url(n)] }, prLive: { [url(n)]: live(createdAt) } })

describe('PrWatch', () => {
  it('watches a new PR of a session, tells it about a new thread once its turn is over, and not again', async () => {
    const { gh } = fakeGh((_i, heavy) => (heavy ? withThread('rename x') : lightPr))
    const { w, sent } = make(gh)
    w.sync(one(NOW - 60_000), () => true, NOW)
    expect(w.info([sess()])).toMatchObject([{ id: `pr:${url(1)}`, sessionId: SID, description: 'PR watch · web#1' }])
    await w.poll(NOW)
    w.deliver([sess('working')], NOW)
    expect(sent).toEqual([])
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('web#1: 1 new review thread: "rename x"')
    await w.poll(NOW + 60_000)
    w.deliver([sess()], NOW + 60_000)
    await tick()
    expect(sent).toHaveLength(1)
  })
  it('baselines an old PR: what is there already is not news', async () => {
    const { gh } = fakeGh((_i, heavy) => (heavy ? withThread('old') : lightPr))
    const { w, sent } = make(gh)
    w.sync(one(NOW - 86_400_000), () => true, NOW)
    await w.poll(NOW)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toEqual([])
  })
  it('without a viewer login: delivers nothing and leaves seen alone (no silent baseline)', async () => {
    let viewer: string | null = null
    const { gh } = fakeGh((_i, heavy) => (heavy ? withThread('rename x') : lightPr), () => viewer)
    const { w, sent } = make(gh)
    w.sync(one(NOW - 60_000), () => true, NOW)
    await w.poll(NOW)
    await w.poll(NOW + 11 * 60_000)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toEqual([])
    expect(w.watched().size).toBe(1)
    viewer = 'me'
    await w.poll(NOW + 12 * 60_000)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('"rename x"')
    // An old PR read without a viewer is not baselined to nothing (which would flood it later).
    viewer = null
    const old = make(gh)
    old.w.sync(one(NOW - 86_400_000, 2), () => true, NOW)
    await old.w.poll(NOW)
    viewer = 'me'
    await old.w.poll(NOW + 60_000)
    old.w.deliver([sess()], NOW)
    await tick()
    expect(old.sent).toEqual([])
  })
  it('keeps its seen set across a restart: only the new item reaches the session', async () => {
    let threads = [thread(1, 'old thread')]
    const { gh } = fakeGh((_i, heavy) => (heavy ? withThreads(...threads) : lightPr))
    const a = make(gh)
    a.w.sync(one(NOW), () => true, NOW)
    await a.w.poll(NOW)
    a.w.deliver([sess()], NOW)
    await tick()
    expect(a.sent).toHaveLength(1)
    expect(a.sent[0]).toContain('old thread')
    const b = make(gh, a.file)
    b.w.load()
    threads = [thread(1, 'old thread'), thread(2, 'new thread')]
    await b.w.poll(NOW + 11 * 60_000)
    b.w.deliver([sess()], NOW)
    await tick()
    expect(b.sent).toHaveLength(1)
    expect(b.sent[0]).toContain('1 new review thread: "new thread"')
    expect(b.sent[0]).not.toContain('old thread')
  })
  it('batches: one light query per 50 PRs, heavy only for changed ones, nothing while paused', async () => {
    const { gh, calls } = fakeGh(() => lightPr)
    const { w, deps } = make(gh)
    const urls = Array.from({ length: 60 }, (_, i) => url(i + 1))
    w.sync({ sessions: [sess()], sessionPrs: { [SID]: urls }, prLive: Object.fromEntries(urls.map((u) => [u, live(NOW)])) }, () => true, NOW)
    await w.poll(NOW)
    expect(calls.filter((c) => !c.heavy).map((c) => c.n)).toEqual([50, 10])
    expect(calls.filter((c) => c.heavy).every((c) => c.n <= 10)).toBe(true)
    calls.length = 0
    await w.poll(NOW + 60_000) // nothing changed, heavy not due
    expect(calls.filter((c) => c.heavy)).toEqual([])
    calls.length = 0
    deps.paused = () => true
    await w.poll(NOW + 120_000)
    expect(calls).toEqual([])
  })
  it('a failed heavy read keeps the seen set (no replay next time)', async () => {
    let fail = false
    const ok = fakeGh((_i, heavy) => (heavy ? withThread('x') : { ...lightPr, updatedAt: String(Math.random()) }))
    const gh: GhRunner = async (args, o) => (fail && args.some((a) => a.includes('reviewThreads')) ? { code: 1, stdout: '', stderr: 'HTTP 502' } : ok.gh(args, o))
    const { w, sent } = make(gh)
    w.sync(one(NOW - 86_400_000), () => true, NOW)
    await w.poll(NOW)
    fail = true
    await w.poll(NOW + 60_000)
    fail = false
    await w.poll(NOW + 120_000)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toEqual([])
  })
  it('a failed heavy read is retried next poll even though the light read already saw the change', async () => {
    let fail = false
    let threads: object[] = []
    let updatedAt = 'a'
    const ok = fakeGh((_i, heavy) => (heavy ? withThreads(...threads) : { ...lightPr, updatedAt }))
    const gh: GhRunner = async (args, o) => (fail && args.some((a) => a.includes('reviewThreads')) ? { code: 1, stdout: '', stderr: 'HTTP 502' } : ok.gh(args, o))
    const { w, sent } = make(gh)
    w.sync(one(NOW - 86_400_000), () => true, NOW)
    await w.poll(NOW)
    threads = [thread(5, 'late')]
    updatedAt = 'b'
    fail = true
    await w.poll(NOW + 60_000)
    fail = false
    await w.poll(NOW + 120_000)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('"late"')
  })
  it('ends on merge (after telling the session), and never restarts on a stale OPEN', async () => {
    const { gh } = fakeGh(() => ({ ...lightPr, state: 'MERGED' }))
    const { w, sent } = make(gh)
    const st = one(NOW)
    w.sync(st, () => true, NOW)
    await w.poll(NOW)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toEqual(['[MasterDeck PR watch] web#1: merged. The PR watch has ended.'])
    w.sync(st, () => true, NOW)
    expect(w.info([sess()])).toEqual([])
  })
  it('stops from Details and tells the session', async () => {
    const { gh } = fakeGh(() => lightPr)
    const { w, sent } = make(gh)
    w.sync(one(NOW), () => true, NOW)
    expect(w.stop(`pr:${url(1)}`)).toBe(true)
    expect(w.stop(`pr:${url(1)}`)).toBe(false)
    expect(w.info([sess()])).toEqual([])
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toEqual(['[MasterDeck PR watch] web#1: stopped from MasterDeck.'])
  })
  it("ends without a word when the PR is not the user's, and when turned off", async () => {
    const { gh } = fakeGh(() => ({ ...lightPr, author: { login: 'someone' } }))
    const { w, sent } = make(gh)
    w.sync(one(NOW), () => true, NOW)
    await w.poll(NOW)
    expect(w.watched().size).toBe(0)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toEqual([])
    const off = make(fakeGh(() => lightPr).gh)
    off.w.sync(one(NOW), () => true, NOW)
    off.w.sync(one(NOW), () => false, NOW)
    expect(off.w.watched().size).toBe(0)
  })
})

describe('prStates', () => {
  it('one light call per 50 PRs through ghc, cached five minutes', async () => {
    const { gh, calls } = fakeGh(() => ({ ...lightPr, isDraft: true }))
    const urls = Array.from({ length: 51 }, (_, i) => url(i + 1))
    const out = await prStates(gh, [...urls, 'https://example.com/x'])
    expect(calls.map((c) => [c.heavy, c.n, c.ttl])).toEqual([[false, 50, 300], [false, 1, 300]])
    expect(out[url(1)]).toEqual({ state: 'OPEN', isDraft: true })
    expect(Object.keys(out)).toHaveLength(51)
  })
})
