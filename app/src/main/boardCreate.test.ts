import { describe, expect, it } from 'vitest'
import { parseConfig, type AppConfig } from '@shared/appConfig'
import type { GhAccount } from '@shared/ghAuth'
import { BoardCreator, type CreatorDeps } from './boardCreate'
import type { GhRunner } from './ghc'
import type { RunResult } from './run'

type Vars = Record<string, string>
const account = (login: string, owner: string, repo: string, projects: unknown[], primary = false) => ({
  login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repo, repos: [`${owner}/${repo}`], projects, ...(primary ? { primary: true } : {}),
})
const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [account('alice', 'acme', 'tracker', [{ owner: 'acme', number: 1, title: 'Delivery' }], true), account('bob-work', 'globex', 'app', [])] })
const one = parseConfig({ owner: 'acme', issueRepo: 'tracker' })
const URL7 = 'https://github.com/orgs/globex/projects/7'
const LOGINS: GhAccount[] = [{ login: 'alice', active: true, ok: true, scopes: ['repo', 'project'] }, { login: 'bob-work', active: false, ok: true, scopes: ['repo', 'project'] }]

/** gh failing the way it does on a GraphQL error: exit 1, the answer on stdout, the message on stderr. */
const bad = (data: unknown, message: string, type?: string, alias?: string): RunResult => ({
  code: 1,
  stdout: JSON.stringify({ data, errors: [{ message, ...(type ? { type } : {}), ...(alias ? { path: [alias] } : {}) }] }),
  stderr: `gh: ${message}`,
})
const isRun = (v: unknown): v is RunResult => !!v && typeof v === 'object' && 'code' in v && 'stdout' in v

/** A gh that never runs: each call's GraphQL document and variables go to `answer`, whose plain result is the `data`. */
function fakeGh(answer: (doc: string, vars: Vars) => unknown) {
  const calls: { doc: string; vars: Vars }[] = []
  const gh: GhRunner = async (args) => {
    const vars: Vars = {}
    args.forEach((a, i) => {
      if (args[i - 1] === '-f') vars[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1)
    })
    const doc = vars.query ?? ''
    calls.push({ doc, vars })
    const a = answer(doc, vars)
    return isRun(a) ? a : { code: 0, stdout: JSON.stringify({ data: a }), stderr: '' }
  }
  return { gh, calls }
}

interface World {
  issues?: number
  addFail?: number[]
  rateAt?: number
  noStatus?: boolean
  statusReadFails?: boolean
  updateFails?: boolean
  createError?: string
  linkFails?: boolean
}
const FIELD = { id: 'F_1', options: [{ id: 'o-todo', name: 'Todo' }, { id: 'o-prog', name: 'In Dev' }, { id: 'o-new', name: 'PR Raised' }, { id: 'o-done', name: 'Done' }] }

/** GitHub, as far as a run can tell. `w` can be changed between calls. */
function github(w: World = {}) {
  let adds = 0
  return (doc: string, vars: Vars): unknown => {
    if (doc.includes('repositoryOwner('))
      return { repositoryOwner: { __typename: 'Organization', id: 'O_1', login: 'globex', projectsV2: { nodes: [{ number: 3, title: 'Roadmap', url: 'https://github.com/orgs/globex/projects/3', closed: false }] } }, r0: { id: 'R_1', nameWithOwner: 'globex/app', issues: { totalCount: w.issues ?? 2 } } }
    if (doc.includes('createProjectV2('))
      return w.createError ? bad({ createProjectV2: null }, w.createError, 'INSUFFICIENT_SCOPES', 'createProjectV2') : { createProjectV2: { projectV2: { id: 'PVT_1', number: 7, url: URL7, title: vars.t } } }
    if (doc.includes('field(name: "Status")')) {
      if (w.statusReadFails) return { code: 1, stdout: '', stderr: 'gh: connection timed out' }
      return { node: { field: w.noStatus ? null : { id: 'F_1', options: [{ id: 'o-todo', name: 'Todo' }, { id: 'o-prog', name: 'In Progress' }, { id: 'o-done', name: 'Done' }] } } }
    }
    if (doc.includes('updateProjectV2Field(')) return w.updateFails ? bad({ updateProjectV2Field: null }, 'Field cannot be changed') : { updateProjectV2Field: { projectV2Field: FIELD } }
    if (doc.includes('createProjectV2Field(')) return { createProjectV2Field: { projectV2Field: FIELD } }
    if (doc.includes('linkProjectV2ToRepository(')) return w.linkFails ? bad({ linkProjectV2ToRepository: null }, 'not allowed') : { linkProjectV2ToRepository: { repository: { nameWithOwner: 'globex/app' } } }
    if (doc.includes('issues(states: OPEN, first: 100')) {
      const n = w.issues ?? 2
      const from = vars.c ? Number(vars.c) : 0
      const nodes = Array.from({ length: Math.max(0, Math.min(100, n - from)) }, (_x, i) => ({ id: `I_${from + i + 1}`, number: from + i + 1 }))
      return { repository: { issues: { pageInfo: { hasNextPage: from + 100 < n, endCursor: String(from + 100) }, nodes } } }
    }
    if (doc.includes('addProjectV2ItemById(')) {
      adds++
      if (w.rateAt === adds) return bad(null, 'API rate limit exceeded', 'RATE_LIMITED')
      const ids = [...doc.matchAll(/contentId: "I_(\d+)"/g)].map((m) => Number(m[1]))
      const data = Object.fromEntries(ids.map((n, k) => [`a${k}`, w.addFail?.includes(n) ? null : { item: { id: `PVTI_${n}` } }]))
      return ids.some((n) => w.addFail?.includes(n)) ? bad(data, 'Could not resolve to a node', 'NOT_FOUND', 'a1') : data
    }
    if (doc.includes('updateProjectV2ItemFieldValue(')) {
      const n = [...doc.matchAll(/itemId: /g)].length
      return Object.fromEntries(Array.from({ length: n }, (_x, k) => [`s${k}`, { projectV2Item: { id: `PVTI_s${k}` } }]))
    }
    return { code: 1, stdout: '', stderr: 'unexpected call' }
  }
}

const KIND = /repositoryOwner\(|createProjectV2\(|field\(name: "Status"\)|updateProjectV2Field\(|createProjectV2Field\(|linkProjectV2ToRepository\(|issues\(states: OPEN, first: 100|addProjectV2ItemById\(|updateProjectV2ItemFieldValue\(/
const NAME: Record<string, string> = {
  'repositoryOwner(': 'plan', 'createProjectV2(': 'create', 'field(name: "Status")': 'field', 'updateProjectV2Field(': 'options', 'createProjectV2Field(': 'new-field',
  'linkProjectV2ToRepository(': 'link', 'issues(states: OPEN, first: 100': 'ids', 'addProjectV2ItemById(': 'add', 'updateProjectV2ItemFieldValue(': 'status',
}
const kinds = (calls: { doc: string }[]) => calls.map((c) => NAME[KIND.exec(c.doc)?.[0] ?? ''] ?? '?')

function make(cfg: AppConfig, answer: (doc: string, vars: Vars) => unknown, over: Partial<CreatorDeps> = {}) {
  const f = fakeGh(answer)
  const seen = { asked: [] as { message: string; lines: string[] }[], saved: [] as unknown[], used: [] as (string | null)[], refreshed: 0, progress: [] as string[] }
  const deps: CreatorDeps = {
    config: () => cfg,
    gh: (login) => (seen.used.push(login), f.gh),
    ghLogins: async () => LOGINS,
    confirm: async (message, lines) => (seen.asked.push({ message, lines }), true),
    save: async (patch) => (seen.saved.push(patch), { ok: true, message: 'saved' }),
    refresh: () => void seen.refreshed++,
    statusOf: (_repo, n) => (n === 2 ? 'In Dev' : 'Todo'),
    progress: (p) => void seen.progress.push(p.text),
    wait: async () => {},
    ...over,
  }
  return { creator: new BoardCreator(deps), calls: f.calls, seen }
}
const BOB = { account: 'bob-work', title: 'B' }

describe('plan', () => {
  it('reads what would be created, as the account', async () => {
    const t = make(two, github({ issues: 26 }))
    expect(await t.creator.plan('bob-work')).toEqual({
      ok: true, account: 'bob-work', owner: 'globex', ownerType: 'organization', ownerId: 'O_1', title: 'app board',
      repos: [{ repo: 'globex/app', id: 'R_1', open: 26 }], missing: [], skipped: [], total: 26,
      existing: [{ number: 3, title: 'Roadmap', url: 'https://github.com/orgs/globex/projects/3' }],
    })
    expect(t.calls.map((c) => c.vars.login)).toEqual(['globex'])
    expect(t.seen.used).toEqual(['bob-work'])
  })
  it('refuses an account that has a board, an unknown one, and one with nothing to read', async () => {
    const t = make(two, github())
    expect(await t.creator.plan('alice')).toEqual({ ok: false, message: 'this account already has a board selected' })
    expect(await t.creator.plan('mallory')).toEqual({ ok: false, message: 'not a connected GitHub account' })
    expect(await t.creator.plan(undefined)).toEqual({ ok: false, message: 'not a connected GitHub account' })
    expect(await make(parseConfig({}), github()).creator.plan(undefined)).toEqual({ ok: false, message: 'select its repositories in Setup first' })
    expect(t.calls).toEqual([])
  })
  it('one account: no login, the plain gh runner', async () => {
    const t = make(one, github())
    expect(await t.creator.plan('whatever')).toMatchObject({ ok: true, account: null, owner: 'acme', title: 'tracker board', repos: [{ repo: 'acme/tracker', id: 'R_1', open: 2 }] })
    expect(t.calls[0].vars.login).toBe('acme')
    expect(t.seen.used).toEqual([null])
  })
  it('a token without the project scope is stopped before any call', async () => {
    const logins: GhAccount[] = [LOGINS[0], { ...LOGINS[1], scopes: ['repo', 'read:project'] }]
    const t = make(two, github(), { ghLogins: async () => logins })
    const fix = ['gh auth switch -u bob-work', 'gh auth refresh -h github.com -s project', 'gh auth switch -u alice']
    expect(await t.creator.plan('bob-work')).toEqual({ ok: false, message: 'bob-work cannot manage project boards: its token lacks the project scope', fix })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: false, fix })
    expect(t.calls).toEqual([])
    expect(t.seen.asked).toEqual([])
  })
  it("an account's runner that cannot call says why", async () => {
    const t = make(two, () => ({ code: 1, stdout: '', stderr: 'GitHub account bob-work needs to log in again' }))
    expect(await t.creator.plan('bob-work')).toEqual({ ok: false, message: 'GitHub account bob-work needs to log in again' })
  })
})

describe('create', () => {
  it('creates the project, sets its columns, links, adds the issues with their columns, then selects the board', async () => {
    const t = make(two, github())
    const r = await t.creator.create({ account: 'bob-work', title: '  App   board ' }, false)
    expect(r).toEqual({ ok: true, url: URL7, title: 'App board', added: 2, total: 2, failed: [], left: 0, unset: 0, warnings: [], message: 'Added 2 issues to App board' })
    expect(kinds(t.calls)).toEqual(['plan', 'create', 'field', 'options', 'link', 'ids', 'add', 'status'])
    expect(t.calls[1].vars).toMatchObject({ o: 'O_1', t: 'App board' })
    expect(t.calls[3].vars.f).toBe('F_1')
    expect(t.calls[3].doc).toContain('{id: "o-prog", name: "In Dev", color: YELLOW, description: ""}')
    expect(t.calls[4].vars).toMatchObject({ p: 'PVT_1', r: 'R_1' })
    expect(t.calls[6].doc).toContain('contentId: "I_1"')
    expect(t.calls[7].vars).toMatchObject({ p: 'PVT_1', f: 'F_1' })
    expect(t.calls[7].doc).toContain('itemId: "PVTI_1", fieldId: $f, value: {singleSelectOptionId: "o-todo"}')
    expect(t.calls[7].doc).toContain('itemId: "PVTI_2", fieldId: $f, value: {singleSelectOptionId: "o-prog"}') // #2 is In Dev on the Board
    expect(t.seen.used.every((l) => l === 'bob-work')).toBe(true)
    expect(t.seen.asked).toEqual([{ message: 'Create a GitHub board as bob-work?', lines: ['A GitHub project "App board" under globex', 'Columns: Todo, In Dev, PR Raised, Done', 'Linked to 1 repository: globex/app', '2 open issues added to it', 'The board selected for bob-work in MasterDeck'] }])
    const saved = t.seen.saved[0] as { accounts: { login: string; projects: Record<string, unknown>[] }[] }
    expect(saved.accounts.map((a) => [a.login, a.projects.length])).toEqual([['alice', 1], ['bob-work', 1]])
    expect(saved.accounts[1].projects[0]).toMatchObject({ owner: 'globex', ownerType: 'organization', number: 7, id: 'PVT_1', title: 'App board', statusFieldId: 'F_1', statusOptions: { Todo: 'o-todo', 'In Dev': 'o-prog', 'PR Raised': 'o-new', Done: 'o-done' }, columns: ['Todo', 'In Dev', 'PR Raised', 'Done'], sprintless: true })
    expect(t.seen.refreshed).toBe(1)
    expect(t.seen.progress).toEqual(expect.arrayContaining(['Creating the project…', 'Adding issues 2 of 2…']))
  })
  it('one account: the plain runner, the board in the top-level list', async () => {
    const t = make(one, github())
    expect(await t.creator.create({ title: 'T' }, false)).toMatchObject({ ok: true, added: 2 })
    expect(t.seen.used.every((l) => l === null)).toBe(true)
    expect(t.seen.asked[0].message).toBe('Create a GitHub board?')
    expect(t.seen.saved).toEqual([{ projects: [expect.objectContaining({ owner: 'acme', number: 7, sprintless: true })] }])
  })
  it('nothing is written when the confirmation is declined', async () => {
    const t = make(two, github(), { confirm: async () => false })
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'cancelled' })
    expect(kinds(t.calls)).toEqual(['plan'])
    expect(t.seen.saved).toEqual([])
  })
  it('a board of that name is refused before anything is written', async () => {
    const t = make(two, github())
    expect(await t.creator.create({ account: 'bob-work', title: 'roadmap' }, false)).toEqual({ ok: false, url: 'https://github.com/orgs/globex/projects/3', message: 'globex already has a board named "Roadmap". Pick it in Setup → Repos & boards, or choose another name.' })
    expect(kinds(t.calls)).toEqual(['plan'])
    expect(t.seen.asked).toEqual([])
  })
  it('refuses a remote caller and a bad name without any call', async () => {
    const t = make(two, github())
    expect(await t.creator.create(BOB, true)).toEqual({ ok: false, message: 'Create the board from MasterDeck on your Mac' })
    expect(await t.creator.retry('bob-work', true)).toEqual({ ok: false, message: 'Create the board from MasterDeck on your Mac' })
    expect(await t.creator.create({ account: 'bob-work', title: '   ' }, false)).toEqual({ ok: false, message: 'give the board a name (up to 100 characters)' })
    expect(await t.creator.create(null, false)).toMatchObject({ ok: false })
    expect(t.calls).toEqual([])
  })
  it('one run at a time', async () => {
    let answer: (v: boolean) => void = () => {}
    const t = make(two, github(), { confirm: () => new Promise<boolean>((done) => (answer = done)) })
    const first = t.creator.create(BOB, false)
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'already creating a board' })
    await new Promise((r) => setTimeout(r, 0)) // let the first run reach its confirmation
    answer(false)
    expect(await first).toEqual({ ok: false, message: 'cancelled' })
    expect(await t.creator.create({ ...BOB, title: 'Roadmap' }, false)).toMatchObject({ ok: false, url: 'https://github.com/orgs/globex/projects/3' }) // free again
  })
  it("GitHub's own scope error carries the fix", async () => {
    const t = make(two, github({ createError: 'Your token has not been granted the required scopes to execute this query' }))
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'gh: Your token has not been granted the required scopes to execute this query', fix: ['gh auth switch -u bob-work', 'gh auth refresh -h github.com -s project', 'gh auth switch -u alice'] })
    expect(kinds(t.calls)).toEqual(['plan', 'create'])
    expect(t.seen.saved).toEqual([])
  })
  it('columns that cannot be set stop the run, with the project named', async () => {
    const t = make(two, github({ updateFails: true }))
    const r = await t.creator.create(BOB, false)
    expect(r).toMatchObject({ ok: false, url: URL7 })
    expect(r.message).toBe(`The board was created (${URL7}) but its columns could not be set: gh: Field cannot be changed. Delete it on GitHub, or pick it in Setup → Repos & boards.`)
    expect(kinds(t.calls)).toEqual(['plan', 'create', 'field', 'options'])
    expect(t.seen.saved).toEqual([])
  })
  it('a project without a Status field gets one; an unread field is not replaced by a second one', async () => {
    const made = make(two, github({ noStatus: true }))
    expect(await made.creator.create(BOB, false)).toMatchObject({ ok: true })
    expect(kinds(made.calls).slice(0, 4)).toEqual(['plan', 'create', 'field', 'new-field'])
    const unread = make(two, github({ statusReadFails: true }))
    expect(await unread.creator.create(BOB, false)).toMatchObject({ ok: false, url: URL7 })
    expect(kinds(unread.calls)).toEqual(['plan', 'create', 'field'])
  })
  it('a repository that cannot be linked is a warning', async () => {
    const t = make(two, github({ linkFails: true }))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 2, warnings: ['globex/app could not be linked to the board'] })
  })
  it('a refused issue is reported and can be retried', async () => {
    const w: World = { issues: 45, addFail: [22] }
    const t = make(two, github(w))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 44, total: 45, failed: ['app#22'], left: 0, message: 'Added 44 of 45 issues to B' })
    expect(kinds(t.calls).filter((k) => k === 'add')).toHaveLength(3) // 20 + 20 + 5
    expect(kinds(t.calls).filter((k) => k === 'status')).toHaveLength(3)
    expect(t.seen.saved).toHaveLength(1) // the board is selected all the same
    w.addFail = []
    const before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 1, total: 1, failed: [], message: 'Added 1 issue to B' })
    expect(kinds(t.calls.slice(before))).toEqual(['add', 'status'])
    expect(t.calls[before].doc).toContain('contentId: "I_22"')
    expect(t.seen.refreshed).toBe(2)
    expect(await t.creator.retry('bob-work', false)).toEqual({ ok: false, message: 'nothing left to add' })
    expect(t.seen.saved).toHaveLength(1)
  })
  it('a rate limit stops adding and keeps the rest for a retry', async () => {
    const w: World = { issues: 45, rateAt: 2 }
    const t = make(two, github(w))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 20, total: 45, failed: [], left: 25, message: 'Added 20 of 45 issues to B' })
    expect(kinds(t.calls).filter((k) => k === 'add')).toHaveLength(2) // it did not go on to the third batch
    expect(t.seen.saved).toHaveLength(1)
    w.rateAt = undefined
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 25, total: 25, left: 0 })
  })
  it('adds at most 1000 issues and says so', async () => {
    const t = make(two, github({ issues: 1005 }))
    const r = await t.creator.create(BOB, false)
    expect(r).toMatchObject({ ok: true, added: 1000, total: 1000, warnings: ['Only the first 1000 open issues were added'] })
    expect(kinds(t.calls).filter((k) => k === 'ids')).toHaveLength(10)
  })
  it('a config that cannot be saved leaves the board named', async () => {
    const t = make(two, github(), { save: async () => ({ ok: false, message: 'accounts must be a list' }) })
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, url: URL7, message: `The board was created (${URL7}) but MasterDeck could not select it: accounts must be a list. Pick it in Setup → Repos & boards.` })
    expect(t.seen.refreshed).toBe(0)
  })
})
