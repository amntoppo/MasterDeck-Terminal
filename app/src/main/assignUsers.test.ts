import { describe, expect, it } from 'vitest'
import { parseConfig } from '@shared/appConfig'
import { AssignableUsers, ASSIGN_USERS_FAILED_MS, ASSIGN_USERS_MAX, ASSIGN_USERS_TTL_MS } from './assignUsers'

const BOARD = { owner: 'acme', number: 1, title: 'Delivery', columns: ['Todo'] }
const acct = (login: string, owner: string, repos: string[], more: Record<string, unknown> = {}) => ({ login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repos[0].split('/')[1], repos, projects: [], ...more })
const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/tracker', 'acme/api'], { primary: true, projects: [BOARD] }), acct('bob-work', 'globex', ['globex/app'])] })
const legacy = parseConfig({ owner: 'acme', issueRepo: 'tracker', project: 1 })

function make(cfg = two, reply: (repo: string) => string[] | null | Promise<string[] | null> = (r) => [`dev-of-${r.split('/')[1]}`, 'zoe'], onBoard: string[] = []) {
  const calls: string[] = []
  const t = { now: 1_000_000, cfg, onBoard, stamp: 1 }
  const store = new AssignableUsers({
    read: async (repo) => {
      calls.push(repo)
      return reply(repo)
    },
    config: () => t.cfg,
    boardRepos: () => t.onBoard,
    boardStamp: () => t.stamp,
    now: () => t.now,
  })
  return { store, calls, t }
}

describe('AssignableUsers (who can be assigned in a repository, read when the Assign popup opens)', () => {
  it('reads the card\'s repository, as Setup spells it; no repository is the primary issue repo', async () => {
    const { store, calls } = make()
    expect(await store.get('GLOBEX/App')).toEqual({ ok: true, users: ['dev-of-app', 'zoe'] })
    expect(await store.get(null)).toEqual({ ok: true, users: ['dev-of-tracker', 'zoe'] })
    expect(await store.get('')).toEqual({ ok: true, users: ['dev-of-tracker', 'zoe'] })
    expect(calls).toEqual(['globex/app', 'acme/tracker'])
    const old = make(legacy)
    expect(await old.store.get(undefined)).toEqual({ ok: true, users: ['dev-of-tracker', 'zoe'] })
    expect(old.calls).toEqual(['acme/tracker'])
  })
  it('keeps the answer for an hour, per repository', async () => {
    const { store, calls, t } = make()
    await store.get('acme/api')
    t.now += ASSIGN_USERS_TTL_MS - 1
    await store.get('ACME/api')
    await store.get('globex/app')
    expect(calls).toEqual(['acme/api', 'globex/app'])
    t.now += 1
    await store.get('acme/api')
    expect(calls).toEqual(['acme/api', 'globex/app', 'acme/api'])
  })
  it('two popups asking at once share one read', async () => {
    let release = (_: string[]) => {}
    const { store, calls } = make(two, () => new Promise<string[]>((r) => (release = r)))
    const a = store.get('acme/api')
    const b = store.get('acme/api')
    await Promise.resolve()
    release(['zoe'])
    expect(await Promise.all([a, b])).toEqual([{ ok: true, users: ['zoe'] }, { ok: true, users: ['zoe'] }])
    expect(calls).toEqual(['acme/api'])
  })
  it('a failed read says so and is tried again after a minute, not at once (a client cannot repeat it without bound)', async () => {
    let fail = true
    const { store, calls, t } = make(two, () => (fail ? null : ['zoe']))
    expect(await store.get('acme/api')).toEqual({ ok: false, message: 'Could not read who can be assigned in acme/api.' })
    fail = false
    t.now += ASSIGN_USERS_FAILED_MS - 1
    expect(await store.get('acme/api')).toEqual({ ok: false, message: 'Could not read who can be assigned in acme/api.' })
    expect(calls).toHaveLength(1)
    expect(await store.get('globex/app')).toMatchObject({ ok: true }) // another repository is not held back
    t.now += 1
    expect(await store.get('acme/api')).toEqual({ ok: true, users: ['zoe'] })
    expect(calls).toHaveLength(3)
    expect(ASSIGN_USERS_FAILED_MS).toBe(60_000)
    const thrown = make(two, () => { throw new Error('spawn gh ENOENT') })
    expect(await thrown.store.get('acme/api')).toEqual({ ok: false, message: 'Could not read who can be assigned in acme/api.' })
  })
  it('a repository the config does not select is refused without a read (the web may ask)', async () => {
    const { store, calls } = make()
    for (const bad of ['evil/secret', 'globex/secret', 'alice/diary', 'not a repo', '../etc', 7, {}, ['acme/api']]) expect(await store.get(bad), String(bad)).toMatchObject({ ok: false })
    expect((await store.get('evil/secret') as { message: string }).message).toBe('evil/secret is not selected in Setup.')
    expect(calls).toEqual([])
    const none = make(parseConfig({}))
    expect(await none.store.get(null)).toMatchObject({ ok: false })
    expect(none.calls).toEqual([])
  })
  it('a repository Setup does not tick is read when a card of the loaded board is in it, as the board spells it', async () => {
    const { store, calls, t } = make(two, undefined, ['acme/tracker', 'Partner/Portal'])
    expect(await store.get('partner/portal')).toEqual({ ok: true, users: ['dev-of-Portal', 'zoe'] })
    expect(calls).toEqual(['Partner/Portal'])
    expect(await store.get('partner/other')).toEqual({ ok: false, message: 'partner/other is not selected in Setup.' }) // neither selected nor on the board
    expect(await store.get('evil/secret')).toMatchObject({ ok: false })
    expect(calls).toEqual(['Partner/Portal'])
    // The board no longer holds it: a name from a client alone is not enough, not even from memory.
    t.onBoard = ['acme/tracker']
    expect(await store.get('Partner/Portal')).toMatchObject({ ok: false })
    expect(calls).toEqual(['Partner/Portal'])
    // What the board says is not trusted as a name either.
    t.onBoard = ['not a repo', '../x', 'acme/..']
    for (const bad of t.onBoard) expect(await store.get(bad)).toMatchObject({ ok: false })
    expect(calls).toEqual(['Partner/Portal'])
  })
  it('a failure is forgotten at once when the config changes or a board read lands', async () => {
    let fail = true
    const { store, calls, t } = make(two, () => (fail ? null : ['zoe']))
    await store.get('acme/api')
    await store.get('acme/api')
    expect(calls).toHaveLength(1)
    t.stamp = 2 // a board refresh landed (the card may be routed to another account now)
    await store.get('acme/api')
    expect(calls).toHaveLength(2)
    await store.get('acme/api')
    expect(calls).toHaveLength(2)
    t.cfg = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/tracker', 'acme/api'], { primary: true, projects: [BOARD] }), acct('bob-work', 'globex', ['globex/app'])] }) // Setup saved
    fail = false
    expect(await store.get('acme/api')).toEqual({ ok: true, users: ['zoe'] })
    expect(calls).toHaveLength(3)
  })
  it('the primary issue repo is always read, also when no account lists it', async () => {
    const odd = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/api'], { primary: true, issueRepo: 'api' })] })
    expect(odd.repos).not.toContain('acme/tracker')
    const { store, calls } = make(odd)
    expect(await store.get(null)).toMatchObject({ ok: true })
    expect(await store.get('ACME/Tracker')).toMatchObject({ ok: true })
    expect(calls).toEqual(['acme/tracker'])
  })
  it('remembers a bounded number of repositories: the one read longest ago goes', async () => {
    const all = parseConfig({ owner: 'acme', issueRepo: 'tracker', allRepos: true, projects: [BOARD] })
    const { store, calls, t } = make(all)
    for (let i = 0; i < ASSIGN_USERS_MAX + 3; i++) {
      t.now += 1
      await store.get(`acme/r${i}`)
    }
    await store.get(`acme/r${ASSIGN_USERS_MAX + 2}`) // kept
    expect(calls).toHaveLength(ASSIGN_USERS_MAX + 3)
    await store.get('acme/r0') // gone: read again
    expect(calls).toHaveLength(ASSIGN_USERS_MAX + 4)
  })
})
