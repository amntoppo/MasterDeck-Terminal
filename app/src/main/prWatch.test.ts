import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CliResult, PrLive, Session } from '@shared/types'
import type { GhRunner } from './ghc'
import { parseConfig } from '@shared/appConfig'
import { PrWatch, prStates, prStatesFor, type PrWatchDeps } from './prWatch'

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

/** A watch past its first run (pr-watch.json there); `firstRun` starts with none. */
function make(gh: GhRunner, file = join(mkdtempSync(join(tmpdir(), 'pw-')), 'pr-watch.json'), firstRun = false) {
  const sent: string[] = []
  const deps: PrWatchDeps = { gh, paused: () => false, send: async (_s, t): Promise<CliResult> => (sent.push(t), { ok: true, message: 'sent' }), onChange: () => {} }
  if (!firstRun && !existsSync(file)) writeFileSync(file, '{}')
  const w = new PrWatch(file, deps)
  w.load(NOW)
  return { w, sent, file, deps }
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
  it('first run (no pr-watch.json): what PRs already have is recorded silently, only later items go', async () => {
    let body = 'old'
    const { gh } = fakeGh((_i, heavy) => (heavy ? withThreads(thread(1, 'old'), ...(body === 'new' ? [thread(2, 'new')] : [])) : { ...lightPr, updatedAt: body }))
    const { w, sent } = make(gh, undefined, true)
    w.sync({ sessions: [sess()], sessionPrs: { [SID]: [url(1), url(2)] }, prLive: { [url(1)]: live(NOW - 60_000), [url(2)]: live(NOW - 86_400_000) } }, () => true, NOW)
    await w.poll(NOW)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toEqual([])
    body = 'new'
    await w.poll(NOW + 60_000)
    w.deliver([sess()], NOW + 60_000)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('"new"')
    expect(sent[0]).not.toContain('"old"')
    // Past the first run's window a new PR is watched as usual.
    w.sync({ sessions: [sess()], sessionPrs: { [SID]: [url(3)] }, prLive: { [url(3)]: live(NOW + 59 * 60_000) } }, () => true, NOW + 60 * 60_000)
    body = 'newer'
    await w.poll(NOW + 60 * 60_000)
    w.deliver([sess()], NOW + 60 * 60_000)
    await tick()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('web#3')
  })
  it('baselines an old PR: one summary of what is there, never the items themselves, never again', async () => {
    const { gh } = fakeGh((_i, heavy) => (heavy ? withThread('old') : lightPr))
    const { w, sent } = make(gh)
    w.sync(one(NOW - 86_400_000), () => true, NOW)
    await w.poll(NOW)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('web#1: already has 1 unresolved review thread and 0 PR comments')
    expect(sent[0]).not.toContain('"old"')
    await w.poll(NOW + 11 * 60_000)
    w.deliver([sess()], NOW + 11 * 60_000)
    await tick()
    expect(sent).toHaveLength(1)
    // Nothing on it: no summary at all.
    const quiet = make(fakeGh((_i, heavy) => (heavy ? withThreads() : lightPr)).gh)
    quiet.w.sync(one(NOW - 86_400_000), () => true, NOW)
    await quiet.w.poll(NOW)
    quiet.w.deliver([sess()], NOW)
    await tick()
    expect(quiet.sent).toEqual([])
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
    expect(old.sent).toHaveLength(1)
    expect(old.sent[0]).toContain('already has 1 unresolved review thread')
    expect(old.sent[0]).not.toContain('new review thread')
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
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('already has 1 unresolved review thread')
    expect(sent[0]).not.toContain('new review thread')
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

describe('PrWatch hardening', () => {
  it('a comment saying "rate limit" in a good answer does not pause GitHub; the PR is processed', async () => {
    const { gh } = fakeGh((_i, heavy) => (heavy ? withThread('we hit the rate limit here') : lightPr))
    const seen: string[] = []
    const { w, sent, deps } = make(gh)
    deps.paused = (o) => (o ? (seen.push(o), /rate limit/i.test(o)) : false)
    w.sync(one(NOW - 60_000), () => true, NOW)
    await w.poll(NOW)
    expect(seen.every((o) => !/rate limit/i.test(o))).toBe(true)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('"we hit the rate limit here"')
  })
  it('a rate-limited answer (stderr or GraphQL RATE_LIMITED) does pause', async () => {
    let paused = false
    const gh: GhRunner = async () => ({ code: 0, stdout: JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'x' }] }), stderr: '' })
    const { w, deps } = make(gh)
    deps.paused = (o) => (o && /rate limit/i.test(o) ? (paused = true) : paused)
    w.sync(one(NOW - 60_000), () => true, NOW)
    await w.poll(NOW)
    expect(paused).toBe(true)
  })
  it('review offers step aside only for PRs whose session can take a message now', () => {
    const { w } = make(fakeGh(() => lightPr).gh)
    w.sync(one(NOW), () => true, NOW)
    expect([...w.watched([sess()], () => true)]).toEqual([url(1)])
    expect([...w.watched([sess()], () => false)]).toEqual([])
    expect([...w.watched([], () => true)]).toEqual([])
  })
  it('a session that stays busy gets one bounded message per PR, and the paste is capped', async () => {
    let n = 0
    const many = () => withThreads(...Array.from({ length: n }, (_, i) => thread(i + 1, `thread ${i + 1} ${'x'.repeat(150)}`)))
    const urls = Array.from({ length: 12 }, (_, i) => url(i + 1))
    const { gh } = fakeGh((_i, heavy) => (heavy ? many() : { ...lightPr, updatedAt: String(n) }))
    const { w, sent, file } = make(gh)
    w.sync({ sessions: [sess()], sessionPrs: { [SID]: urls }, prLive: Object.fromEntries(urls.map((u) => [u, live(NOW)])) }, () => true, NOW)
    for (let p = 0; p < 40; p++) {
      n = (p + 1) * 3
      await w.poll(NOW + p * 60_000)
      w.deliver([sess('working')], NOW)
    }
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(file, 'utf8').length).toBeLessThan(400_000)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].length).toBeLessThanOrEqual(6_500)
    expect(sent[0].match(/web#1: /g)).toHaveLength(1)
    expect(sent[0]).toContain('more')
    expect(sent[0]).toMatch(/\(\d+ more PR updates — check MasterDeck\)/)
    // The rest follows next time.
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toHaveLength(2)
  })
  it('does nothing before load(); a corrupt file is moved aside', async () => {
    const { mkdtempSync: mk, readdirSync, writeFileSync } = await import('node:fs')
    const dir = mk(join(tmpdir(), 'pw-'))
    const file = join(dir, 'pr-watch.json')
    const deps: PrWatchDeps = { gh: fakeGh(() => lightPr).gh, paused: () => false, send: async () => ({ ok: true, message: '' }), onChange: () => {} }
    const w = new PrWatch(file, deps)
    w.sync(one(NOW), () => true, NOW)
    expect(w.watched().size).toBe(0)
    expect(readdirSync(dir)).toEqual([])
    writeFileSync(file, '{not json')
    const err = console.error
    console.error = () => {}
    try {
      w.load()
    } finally {
      console.error = err
    }
    expect(readdirSync(dir).some((f) => /^pr-watch\.corrupt\.\d+\.json$/.test(f))).toBe(true)
    w.sync(one(NOW), () => true, NOW)
    expect(w.watched().size).toBe(1)
  })
})

describe('PrWatch partial answers', () => {
  /** gh exits 1 on a partial error: PR `bad` comes back null with a NOT_FOUND, the others in full. */
  function partialGh(bad: number, body: string) {
    const gh: GhRunner = async (args) => {
      const q = args.find((a) => a.startsWith('query='))!
      const heavy = q.includes('reviewThreads')
      const data: Record<string, unknown> = { viewer: { login: 'me' } }
      for (const m of q.matchAll(/ (p\d+): repository\([^)]*\)\{pullRequest\(number:(\d+)\)/g))
        data[m[1]] = Number(m[2]) === bad ? null : { pullRequest: heavy ? withThread(body) : lightPr }
      const j = { data }
      return { code: 1, stdout: JSON.stringify({ ...j, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }), stderr: 'gh: Could not resolve to a Repository' }
    }
    return gh
  }
  const three = () => ({ sessions: [sess()], sessionPrs: { [SID]: [url(1), url(2), url(3)] }, prLive: Object.fromEntries([1, 2, 3].map((n) => [url(n), live(NOW - 60_000)])) })
  it('one inaccessible PR does not starve its batch, and a "rate limit" comment does not pause', async () => {
    let paused = false
    const { w, sent, deps } = make(partialGh(2, 'we hit the rate limit here'))
    deps.paused = (o) => (o && /rate limit/i.test(o) ? (paused = true) : paused)
    w.sync(three(), () => true, NOW)
    await w.poll(NOW)
    expect(paused).toBe(false)
    w.deliver([sess()], NOW)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('web#1: 1 new review thread')
    expect(sent[0]).toContain('web#3: 1 new review thread')
    expect(sent[0]).not.toContain('web#2')
  })
  it('a PR unreadable three polls running ends with one line', async () => {
    const { w, sent } = make(partialGh(2, 'x'))
    w.sync(three(), () => true, NOW)
    for (let p = 0; p < 3; p++) await w.poll(NOW + p * 60_000)
    expect([...w.watched()].sort()).toEqual([url(1), url(3)])
    w.deliver([sess()], NOW)
    await tick()
    expect(sent[0]).toContain("[MasterDeck PR watch] web#2: MasterDeck can't read this PR any more (3 tries). The PR watch has ended.")
  })
  it('drops what makes no message (a stall past its nudges) instead of retrying an empty send', async () => {
    const stalled = { ...lightPr, reviewThreads: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [{ databaseId: 9, updatedAt: '2026-10-03T09:00:00Z', author: { login: 'claude[bot]' }, body: 'Claude is reviewing\n- [ ] step' }] } }
    let calls = 0
    const { gh } = fakeGh((_i, heavy) => (heavy ? stalled : lightPr))
    const { w, file, deps } = make(gh)
    deps.send = async () => (calls++, { ok: true, message: '' })
    w.sync(one(NOW - 60_000), () => true, NOW)
    const { readFileSync, writeFileSync } = await import('node:fs')
    await w.poll(NOW)
    // Saved with its nudges used up: the stall item makes no text.
    const j = JSON.parse(readFileSync(file, 'utf8'))
    j.watches[0].nudges = 3
    writeFileSync(file, JSON.stringify(j))
    const b = make(gh, file)
    b.deps.send = deps.send
    b.w.deliver([sess()], NOW)
    await tick()
    b.w.deliver([sess()], NOW)
    await tick()
    expect(calls).toBe(0)
    expect(b.w.info([sess()])[0].queued).toBe(0)
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

describe('prStatesFor', () => {
  it("asks each account's runner about its own PRs only", async () => {
    const cfg = parseConfig({ accounts: [
      { login: 'alice', primary: true, owner: 'acme', issueRepo: 'web', repos: ['acme/web'] },
      { login: 'bob-work', owner: 'globex', issueRepo: 'app', repos: ['globex/app'] },
    ] })
    const asked: Record<string, number> = {}
    const ghFor = (login: string): GhRunner => async (args) => {
      const q = args.find((a) => a.startsWith('query='))!.slice(6)
      const n = (q.match(/ p\d+: /g) ?? []).length
      asked[login] = (asked[login] ?? 0) + n
      const data: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) data[`p${i}`] = { pullRequest: { ...lightPr, author: { login } } }
      return { code: 0, stdout: JSON.stringify({ data }), stderr: '' }
    }
    const got = await prStatesFor(ghFor, cfg, [url(1), 'https://github.com/globex/app/pull/2', url(3)])
    expect(asked).toEqual({ alice: 2, 'bob-work': 1 })
    expect(Object.keys(got).sort()).toEqual([url(1), url(3), 'https://github.com/globex/app/pull/2'].sort())
  })

  it("one account's failing read does not drop the others' answers", async () => {
    const cfg = parseConfig({ accounts: [
      { login: 'alice', primary: true, owner: 'acme', issueRepo: 'web', repos: ['acme/web'] },
      { login: 'bob-work', owner: 'globex', issueRepo: 'app', repos: ['globex/app'] },
    ] })
    let bobThrows = false
    const ghFor = (login: string): GhRunner => async (args) => {
      if (login === 'bob-work' && bobThrows) throw new Error('spawn failed')
      if (login === 'bob-work') return { code: 1, stdout: '', stderr: 'GitHub account bob-work needs to log in again' }
      const q = args.find((a) => a.startsWith('query='))!.slice(6)
      const n = (q.match(/ p\d+: /g) ?? []).length
      const data: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) data[`p${i}`] = { pullRequest: lightPr }
      return { code: 0, stdout: JSON.stringify({ data }), stderr: '' }
    }
    const urls = [url(1), 'https://github.com/globex/app/pull/2']
    expect(Object.keys(await prStatesFor(ghFor, cfg, urls))).toEqual([url(1)])
    bobThrows = true
    expect(Object.keys(await prStatesFor(ghFor, cfg, urls))).toEqual([url(1)])
  })
})
