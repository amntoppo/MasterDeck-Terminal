import { describe, expect, it } from 'vitest'
import { parseConfig, setConfig } from '@shared/appConfig'
import { REPO_VIEW_LIVE_MS, REPO_VIEW_MAX_ENTRIES, REPO_VIEW_RETRY_MS, REPO_VIEW_STALE_MS } from '@shared/repoView'
import { RepoIssues } from './repoIssues'

const BOARD = { owner: 'acme', number: 1, title: 'Delivery', columns: ['To Do', 'In QA'] }
const boarded = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [BOARD] })
const loose = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'] })
setConfig(boarded)

const card = (n: number, repo: string) => ({ number: n, repo, project: null, title: `Issue ${n}`, url: '', status: null, prs: [], assignees: [], labels: [], milestone: null, type: null, derived: true, state: 'OPEN', closedAt: null })
const answer = (repos: string[], n = 7) => ({ taken_at: 'x', cards: repos.map((r) => card(n, r)), repos: repos.map((r) => ({ repo: r, account: null, ok: true, total: 1, shown: 1 })) })

const tick = () => new Promise((r) => setTimeout(r, 0))

function make(o: { cfg?: ReturnType<typeof parseConfig>; reply?: (repos: string[]) => { ok: true; data: unknown } | { ok: false; message: string } } = {}) {
  const calls: { repos: string[]; force: boolean }[] = []
  const changes: boolean[] = []
  const notes: string[] = []
  const t = { now: 1_000_000, paused: false, cfg: o.cfg ?? boarded }
  const store = new RepoIssues({
    read: async (repos, force) => {
      calls.push({ repos, force })
      return o.reply ? o.reply(repos) : { ok: true, data: answer(repos) }
    },
    config: () => t.cfg,
    paused: (text) => {
      if (text) notes.push(text)
      return t.paused
    },
    changed: (read) => void changes.push(read),
    now: () => t.now,
  })
  return { store, calls, changes, notes, t }
}

describe('RepoIssues', () => {
  it('reads nothing until a tab asks', async () => {
    const { store, calls } = make()
    expect(store.view()).toBeUndefined()
    expect(await store.refresh(true)).toEqual({ ok: true, message: 'no repository view open' })
    expect(calls).toEqual([])
    expect(store.dump()).toBeUndefined()
  })
  it('an ask reads what it lacks, once, and shows it loading meanwhile', async () => {
    const { store, calls, changes } = make()
    store.ask(['acme/api'])
    expect(store.view()?.repos).toEqual([{ repo: 'acme/api', account: null, ok: false, total: 0, shown: 0, takenAt: null, loading: true }])
    store.ask(['acme/api']) // the same tab asking again while the read runs
    expect(await store.refresh()).toEqual({ ok: true, message: 'refreshed' }) // joins the read that runs: no second call
    expect(calls.map((c) => c.repos)).toEqual([['acme/api']])
    expect(store.view()).toMatchObject({ repos: [{ repo: 'acme/api', ok: true, takenAt: 1_000_000 }], cards: [{ number: 7 }] })
    expect(store.view()?.repos[0]).not.toHaveProperty('loading')
    expect(changes).toContain(true)
    const seen = store.view()
    store.ask(['ACME/API', 'acme/tracker']) // fresh: only the new one is read
    await store.refresh()
    expect(calls[1].repos).toEqual(['acme/tracker'])
    expect(store.view()).not.toBe(seen)
  })
  it('the view is the same object until something changes', async () => {
    const { store } = make()
    store.ask(['acme/api'])
    await store.refresh()
    expect(store.view()).toBe(store.view())
  })
  it('an ask reads a repository again once it is an hour old', async () => {
    const { store, calls, t } = make()
    store.ask(['acme/api'])
    await store.refresh()
    const n = calls.length
    t.now += REPO_VIEW_STALE_MS - 1
    store.ask(['acme/api'])
    expect(calls).toHaveLength(n)
    t.now += 1
    store.ask(['acme/api'])
    await new Promise((r) => setTimeout(r, 0)) // the read starts on the next turn
    expect(calls).toHaveLength(n + 1)
    expect(calls[n]).toEqual({ repos: ['acme/api'], force: false })
  })
  it('a refresh reads what a tab asked for in the last hour, forced when the user pressed Refresh', async () => {
    const { store, calls, t } = make()
    store.ask(['acme/api'])
    t.now += 10
    store.ask(['acme/tracker'])
    await store.refresh()
    calls.length = 0
    t.now += REPO_VIEW_LIVE_MS - 10
    expect(await store.refresh(true)).toEqual({ ok: true, message: 'refreshed' })
    expect(calls).toEqual([{ repos: ['acme/tracker'], force: true }]) // acme/api was last asked for an hour ago: off screen
    t.now += 20
    await store.refresh(true)
    expect(calls).toHaveLength(1) // nobody shows a repository any more: no call at all
  })
  it('untrusted input never reaches the read', async () => {
    const { store, calls } = make()
    for (const bad of [null, 'acme/api', [], [7], ['acme/secret'], ['acme/api --fixtures /etc'], [{ repo: 'acme/api' }]]) store.ask(bad)
    await store.refresh(true)
    expect(calls).toEqual([])
  })
  it('an account with no board is never read: its issues come with the board', async () => {
    const { store, calls } = make({ cfg: loose })
    store.ask(['acme/api'])
    await store.refresh(true)
    expect(calls).toEqual([])
    expect(store.view()).toBeUndefined()
  })
  it('a failed read keeps what was on screen and says why', async () => {
    let fail = false
    const { store, notes, t } = make({ reply: (repos) => (fail ? { ok: false, message: 'gh: API rate limit exceeded' } : { ok: true, data: answer(repos) }) })
    store.ask(['acme/api'])
    await store.refresh()
    fail = true
    t.now += 5
    expect(await store.refresh(true)).toEqual({ ok: false, message: 'gh: API rate limit exceeded' })
    expect(store.view()).toMatchObject({ cards: [{ number: 7 }], repos: [{ repo: 'acme/api', ok: false, note: 'acme/api not read: gh: API rate limit exceeded', takenAt: 1_000_000 }] })
    expect(notes).toContain('gh: API rate limit exceeded') // the shared pause hears of it
  })
  it('one repository failing leaves the other showing, and its note reaches the pause check', async () => {
    const { store, notes } = make({ reply: () => ({ ok: true, data: { taken_at: 'x', cards: [card(7, 'acme/api')], repos: [{ repo: 'acme/api', account: null, ok: true, total: 1, shown: 1 }, { repo: 'acme/tracker', account: null, ok: false, total: 0, shown: 0, note: 'acme/tracker not read: gh: API rate limit exceeded' }] } }) })
    store.ask(['acme/api', 'acme/tracker'])
    expect(await store.refresh()).toEqual({ ok: true, message: 'refreshed' })
    expect(store.view()?.repos.map((p) => [p.repo, p.ok, p.takenAt !== null])).toEqual([['acme/api', true, true], ['acme/tracker', false, false]])
    expect(notes).toContain('acme/tracker not read: gh: API rate limit exceeded')
  })
  it('an answer of the wrong shape, or a read that throws, is a failure, not a crash', async () => {
    const a = make({ reply: () => ({ ok: true, data: { nope: 1 } }) })
    a.store.ask(['acme/api'])
    expect((await a.store.refresh()).message).toBe('repo-issues printed an unexpected shape')
    const b = make({ reply: () => { throw new Error('spawn python3 ENOENT') } })
    b.store.ask(['acme/api'])
    expect((await b.store.refresh()).message).toBe('Error: spawn python3 ENOENT')
    expect(b.store.view()?.repos[0].note).toBe('acme/api not read: Error: spawn python3 ENOENT')
  })
  it('while GitHub is paused nothing is read; a repository never read says so and is read after the pause', async () => {
    const { store, calls, t } = make()
    t.paused = true
    store.ask(['acme/api'])
    store.ask(['acme/api'])
    expect(calls).toEqual([])
    expect(store.view()?.repos).toEqual([{ repo: 'acme/api', account: null, ok: false, total: 0, shown: 0, note: 'acme/api not read: GitHub calls are paused', takenAt: null }])
    expect(await store.refresh(true)).toEqual({ ok: false, message: 'GitHub calls paused' })
    t.paused = false
    store.ask(['acme/api'])
    await store.refresh()
    expect(calls[0]).toEqual({ repos: ['acme/api'], force: false })
    expect(store.view()?.repos[0]).toMatchObject({ ok: true })
  })
  it('the cache round-trips; a repository unticked since is forgotten', async () => {
    const a = make()
    a.store.ask(['acme/api', 'acme/tracker'])
    await a.store.refresh()
    const saved = JSON.parse(JSON.stringify(a.store.dump()))
    const b = make()
    b.store.load(saved)
    expect(b.store.view()).toBeUndefined() // held, but no tab shows it: out of the state
    b.store.ask(['acme/api', 'acme/tracker'])
    expect(b.store.view()).toEqual(a.store.view())
    expect(b.calls).toEqual([]) // loading the cache reads nothing
    const c = make({ cfg: parseConfig({ owner: 'acme', issueRepo: 'tracker', projects: [BOARD] }) })
    c.store.load(saved)
    c.store.ask(['acme/tracker'])
    expect(c.store.view()?.repos.map((p) => p.repo)).toEqual(['acme/tracker'])
    b.t.cfg = loose // the board was removed in Setup: the tab now shows `master board`'s issues
    b.store.prune()
    b.store.ask(['acme/api', 'acme/tracker'])
    expect(b.store.view()).toBeUndefined()
    await b.store.refresh(true)
    expect(b.calls).toEqual([])
  })
  it('an assign shows at once', async () => {
    const { store } = make()
    store.ask(['acme/api'])
    await store.refresh()
    store.noteAssigned({ repo: 'acme/api', number: 7 }, 'alice')
    expect(store.view()?.cards[0].assignees).toEqual(['alice'])
  })
})

describe('RepoIssues: what the state carries', () => {
  it('only the repositories on screen; the rest stays in the cache', async () => {
    const { store, t } = make()
    store.ask(['acme/api'])
    t.now += 10
    store.ask(['acme/tracker'])
    await store.refresh()
    expect(store.view()?.repos.map((p) => p.repo)).toEqual(['acme/api', 'acme/tracker'])
    t.now += REPO_VIEW_LIVE_MS - 5 // api was asked for an hour ago, tracker a moment ago
    expect(store.view()?.repos.map((p) => p.repo)).toEqual(['acme/tracker'])
    expect(store.view()?.cards.map((c) => c.repo)).toEqual([null]) // acme/tracker is the primary repository: kept as null
    expect(Object.keys(store.dump() ?? {})).toEqual(['acme/api', 'acme/tracker']) // still cached
    t.now += 10
    expect(store.view()).toBeUndefined() // nothing on screen
    store.ask(['acme/api']) // a tab shows it again: its cards are at once there
    expect(store.view()?.cards.map((c) => c.repo)).toEqual(['acme/api'])
  })
  it('the view is cut to the card budget, and says so', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => card(i + 1, 'acme/api'))
    const { store } = make({ reply: () => ({ ok: true, data: { taken_at: 'x', cards: many, repos: [{ repo: 'acme/api', account: null, ok: true, total: 2000, shown: 2000 }] } }) })
    store.ask(['acme/api'])
    await store.refresh()
    const v = store.view()!
    expect(v.cards.length).toBeLessThan(2000)
    expect(v.repos[0]).toMatchObject({ total: 2000, shown: 2000, note: `Showing the first ${v.cards.length} of 2000 issues.` })
  })
})

describe('RepoIssues: untrusted asks are bounded', () => {
  const all = parseConfig({ owner: 'acme', issueRepo: 'tracker', allRepos: true, projects: [BOARD] })
  it('with Select all, an owner the config does not name is never read', async () => {
    const { store, calls } = make({ cfg: all })
    store.ask(['evil/secret', 'acme/web'])
    await store.refresh(true)
    expect(calls.map((c) => c.repos)).toEqual([['acme/web']]) // the refresh joined the ask's read
  })
  it('keeps at most so many repositories: the one asked for longest ago goes', async () => {
    const { store, t } = make({ cfg: all })
    for (let i = 0; i < REPO_VIEW_MAX_ENTRIES + 5; i++) {
      t.now += 1
      store.ask([`acme/r${i}`])
      await store.refresh()
    }
    const kept = Object.keys(store.dump() ?? {})
    expect(kept).toHaveLength(REPO_VIEW_MAX_ENTRIES)
    expect(kept).not.toContain('acme/r0')
    expect(kept).toContain(`acme/r${REPO_VIEW_MAX_ENTRIES + 4}`)
  })
})

describe('RepoIssues: failing, concurrent and half-written', () => {
  it('a repository never read is tried again after five minutes; one read before keeps its hour', async () => {
    let fail = true
    const { store, calls, t } = make({ reply: (repos) => (fail ? { ok: false, message: 'offline' } : { ok: true, data: answer(repos) }) })
    store.ask(['acme/api'])
    await store.refresh()
    expect(calls).toHaveLength(1) // the refresh joined the ask's read
    const n = calls.length
    t.now += REPO_VIEW_RETRY_MS - 1
    store.ask(['acme/api'])
    expect(calls).toHaveLength(n)
    t.now += 1
    fail = false
    store.ask(['acme/api'])
    await store.refresh()
    expect(calls).toHaveLength(n + 1)
    expect(store.view()?.repos[0]).toMatchObject({ ok: true })
  })
  it('a rate-limited repository (the real note) starts the shared pause', async () => {
    const { store, notes } = make({ reply: () => ({ ok: true, data: { taken_at: 'x', cards: [], repos: [{ repo: 'acme/api', account: null, ok: false, total: 0, shown: 0, note: 'acme/api not read: RATE_LIMITED' }] } }) })
    store.ask(['acme/api'])
    await store.refresh()
    expect(notes).toContain('acme/api not read: RATE_LIMITED')
  })
  it('a refresh joins the read that runs; loading lasts until it ends; an overlapping read of another repository is its own', async () => {
    const release: (() => void)[] = []
    const { store, calls } = make({ reply: (repos) => { const r = { ok: true as const, data: answer(repos) }; return r } })
    const slow = new RepoIssues({
      read: (repos, force) => new Promise((res) => { calls.push({ repos, force }); release.push(() => res({ ok: true, data: answer(repos) })) }),
      config: () => boarded, paused: () => false, changed: () => {}, now: () => 1_000_000,
    })
    slow.ask(['acme/api'])
    const joined = slow.refresh(true) // while the first runs
    slow.ask(['acme/tracker']) // another repository: its own read, queued behind
    await tick()
    expect(calls).toHaveLength(1)
    release[0]()
    expect(await joined).toEqual({ ok: true, message: 'refreshed' })
    await tick()
    expect(slow.view()?.repos.find((p) => p.repo === 'acme/api')).not.toHaveProperty('loading')
    expect(slow.view()?.repos.find((p) => p.repo === 'acme/tracker')).toMatchObject({ loading: true }) // still waiting its turn
    release[1]()
    await tick()
    expect(slow.view()?.repos.every((p) => !p.loading)).toBe(true)
    expect(calls.map((c) => c.repos)).toEqual([['acme/api'], ['acme/tracker']])
  })
  it('a read that ends after its repository was unticked does not bring it back', async () => {
    let release = () => {}
    const t = { cfg: boarded }
    const store = new RepoIssues({
      read: (repos) => new Promise((res) => { release = () => res({ ok: true, data: answer(repos) }) }),
      config: () => t.cfg, paused: () => false, changed: () => {}, now: () => 1_000_000,
    })
    store.ask(['acme/api'])
    t.cfg = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker'], projects: [BOARD] })
    await tick()
    store.prune()
    release()
    await tick()
    expect(store.dump()).toBeUndefined()
    expect(store.view()).toBeUndefined()
  })
  it('a config that cannot be read prunes nothing', async () => {
    const a = make()
    a.store.ask(['acme/api'])
    await a.store.refresh()
    const saved = JSON.parse(JSON.stringify(a.store.dump()))
    const b = make({ cfg: parseConfig({}) }) // half-written config.json: not configured
    b.store.load(saved)
    b.store.prune()
    expect(Object.keys(b.store.dump() ?? {})).toEqual(['acme/api'])
    b.t.cfg = boarded
    b.store.prune()
    expect(Object.keys(b.store.dump() ?? {})).toEqual(['acme/api'])
  })
})
