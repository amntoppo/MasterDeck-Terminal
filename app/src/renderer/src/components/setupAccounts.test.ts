import { describe, expect, it } from 'vitest'
import { parseConfig } from '@shared/appConfig'
import type { DetectAll, DetectedBoard } from '@shared/detect'
import { accountsFromSetup, boardTakenBy, codeReposToSave, markMade, selFromConfig, switchSel, takenBy, swapPrimaryWorkspace, withFound, workspacesFromConfig, type AccountSel } from './setupAccounts'

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
  it('each other account keeps its own workspace; the primary\'s is the config\'s', () => {
    const connected = [{ login: 'alice', name: 'A', email: '' }, { login: 'bob-work', name: 'B', email: '' }, { login: 'carol', name: 'C', email: '' }]
    const list = accountsFromSetup(connected, 'alice', sel, () => 'organization', { alice: '/code/ignored', 'bob-work': ' /code/globex ', carol: '  ' })
    expect(list.map((a) => a.workspace)).toEqual([undefined, '/code/globex', undefined])
    expect(list.map((a) => 'workspace' in a)).toEqual([false, true, false])
    // Read back from a saved config, and saved again unchanged.
    const saved = parseConfig({ accounts: list }).accounts
    expect(workspacesFromConfig(saved)).toEqual({ 'bob-work': '/code/globex' })
    expect(accountsFromSetup(connected, 'alice', sel, () => 'organization', workspacesFromConfig(saved)).map((a) => a.workspace)).toEqual([undefined, '/code/globex', undefined])
  })
  it('making another account the primary swaps the workspaces, it drops none', () => {
    // alice (primary) in /code/acme, bob-work in /code/globex: bob-work becomes the primary.
    expect(swapPrimaryWorkspace('/code/acme', { 'bob-work': '/code/globex' }, 'alice', 'bob-work')).toEqual({ workspace: '/code/globex', workspaces: { alice: '/code/acme' } })
    // The new primary had none of its own: both keep the one they used.
    expect(swapPrimaryWorkspace('/code/acme', { carol: '/code/initech' }, 'alice', 'bob-work')).toEqual({ workspace: '/code/acme', workspaces: { carol: '/code/initech' } })
    expect(swapPrimaryWorkspace('/code/acme', { 'bob-work': '  ' }, 'alice', 'bob-work')).toEqual({ workspace: '/code/acme', workspaces: {} })
    // The old primary was disconnected (null): nothing of it is kept.
    expect(swapPrimaryWorkspace('/code/acme', { 'bob-work': '/code/globex' }, null, 'bob-work')).toEqual({ workspace: '/code/globex', workspaces: {} })
    expect(swapPrimaryWorkspace('/code/acme', { 'bob-work': '/code/globex' }, 'alice', 'alice')).toEqual({ workspace: '/code/acme', workspaces: { 'bob-work': '/code/globex' } })
    // And back again.
    const there = swapPrimaryWorkspace('/code/acme', { 'bob-work': '/code/globex' }, 'alice', 'bob-work')
    expect(swapPrimaryWorkspace(there.workspace, there.workspaces, 'bob-work', 'alice')).toEqual({ workspace: '/code/acme', workspaces: { 'bob-work': '/code/globex' } })
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
    const r = withFound({ ...EMPTY, repos: ['globex/app'], primary: 'globex/app' }, globex, 'bob-work', {})
    expect(r.repos).toEqual(['globex/app'])
    expect(r.allRepos).toBe(false)
  })
  it('Select all takes every repo there is now, but not one under another account', () => {
    const r = withFound({ ...EMPTY, allRepos: true }, globex, 'bob-work', { alice: { ...EMPTY, repos: ['globex/web'] } })
    expect(r.repos).toEqual(['globex/app'])
  })
  it('a first pick starts from the repo with the most open issues and its only board', () => {
    const r = withFound(EMPTY, globex, 'bob-work', {})
    expect(r).toMatchObject({ repos: ['globex/web'], primary: 'globex/web' })
    expect(Object.keys(r.boards)).toEqual(['globex/7'])
  })
  it('chosen boards take GitHub’s title and keep their statuses', () => {
    const had = { ...board, title: 'Old', statuses: { ...board.statuses, ready: 'Mine' } }
    const r = withFound({ ...EMPTY, repos: ['globex/app'], boards: { 'globex/7': had } }, globex, 'bob-work', {})
    expect(r.boards['globex/7']).toMatchObject({ title: 'Roadmap', statuses: { ready: 'Mine' } })
  })
})

describe('a board belongs to one account', () => {
  it('a board ticked under another account is taken (case-insensitive)', () => {
    expect(boardTakenBy('GLOBEX/7', 'alice', sel)).toBe('bob-work')
    expect(boardTakenBy('globex/7', 'bob-work', sel)).toBeNull()
  })
  it('Select all and a first pick skip boards under another account', () => {
    const other = { alice: { ...EMPTY, boards: { 'globex/7': board } } }
    expect(withFound({ ...EMPTY, repos: ['globex/app'], allBoards: true }, globex, 'bob-work', other).boards).toEqual({})
    expect(withFound(EMPTY, globex, 'bob-work', other).boards).toEqual({})
  })
})

describe('Look again keeps what changed while it read', () => {
  it("the answer is applied to the screen's choices when it arrives", () => {
    // Started with nothing; meanwhile the user ticked globex/app and edited a board's statuses.
    const now: AccountSel = { ...EMPTY, repos: ['globex/app'], primary: 'globex/app', boards: { 'globex/7': { ...board, statuses: { ...board.statuses, ready: 'Mine' } } } }
    const r = withFound(now, globex, 'bob-work', {})
    expect(r.repos).toEqual(['globex/app'])
    expect(r.boards['globex/7'].statuses.ready).toBe('Mine')
  })
})

describe('a board MasterDeck created stays sprintless through Setup', () => {
  // As the config keeps it (boardEntry): no sprint field. GitHub's detection never says so.
  const made = { ...board, sprintField: '', sprintless: true as const }
  it('chosen boards keep the mark when GitHub answers', () => {
    const r = withFound({ ...EMPTY, repos: ['globex/app'], boards: { 'globex/7': made } }, globex, 'bob-work', {})
    expect(r.boards['globex/7']).toMatchObject({ title: 'Roadmap', sprintless: true })
    const all = withFound({ ...EMPTY, repos: ['globex/app'], boards: { 'globex/7': made }, allBoards: true }, globex, 'bob-work', {})
    expect(all.boards['globex/7'].sprintless).toBe(true)
    // What Save writes for the account.
    const list = accountsFromSetup([{ login: 'bob-work', name: 'Bob', email: 'b@globex.test' }], 'bob-work', { 'bob-work': r }, () => 'organization')
    expect(list[0].projects[0].sprintless).toBe(true)
  })
  it('a board that never had it does not get it', () => {
    const r = withFound({ ...EMPTY, repos: ['globex/app'], boards: { 'globex/7': board } }, globex, 'bob-work', {})
    expect('sprintless' in r.boards['globex/7']).toBe(false)
  })
  it('what GitHub lists is marked from the saved config, so unticking and ticking again keeps it', () => {
    const d = markMade(globex, [made])
    expect(d.owners[0].projects[0]).toMatchObject({ title: 'Roadmap', sprintless: true })
    expect(d.owners[0].repos).toBe(globex.owners[0].repos)
    // Unticked on screen, then Select all, or a first pick: the board comes from the list.
    expect(withFound({ ...EMPTY, repos: ['globex/app'], allBoards: true }, d, 'bob-work', {}).boards['globex/7'].sprintless).toBe(true)
    expect(withFound(EMPTY, d, 'bob-work', {}).boards['globex/7'].sprintless).toBe(true)
    // Nothing saved is marked: the answer as it came.
    expect(markMade(globex, [board])).toBe(globex)
    expect(markMade(globex, [])).toBe(globex)
  })
})

describe('a created board that got a sprint field on GitHub is no longer sprintless', () => {
  const made = { ...board, sprintField: '', sprintless: true as const }
  // GitHub now reports an iteration field on globex/7.
  const withSprints: DetectAll = { ...globex, owners: [{ ...globex.owners[0], projects: [det({ owner: 'globex', number: 7, title: 'Roadmap', sprintField: 'Sprint' })] }] }
  it('a chosen board loses the mark and takes the field', () => {
    const r = withFound({ ...EMPTY, repos: ['globex/app'], boards: { 'globex/7': made } }, withSprints, 'bob-work', {})
    expect(r.boards['globex/7'].sprintField).toBe('Sprint')
    expect('sprintless' in r.boards['globex/7']).toBe(false)
  })
  it('the detected list is not marked', () => {
    expect(markMade(withSprints, [made])).toBe(withSprints)
  })
  it('still marked while GitHub reports no sprint field', () => {
    const none: DetectAll = { ...globex, owners: [{ ...globex.owners[0], projects: [det({ owner: 'globex', number: 7, sprintField: '' })] }] }
    expect(markMade(none, [made]).owners[0].projects[0].sprintless).toBe(true)
    expect(withFound({ ...EMPTY, repos: ['globex/app'], boards: { 'globex/7': made } }, none, 'bob-work', {}).boards['globex/7'].sprintless).toBe(true)
  })
})

describe('codeReposToSave (issue #61)', () => {
  it('drops empty and self rows, keeps the rest', () => {
    expect(codeReposToSave([{ issues: 'acme/tracker', code: ' acme/api ' }, { issues: 'acme/x', code: '' }, { issues: 'acme/y', code: 'acme/y' }])).toEqual({
      ok: true, list: [{ issues: 'acme/tracker', code: 'acme/api' }],
    })
    expect(codeReposToSave([])).toEqual({ ok: true, list: [] })
  })
  it('says which row is wrong', () => {
    expect(codeReposToSave([{ issues: 'acme/tracker', code: 'api' }])).toEqual({ ok: false, message: 'Code lives in: api is not owner/name.' })
    expect(codeReposToSave([{ issues: 'acme/tracker', code: 'acme/api' }, { issues: 'Acme/Tracker', code: 'acme/web' }])).toEqual({
      ok: false, message: 'Code lives in: Acme/Tracker has two rows; keep one.',
    })
  })
})
