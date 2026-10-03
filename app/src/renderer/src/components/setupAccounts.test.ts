import { describe, expect, it } from 'vitest'
import { parseConfig } from '@shared/appConfig'
import type { DetectAll, DetectedBoard } from '@shared/detect'
import { accountsFromSetup, selFromConfig, switchSel, takenBy, withFound, type AccountSel } from './setupAccounts'

const board = parseConfig({ projects: [{ owner: 'globex', number: 7 }] }).projects[0]
const sel: Record<string, AccountSel> = {
  alice: { repos: ['acme/tracker', 'acme/api'], allRepos: false, primary: 'acme/api', boards: {}, allBoards: false },
  'bob-work': { repos: ['globex/app'], allRepos: true, primary: '', boards: { 'globex/7': board }, allBoards: false },
}

describe('setup accounts', () => {
  it('builds the accounts list: the primary first, each with its main repo first', () => {
    const list = accountsFromSetup(
      [{ login: 'bob-work', name: ' Bob ', email: 'b@globex.test' }, { login: 'alice', name: '', email: 'a@acme.test' }],
      'alice',
      sel,
      (_l, owner) => (owner === 'acme' ? 'organization' : 'user'),
    )
    expect(list).toEqual([
      { login: 'alice', primary: true, name: 'alice', email: 'a@acme.test', owner: 'acme', ownerType: 'organization', issueRepo: 'api', repos: ['acme/api', 'acme/tracker'], allRepos: false, projects: [], allProjects: false },
      { login: 'bob-work', name: 'Bob', email: 'b@globex.test', owner: 'globex', ownerType: 'user', issueRepo: 'app', repos: ['globex/app'], allRepos: true, projects: [board], allProjects: false },
    ])
  })
  it('an account with nothing picked yet has no repos', () => {
    expect(accountsFromSetup([{ login: 'carol', name: 'C', email: 'c@initech.test' }], 'carol', {}, () => 'user')[0]).toMatchObject({ owner: '', issueRepo: '', ownerType: 'organization', repos: [], projects: [] })
  })
  it('a repo ticked under another account is taken (case-insensitive)', () => {
    expect(takenBy('ACME/api', 'bob-work', sel)).toBe('alice')
    expect(takenBy('acme/api', 'alice', sel)).toBeNull()
    expect(takenBy('initech/x', 'alice', sel)).toBeNull()
  })
  it('reads an account back from the config', () => {
    const a = parseConfig({ accounts: [{ login: 'alice', owner: 'acme', issueRepo: 'tracker', repos: ['acme/api'], projects: [{ owner: 'acme', number: 1 }] }] }).accounts[0]
    expect(selFromConfig(a)).toEqual({ repos: ['acme/tracker', 'acme/api'], allRepos: false, primary: 'acme/tracker', boards: { 'acme/1': a.projects[0] }, allBoards: false })
  })
})

const EMPTY: AccountSel = { repos: [], allRepos: false, primary: '', boards: {}, allBoards: false }
const det = (p: Partial<DetectedBoard> & { owner: string; number: number }): DetectedBoard => ({
  ...parseConfig({ projects: [{ owner: p.owner, number: p.number }] }).projects[0],
  closed: false,
  items: 0,
  ...p,
})
const globex: DetectAll = {
  user: 'bob-work',
  owners: [{ login: 'globex', type: 'organization', repos: [{ repo: 'globex/app', openIssues: 3 }, { repo: 'globex/web', openIssues: 9 }], projects: [det({ owner: 'globex', number: 7, title: 'Roadmap' })] }],
}

describe('switching accounts on Repos & boards', () => {
  it("shows the target's own choices and keeps the screen's under the account left", () => {
    const shown: AccountSel = { ...EMPTY, repos: ['acme/api'], primary: 'acme/api' }
    const r = switchSel(sel, 'alice', shown, 'bob-work')
    expect(r.shown).toBe(sel['bob-work'])
    expect(r.sel.alice).toBe(shown)
  })
  it('an account never shown before starts empty', () => {
    expect(switchSel(sel, 'alice', sel.alice, 'carol').shown).toEqual(EMPTY)
  })
  it("no account shown yet (a config whose migration failed): the screen's choices become the target's", () => {
    const fromTopLevel: AccountSel = { ...EMPTY, repos: ['acme/api'], primary: 'acme/api' }
    const r = switchSel({}, '', fromTopLevel, 'alice')
    expect(r.shown).toBe(fromTopLevel)
    expect(r.sel).toEqual({})
  })
  it('a disconnected account loses its choices', () => {
    const r = switchSel(sel, 'bob-work', sel['bob-work'], 'alice', 'bob-work')
    expect(Object.keys(r.sel)).toEqual(['alice'])
    expect(r.shown).toBe(sel.alice)
  })
})

describe("an account's choices once its repos are read", () => {
  it("Select all on one account does not tick the next account's repos", () => {
    // The account read is bob-work, whose own choices are not "Select all" (alice's were).
    const r = withFound({ ...EMPTY, repos: ['globex/app'], primary: 'globex/app' }, globex, () => false)
    expect(r.repos).toEqual(['globex/app'])
    expect(r.allRepos).toBe(false)
  })
  it('Select all takes every repo there is now, but not one under another account', () => {
    const r = withFound({ ...EMPTY, allRepos: true }, globex, (x) => x === 'globex/web')
    expect(r.repos).toEqual(['globex/app'])
  })
  it('a first pick starts from the repo with the most open issues and its only board', () => {
    const r = withFound(EMPTY, globex, () => false)
    expect(r).toMatchObject({ repos: ['globex/web'], primary: 'globex/web' })
    expect(Object.keys(r.boards)).toEqual(['globex/7'])
  })
  it('chosen boards take GitHub’s title and keep their statuses', () => {
    const had = { ...board, title: 'Old', statuses: { ...board.statuses, ready: 'Mine' } }
    const r = withFound({ ...EMPTY, repos: ['globex/app'], boards: { 'globex/7': had } }, globex, () => false)
    expect(r.boards['globex/7']).toMatchObject({ title: 'Roadmap', statuses: { ready: 'Mine' } })
  })
})
