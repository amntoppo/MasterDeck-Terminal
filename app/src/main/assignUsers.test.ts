import { describe, expect, it } from 'vitest'
import { parseConfig } from '@shared/appConfig'
import { AssignableUsers, ASSIGN_USERS_MAX, ASSIGN_USERS_TTL_MS } from './assignUsers'

const BOARD = { owner: 'acme', number: 1, title: 'Delivery', columns: ['Todo'] }
const acct = (login: string, owner: string, repos: string[], more: Record<string, unknown> = {}) => ({ login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repos[0].split('/')[1], repos, projects: [], ...more })
const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/tracker', 'acme/api'], { primary: true, projects: [BOARD] }), acct('bob-work', 'globex', ['globex/app'])] })
const legacy = parseConfig({ owner: 'acme', issueRepo: 'tracker', project: 1 })

function make(cfg = two, reply: (repo: string) => string[] | null | Promise<string[] | null> = (r) => [`dev-of-${r.split('/')[1]}`, 'zoe']) {
  const calls: string[] = []
  const t = { now: 1_000_000, cfg }
  const store = new AssignableUsers({
    read: async (repo) => {
      calls.push(repo)
      return reply(repo)
    },
    config: () => t.cfg,
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
  it('a failed read says so and is not kept: the next popup tries again', async () => {
    let fail = true
    const { store, calls } = make(two, () => (fail ? null : ['zoe']))
    expect(await store.get('acme/api')).toEqual({ ok: false, message: 'Could not read who can be assigned in acme/api.' })
    fail = false
    expect(await store.get('acme/api')).toEqual({ ok: true, users: ['zoe'] })
    expect(calls).toHaveLength(2)
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
