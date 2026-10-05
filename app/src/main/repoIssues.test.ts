import { describe, expect, it } from 'vitest'
import { parseConfig, setConfig } from '@shared/appConfig'
import { repoViewStatus, REPO_VIEW_HELD_MS, REPO_VIEW_LIVE_MS, REPO_VIEW_MAX_ENTRIES, REPO_VIEW_MAX_QUEUED, REPO_VIEW_RETRY_MS, REPO_VIEW_STALE_MS } from '@shared/repoView'
import { RepoIssues } from './repoIssues'
import { RATE_LIMITED } from './sources'

const BOARD = { owner: 'acme', number: 1, title: 'Delivery', columns: ['To Do', 'In QA'] }
const boarded = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [BOARD] })
const loose = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'] })
setConfig(boarded)

const card = (n: number, repo: string) => ({ number: n, repo, project: null, title: `Issue ${n}`, url: '', status: null, prs: [], assignees: [], labels: [], milestone: null, type: null, derived: true, state: 'OPEN', closedAt: null })
const answer = (repos: string[], n = 7) => ({ taken_at: 'x', cards: repos.map((r) => card(n, r)), repos: repos.map((r) => ({ repo: r, account: null, ok: true, total: 1, shown: 1 })) })

const tick = () => new Promise((r) => setTimeout(r, 0))
/** Lets the reads an ask started end (no refresh: that would read again). */
const settle = async () => {
  for (let i = 0; i < 3; i++) await tick()
}

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
    expect(notes).toEqual(['gh: API rate limit exceeded']) // what gh said, without the repository's name
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
    expect(v.repos[0]).toMatchObject({ total: 2000, shown: 2000, cut: true, note: `api: showing the first ${v.cards.length} of the 2000 issues read, to keep the view small.` })
  })
})

describe('RepoIssues: untrusted asks are bounded', () => {
  const all = parseConfig({ owner: 'acme', issueRepo: 'tracker', allRepos: true, projects: [BOARD] })
  it('with Select all, an owner the config does not name is never read', async () => {
    const { store, calls } = make({ cfg: all })
    store.ask(['evil/secret', 'acme/web'])
    await store.refresh()
    expect(calls.map((c) => c.repos)).toEqual([['acme/web']]) // the refresh joined the ask's read
  })
  it('keeps at most so many repositories: one off screen, asked for longest ago, makes room', async () => {
    const { store, t } = make({ cfg: all })
    for (let i = 0; i < REPO_VIEW_MAX_ENTRIES; i++) {
      t.now += 1
      store.ask([`acme/r${i}`])
      await store.refresh()
    }
    t.now += REPO_VIEW_LIVE_MS // every tab that showed them is gone
    for (let i = REPO_VIEW_MAX_ENTRIES; i < REPO_VIEW_MAX_ENTRIES + 5; i++) {
      t.now += 1
      store.ask([`acme/r${i}`])
      await store.refresh()
    }
    const kept = Object.keys(store.dump() ?? {})
    expect(kept).toHaveLength(REPO_VIEW_MAX_ENTRIES)
    for (let i = 0; i < 5; i++) expect(kept).not.toContain(`acme/r${i}`)
    expect(kept).toContain('acme/r5')
    expect(kept).toContain(`acme/r${REPO_VIEW_MAX_ENTRIES + 4}`)
  })
})

describe('RepoIssues: "Select all" on one account, a second account without', () => {
  const GLOBEX = { owner: 'globex', number: 7, title: 'Globex', columns: ['Todo'] }
  const acct = (login: string, owner: string, repos: string[], projects: unknown[], more: Record<string, unknown> = {}) => ({ login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repos[0].split('/')[1], repos, projects, ...more })
  const mixed = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/tracker'], [BOARD], { primary: true, allRepos: true }), acct('bob-work', 'globex', ['globex/app'], [GLOBEX])] })
  it('another owner\'s unlisted repository, and names that are logins, never reach the read', async () => {
    const { store, calls } = make({ cfg: mixed })
    store.ask(['acme/new', 'globex/secret', 'alice/diary', 'bob-work/notes', 'globex/app'])
    await store.refresh()
    expect(calls.map((c) => c.repos)).toEqual([['acme/new', 'globex/app']])
    expect(store.view()?.repos.map((p) => p.repo)).toEqual(['acme/new', 'globex/app'])
  })
})

describe('RepoIssues: several tabs, more repositories than it keeps', () => {
  const names = (from: number, n: number) => Array.from({ length: n }, (_, i) => `acme/r${from + i}`)
  const forty = parseConfig({ owner: 'acme', issueRepo: 'r0', repos: names(0, 40), projects: [BOARD] })
  it('two tabs with 20 different repositories each: nothing on screen is pushed out, nothing is read twice, the rest says why', async () => {
    const { store, calls, t } = make({ cfg: forty })
    const a = names(0, 20)
    const b = names(20, 20)
    let lastA = 0
    for (let round = 0; round < 6; round++) {
      t.now += 60_000
      store.ask(a)
      lastA = t.now
      await settle()
      t.now += 60_000
      store.ask(b)
      await settle()
    }
    const read = calls.flatMap((c) => c.repos)
    expect(new Set(read).size).toBe(read.length) // an ask never read a repository a second time
    expect(read.sort()).toEqual([...a, ...b.slice(0, 10)].sort())
    const parts = store.view()!.repos
    expect(parts.filter((p) => p.ok).map((p) => p.repo).sort()).toEqual([...a, ...b.slice(0, 10)].sort())
    const out = parts.filter((p) => !p.ok)
    expect(out.map((p) => p.repo)).toEqual(b.slice(10))
    for (const p of out) expect(p).toEqual({ repo: p.repo, account: null, ok: false, total: 0, shown: 0, takenAt: null, note: `${p.repo} not read: MasterDeck already shows ${REPO_VIEW_MAX_ENTRIES} repositories in open tabs. It makes room about 25 minutes after a tab stops showing one.` })
    // The second tab says so instead of loading for ever, and goes on asking.
    const st = repoViewStatus(store.view(), b, forty)
    expect(st).toMatchObject({ loading: false, failed: b.slice(10), retry: true })
    // The first tab goes back to the board and stops asking; the second goes on asking every 5 minutes.
    for (let i = 0; i < 4; i++) {
      t.now += 5 * 60_000
      store.ask(b)
      await settle()
    }
    expect(repoViewStatus(store.view(), b, forty).failed).toEqual(b.slice(10)) // 21 minutes: a tab that asks every 20 may still be there
    t.now += 5 * 60_000
    expect(t.now - 60_000 - REPO_VIEW_HELD_MS).toBeGreaterThanOrEqual(lastA) // 26 minutes after the first tab's last ask
    store.ask(b)
    await settle()
    expect(t.now - lastA).toBeLessThan(REPO_VIEW_LIVE_MS) // well within the hour
    expect(repoViewStatus(store.view(), b, forty)).toMatchObject({ loading: false, failed: [] })
    expect(store.view()!.repos.filter((p) => p.ok).map((p) => p.repo)).toEqual(expect.arrayContaining(b))
    expect(Object.keys(store.dump() ?? {})).toHaveLength(REPO_VIEW_MAX_ENTRIES)
  })
  it('first reads cannot pile up: past the most that may wait, a new repository is refused with a reason, and nothing more is queued', async () => {
    const all = parseConfig({ owner: 'acme', issueRepo: 'tracker', allRepos: true, projects: [BOARD] })
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const calls: string[][] = []
    const t = { now: 1_000_000 }
    const store = new RepoIssues({
      read: async (repos) => {
        calls.push(repos)
        await gate
        return { ok: true, data: answer(repos) }
      },
      config: () => all,
      paused: () => false,
      changed: () => {},
      now: () => t.now,
    })
    // A browser asks for ever new names, ten at a time.
    for (let i = 0; i < 20; i++) store.ask(names(i * 10, 10))
    await tick()
    const parts = store.view()!.repos
    expect(parts.filter((p) => p.loading)).toHaveLength(REPO_VIEW_MAX_QUEUED)
    const refused = parts.filter((p) => !p.loading)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.length).toBeLessThanOrEqual(REPO_VIEW_MAX_ENTRIES) // and the refusals themselves are bounded
    for (const p of refused) expect(p.note).toBe(`${p.repo} not read: ${REPO_VIEW_MAX_QUEUED} repositories are already waiting for their first read. It is asked again in a few minutes.`)
    release()
    await store.refresh()
    expect(calls.flat()).toHaveLength(REPO_VIEW_MAX_QUEUED)
    expect(calls.flat()).toEqual(names(0, REPO_VIEW_MAX_QUEUED))
  })
  it('a refused repository is taken in by a later ask once there is room, and its refusal goes', async () => {
    const { store, t } = make({ cfg: forty })
    store.ask(names(0, 30))
    await store.refresh()
    store.ask(['acme/r35'])
    const no = store.view()!.repos.find((p) => p.repo === 'acme/r35')!
    expect(no).toMatchObject({ ok: false, takenAt: null })
    expect(no.note).toContain('MasterDeck already shows')
    expect(no).not.toHaveProperty('loading')
    t.now += REPO_VIEW_LIVE_MS
    store.ask(['acme/r35'])
    await store.refresh()
    expect(store.view()!.repos).toMatchObject([{ repo: 'acme/r35', ok: true }])
  })
  it('a refusal is forgotten an hour after its last ask, and when Setup no longer selects the repository', async () => {
    const { store, t } = make({ cfg: forty })
    store.ask(names(0, 30))
    await settle()
    t.now += 10
    store.ask(['acme/r35'])
    expect(store.view()!.repos.map((p) => p.repo)).toContain('acme/r35')
    t.now += REPO_VIEW_LIVE_MS - 10 // the thirty are off screen now; the refusal was asked for 10 ms later
    store.ask(['acme/r1'])
    expect(store.view()!.repos.map((p) => p.repo)).toEqual(['acme/r1', 'acme/r35'])
    t.now += 10
    expect(store.view()!.repos.map((p) => p.repo)).toEqual(['acme/r1'])
    const again = make({ cfg: forty })
    again.store.ask(names(0, 30))
    await settle()
    again.store.ask(['acme/r35'])
    expect(again.store.view()!.repos.map((p) => p.repo)).toContain('acme/r35')
    again.t.cfg = parseConfig({ owner: 'acme', issueRepo: 'r0', repos: names(0, 30), projects: [BOARD] })
    again.store.prune()
    expect(again.store.view()!.repos.map((p) => p.repo)).not.toContain('acme/r35')
    expect(again.store.view()!.repos).toHaveLength(30)
  })
})

describe('RepoIssues: Retry and Refresh read past the caches', () => {
  it('a forced refresh does not settle for an unforced read that runs: the repository is read again, forced', async () => {
    let release = () => {}
    const gates: Promise<void>[] = [new Promise<void>((r) => (release = r))]
    const calls: { repos: string[]; force: boolean }[] = []
    const store = new RepoIssues({
      read: async (repos, force) => {
        calls.push({ repos, force })
        await (gates.shift() ?? Promise.resolve())
        // Unforced, the CLI answers from its one-hour memory of a repository it did not find.
        return { ok: true, data: force ? answer(repos) : { taken_at: 'x', cards: [], repos: repos.map((r) => ({ repo: r, account: null, ok: false, total: 0, shown: 0, note: `Not found: ${r}` })) } }
      },
      config: () => boarded,
      paused: () => false,
      changed: () => {},
      now: () => 1_000_000,
    })
    store.ask(['acme/api']) // the tab's own ask: unforced, running
    await tick()
    const retry = store.refresh(true) // Retry while it runs
    expect(store.view()?.repos[0]).toMatchObject({ loading: true })
    release()
    expect(await retry).toEqual({ ok: true, message: 'refreshed' })
    expect(calls).toEqual([{ repos: ['acme/api'], force: false }, { repos: ['acme/api'], force: true }])
    expect(store.view()?.repos[0]).toMatchObject({ repo: 'acme/api', ok: true })
    expect(store.view()?.repos[0]).not.toHaveProperty('loading')
  })
  it('an unforced refresh, and a second forced one, still join the read that runs', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const calls: boolean[] = []
    const store = new RepoIssues({
      read: async (repos, force) => {
        calls.push(force)
        await gate
        return { ok: true, data: answer(repos) }
      },
      config: () => boarded,
      paused: () => false,
      changed: () => {},
      now: () => 1_000_000,
    })
    store.ask(['acme/api'])
    await tick()
    const plain = store.refresh()
    const forced = store.refresh(true)
    const again = store.refresh(true)
    release()
    await Promise.all([plain, forced, again])
    expect(calls).toEqual([false, true]) // one forced read for both forced requests
  })
})

describe('RepoIssues: the pause hears what gh said, not a repository\'s name', () => {
  it('"Not found: acme/rate-limiter" starts no pause; a rate limit on it does', async () => {
    const limiter = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/rate-limiter'], projects: [BOARD] })
    let note = 'Not found: acme/rate-limiter'
    const { store, notes } = make({ cfg: limiter, reply: () => ({ ok: true, data: { taken_at: 'x', cards: [], repos: [{ repo: 'acme/rate-limiter', account: null, ok: false, total: 0, shown: 0, note }] } }) })
    store.ask(['acme/rate-limiter'])
    await store.refresh()
    expect(notes).toEqual([])
    expect(notes.some((n) => RATE_LIMITED.test(n))).toBe(false)
    note = 'acme/rate-limiter not read: NOT_FOUND'
    await store.refresh(true)
    expect(notes).toEqual(['NOT_FOUND'])
    expect(RATE_LIMITED.test(notes[0])).toBe(false)
    note = 'acme/rate-limiter not read: RATE_LIMITED'
    await store.refresh(true)
    expect(RATE_LIMITED.test(notes[1])).toBe(true)
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
    expect(notes).toEqual(['RATE_LIMITED'])
  })
  it('a refresh joins the read that runs; loading lasts until it ends; an overlapping read of another repository is its own', async () => {
    const release: (() => void)[] = []
    const { store, calls } = make({ reply: (repos) => { const r = { ok: true as const, data: answer(repos) }; return r } })
    const slow = new RepoIssues({
      read: (repos, force) => new Promise((res) => { calls.push({ repos, force }); release.push(() => res({ ok: true, data: answer(repos) })) }),
      config: () => boarded, paused: () => false, changed: () => {}, now: () => 1_000_000,
    })
    slow.ask(['acme/api'])
    const joined = slow.refresh() // while the first runs (the hourly refresh; a forced one reads again: below)
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
