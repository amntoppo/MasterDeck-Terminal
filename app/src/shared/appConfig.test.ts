import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, issueRef, issueUrl, parseConfig, projectKey, statusGroup, statusRank } from './appConfig'

describe('appConfig', () => {
  it('parses master config show output and fills defaults', () => {
    const c = parseConfig({ configured: true, path: '/p', config: { owner: 'acme', issueRepo: 'tracker', statuses: { inProgress: 'Doing' } } })
    expect(c.configured).toBe(true)
    expect(c.statuses.inProgress).toBe('Doing')
    expect(c.statuses.ready).toBe(DEFAULT_CONFIG.statuses.ready)
    expect(issueRef(c)).toBe('acme/tracker')
    expect(issueUrl(3, null, c)).toBe('https://github.com/acme/tracker/issues/3')
    expect(parseConfig({}).configured).toBe(false)
    expect(parseConfig(null).owner).toBe('')
  })
  it('ranks and groups statuses', () => {
    const c = parseConfig({ owner: 'a', issueRepo: 'b', columns: ['Todo', 'Doing', 'Review', 'Done', 'Blocked'], statuses: { ready: 'Todo', inProgress: 'Doing', prRaised: 'Review', devDone: 'Done', done: ['Done'], blocked: ['Blocked'], resumable: ['Doing'], assignable: ['Todo'], rank: { Blocked: 0 } } })
    expect(statusRank('Review', c)).toBe(2)
    expect(statusRank('Blocked', c)).toBe(0)
    expect(statusRank('Nope', c)).toBe(-1)
    expect(['Todo', 'Doing', 'Review', 'Done', 'Blocked'].map((s) => statusGroup(s, c))).toEqual(['todo', 'progress', 'review', 'done', 'blocked'])
  })
})

describe('peerSync', () => {
  it('is absent unless auto is a boolean', () => {
    expect(parseConfig({}).peerSync).toBeUndefined()
    expect(parseConfig({ peerSync: { auto: 'no' } }).peerSync).toBeUndefined()
    expect(parseConfig({ peerSync: { auto: false } }).peerSync).toEqual({ auto: false })
  })
})

describe('masterEnabled', () => {
  it('defaults to on; only false turns master off', () => {
    expect(parseConfig({}).masterEnabled).toBe(true)
    expect(parseConfig({ masterEnabled: false }).masterEnabled).toBe(false)
    expect(parseConfig({ masterEnabled: 'no' }).masterEnabled).toBe(true)
  })
})

const A = { login: 'alice', primary: true, name: 'Alice', email: 'a@acme.test', owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [{ owner: 'acme', number: 1, title: 'Delivery', columns: ['Todo', 'Done'] }] }
const B = { login: 'bob-work', name: 'Bob', email: 'b@globex.test', owner: 'globex', issueRepo: 'app', repos: ['globex/app', 'acme/api'], projects: [{ owner: 'globex', number: 7, title: 'Globex', columns: ['Backlog', 'Shipped'] }] }

describe('accounts', () => {
  it('an account may carry its own workspace; without one it has none (the config\'s applies)', () => {
    const c = parseConfig({ workspace: '/code/acme', accounts: [A, { ...B, workspace: '/code/globex' }] })
    expect(c.workspace).toBe('/code/acme')
    expect(c.accounts.map((a) => a.workspace)).toEqual([undefined, '/code/globex'])
    expect('workspace' in c.accounts[0]).toBe(false)
    expect(parseConfig({ accounts: [A, { ...B, workspace: 5 }, ] }).accounts[1].workspace).toBeUndefined()
    expect(parseConfig({ accounts: [A, { ...B, workspace: '  ' }] }).accounts[1].workspace).toBeUndefined()
  })
  it('a config without accounts is one account mode', () => {
    const c = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'] })
    expect(c.accounts).toEqual([])
    expect(c.repos).toEqual(['acme/tracker', 'acme/api'])
    expect(DEFAULT_CONFIG.accounts).toEqual([])
  })
  it('puts the primary first, and the repos and boards of every account in the lists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [B, A] })
    expect(c.accounts.map((a) => [a.login, a.primary])).toEqual([['alice', true], ['bob-work', undefined]])
    expect(c.repos).toEqual(['acme/tracker', 'acme/api', 'globex/app'])
    expect(c.projects.map(projectKey)).toEqual(['acme/1', 'globex/7'])
    expect(statusRank('Shipped', c, 'globex/7')).toBe(1)
    expect(c.owner).toBe('acme')
    warn.mockRestore()
  })
  it('drops a repo already under an earlier account, and a login listed twice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = parseConfig({ accounts: [A, B, { ...B, email: 'other@globex.test' }] })
    expect(c.accounts).toHaveLength(2)
    expect(c.accounts[1].repos).toEqual(['globex/app'])
    expect(warn).toHaveBeenCalledWith('config: acme/api is under alice already; left out of bob-work')
    warn.mockRestore()
  })
  it('makes exactly one primary, keeps bad logins out, fills the name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = parseConfig({ accounts: [{ ...A, primary: undefined }, { ...B, primary: true }, { login: 'bad login!' }] })
    expect(c.accounts.map((a) => a.login)).toEqual(['bob-work', 'alice'])
    expect(c.accounts.filter((a) => a.primary)).toHaveLength(1)
    expect(parseConfig({ accounts: [{ login: 'carol' }] }).accounts[0]).toMatchObject({ login: 'carol', name: 'carol', email: '', repos: [], projects: [] })
    warn.mockRestore()
  })
})
