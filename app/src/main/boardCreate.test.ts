import { describe, expect, it } from 'vitest'
import { parseConfig, type AppConfig } from '@shared/appConfig'
import type { DerivedColumn } from '@shared/derivedBoard'
import type { GhAccount } from '@shared/ghAuth'
import type { Board, BoardCard } from '@shared/types'
import { accountGh, BoardCreator, columnsOf, type CreatorDeps } from './boardCreate'
import type { GhRunner } from './ghc'
import type { RunResult } from './run'

type Vars = Record<string, string>
const account = (login: string, owner: string, repo: string, projects: unknown[], primary = false, more: string[] = []) => ({
  login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repo, repos: [`${owner}/${repo}`, ...more], projects, ...(primary ? { primary: true } : {}),
})
const ALICE = account('alice', 'acme', 'tracker', [{ owner: 'acme', number: 1, title: 'Delivery' }], true)
const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [ALICE, account('bob-work', 'globex', 'app', [])] })
/** bob-work with a second repository. */
const wide = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [ALICE, account('bob-work', 'globex', 'app', [], false, ['globex/web'])] })
/** bob-work picked a board meanwhile. */
const boarded = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [ALICE, account('bob-work', 'globex', 'app', [{ owner: 'globex', number: 3, title: 'Roadmap' }])] })
/** bob-work was disconnected, carol connected. */
const swapped = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [ALICE, account('carol', 'initech', 'app', [])] })
const one = parseConfig({ owner: 'acme', issueRepo: 'tracker' })
const URL7 = 'https://github.com/orgs/globex/projects/7'
const ROADMAP = { number: 3, title: 'Roadmap', url: 'https://github.com/orgs/globex/projects/3', closed: false }
const LOGINS: GhAccount[] = [{ login: 'alice', active: true, ok: true, scopes: ['repo', 'project'] }, { login: 'bob-work', active: false, ok: true, scopes: ['repo', 'project'] }]
const TIMEOUT: RunResult = { code: 1, stdout: '', stderr: 'gh: connection timed out' }
const MAYBE = " The board may have been created all the same: check globex's projects on GitHub before trying again."

/** gh failing the way it does on a GraphQL error: exit 1, the answer on stdout, the message on stderr. */
const bad = (data: unknown, message: string, type?: string, alias?: string): RunResult => ({
  code: 1,
  stdout: JSON.stringify({ data, errors: [{ message, ...(type ? { type } : {}), ...(alias ? { path: [alias] } : {}) }] }),
  stderr: `gh: ${message}`,
})
const isRun = (v: unknown): v is RunResult => !!v && typeof v === 'object' && 'code' in v && 'stdout' in v

/** A gh that never runs: each call's GraphQL document and variables go to `answer`, whose plain result is the `data`. */
function fakeGh(answer: (doc: string, vars: Vars) => unknown) {
  const calls: { doc: string; vars: Vars; args: string[] }[] = []
  const gh: GhRunner = async (args) => {
    const vars: Vars = {}
    args.forEach((a, i) => {
      if (args[i - 1] === '-f') vars[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1)
    })
    const doc = vars.query ?? ''
    calls.push({ doc, vars, args })
    const a = answer(doc, vars)
    return isRun(a) ? a : { code: 0, stdout: JSON.stringify({ data: a }), stderr: '' }
  }
  return { gh, calls }
}

interface World {
  /** Open issues per repository name, else `issues`, else 2. */
  count?: Record<string, number>
  issues?: number
  /** The open-issue count the plan gives (null: GitHub leaves it out). */
  planCount?: number | null
  boards?: unknown[] | null
  moreBoards?: boolean
  ownerId?: string
  addFail?: number[]
  rateAt?: number
  addThrows?: boolean
  noStatus?: boolean
  statusReadFails?: boolean
  updateFails?: boolean
  createError?: string
  createAnswer?: RunResult
  createThrows?: boolean
  noUrl?: boolean
  linkFails?: boolean
  /** Repository names whose issue read fails; `idsFailFrom`: only from that cursor on; `idsNull`: GitHub answers `repository: null`. */
  idsFail?: string[]
  idsFailFrom?: number
  idsNull?: string[]
  idsRate?: string[]
  /** The nth status request fails outright (no data); `statusRateAt`: with a rate limit. */
  statusFailAt?: number
  statusRateAt?: number
  /** Positions in a status request GitHub refuses (the request itself answers). */
  statusItemFail?: number[]
}
const FIELD = { id: 'F_1', options: [{ id: 'o-todo', name: 'Todo' }, { id: 'o-prog', name: 'In Dev' }, { id: 'o-new', name: 'PR Raised' }, { id: 'o-done', name: 'Done' }] }

/** GitHub, as far as a run can tell. `w` can be changed between calls. Issue ids: I_<n> in `app`, I_<repo>_<n> elsewhere. */
function github(w: World = {}) {
  let adds = 0
  let statuses = 0
  const open = (name: string) => w.count?.[name] ?? w.issues ?? 2
  return (doc: string, vars: Vars): unknown => {
    if (doc.includes('repositoryOwner(')) {
      const repos = [...doc.matchAll(/r(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)]
      return {
        repositoryOwner: { __typename: 'Organization', id: w.ownerId ?? 'O_1', login: 'globex', projectsV2: w.boards === null ? null : { pageInfo: { hasNextPage: w.moreBoards === true }, nodes: w.boards ?? [ROADMAP] } },
        ...Object.fromEntries(repos.map((m) => [`r${m[1]}`, { id: `R_${Number(m[1]) + 1}`, nameWithOwner: `${m[2]}/${m[3]}`, issues: w.planCount === null ? null : { totalCount: w.planCount ?? open(m[3]) } }])),
      }
    }
    if (doc.includes('createProjectV2(')) {
      if (w.createThrows) throw new Error('spawn gh ENOENT')
      if (w.createAnswer) return w.createAnswer
      return w.createError
        ? bad({ createProjectV2: null }, w.createError, 'INSUFFICIENT_SCOPES', 'createProjectV2')
        : { createProjectV2: { projectV2: { id: 'PVT_1', number: 7, ...(w.noUrl ? {} : { url: URL7 }), title: vars.t } } }
    }
    if (doc.includes('field(name: "Status")')) {
      if (w.statusReadFails) return TIMEOUT
      return { node: { field: w.noStatus ? null : { id: 'F_1', options: [{ id: 'o-todo', name: 'Todo' }, { id: 'o-prog', name: 'In Progress' }, { id: 'o-done', name: 'Done' }] } } }
    }
    if (doc.includes('updateProjectV2Field(')) return w.updateFails ? bad({ updateProjectV2Field: null }, 'Field cannot be changed') : { updateProjectV2Field: { projectV2Field: FIELD } }
    if (doc.includes('createProjectV2Field(')) return { createProjectV2Field: { projectV2Field: FIELD } }
    if (doc.includes('linkProjectV2ToRepository(')) return w.linkFails ? bad({ linkProjectV2ToRepository: null }, 'not allowed') : { linkProjectV2ToRepository: { repository: { nameWithOwner: 'globex/app' } } }
    if (doc.includes('issues(states: OPEN, first: 100')) {
      const name = /name: "([^"]+)"/.exec(doc)?.[1] ?? ''
      const from = vars.c ? Number(vars.c) : 0
      if (w.idsRate?.includes(name)) return bad(null, 'API rate limit exceeded', 'RATE_LIMITED')
      if (w.idsFail?.includes(name) && from >= (w.idsFailFrom ?? 0)) return TIMEOUT
      if (w.idsNull?.includes(name)) return bad({ repository: null }, 'Could not resolve to a Repository', 'NOT_FOUND', 'repository')
      const n = open(name)
      const tag = name === 'app' ? '' : `${name}_`
      const nodes = Array.from({ length: Math.max(0, Math.min(100, n - from)) }, (_x, i) => ({ id: `I_${tag}${from + i + 1}`, number: from + i + 1 }))
      return { repository: { issues: { pageInfo: { hasNextPage: from + 100 < n, endCursor: String(from + 100) }, nodes } } }
    }
    if (doc.includes('addProjectV2ItemById(')) {
      adds++
      if (w.addThrows) throw new Error('spawn gh EAGAIN')
      if (w.rateAt === adds) return bad(null, 'API rate limit exceeded', 'RATE_LIMITED')
      const ids = [...doc.matchAll(/contentId: "I_([a-z_]*?)(\d+)"/g)].map((m) => ({ key: `${m[1]}${m[2]}`, n: Number(m[2]) }))
      const data = Object.fromEntries(ids.map((x, k) => [`a${k}`, w.addFail?.includes(x.n) ? null : { item: { id: `PVTI_${x.key}` } }]))
      return ids.some((x) => w.addFail?.includes(x.n)) ? bad(data, 'Could not resolve to a node', 'NOT_FOUND', 'a1') : data
    }
    if (doc.includes('updateProjectV2ItemFieldValue(')) {
      statuses++
      if (w.statusFailAt === statuses) return TIMEOUT
      if (w.statusRateAt === statuses) return bad(null, 'API rate limit exceeded', 'RATE_LIMITED')
      const n = [...doc.matchAll(/itemId: /g)].length
      const data = Object.fromEntries(Array.from({ length: n }, (_x, k) => [`s${k}`, w.statusItemFail?.includes(k) ? null : { projectV2Item: { id: `PVTI_s${k}` } }]))
      return w.statusItemFail?.length ? bad(data, 'The single select option Id does not belong to the field', 'NOT_FOUND', `s${w.statusItemFail[0]}`) : data
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
const count = (calls: { doc: string }[], kind: string) => kinds(calls).filter((k) => k === kind).length
/** What a run does before it writes: the plan, then the plan again once the confirmation is answered. */
const CHECKS = ['plan', 'plan']

function make(cfg: AppConfig | (() => AppConfig), answer: (doc: string, vars: Vars) => unknown, over: Partial<CreatorDeps> = {}) {
  const f = fakeGh(answer)
  const seen = { asked: [] as { message: string; lines: string[] }[], saved: [] as unknown[], used: [] as (string | null)[], refreshed: 0, progress: [] as string[], snapshots: 0 }
  const deps: CreatorDeps = {
    config: typeof cfg === 'function' ? cfg : () => cfg,
    gh: (login) => (seen.used.push(login), f.gh),
    ghLogins: async () => LOGINS,
    confirm: async (message, lines) => (seen.asked.push({ message, lines }), true),
    save: async (patch) => (seen.saved.push(patch), { ok: true, message: 'saved' }),
    refresh: () => void seen.refreshed++,
    columns: () => (seen.snapshots++, (_repo, n) => (n === 2 ? 'In Dev' : 'Todo')),
    // (the account is passed; these tests have one Board)
    progress: (p) => void seen.progress.push(p.text),
    wait: async () => {},
    ...over,
  }
  return { creator: new BoardCreator(deps), calls: f.calls, seen }
}
const BOB = { account: 'bob-work', title: 'B' }
const DUP = { ok: false, url: ROADMAP.url, message: 'globex already has a board named "Roadmap". Pick it in Setup → Repos & boards, or choose another name.' }

describe('plan', () => {
  it('reads what would be created, as the account', async () => {
    const t = make(two, github({ issues: 26 }))
    expect(await t.creator.plan('bob-work')).toEqual({
      ok: true, account: 'bob-work', owner: 'globex', ownerType: 'organization', ownerId: 'O_1', title: 'app board',
      repos: [{ repo: 'globex/app', id: 'R_1', open: 26 }], missing: [], skipped: [], total: 26, moreBoards: false,
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
  it('a login in another case is the connected account, in the spelling of the config', async () => {
    const t = make(two, github())
    expect(await t.creator.plan('Bob-Work')).toMatchObject({ ok: true, account: 'bob-work' })
    expect(t.seen.used).toEqual(['bob-work'])
  })
  it('a token without the project scope is stopped before any call', async () => {
    const logins: GhAccount[] = [LOGINS[0], { ...LOGINS[1], scopes: ['repo', 'read:project'] }]
    const t = make(two, github(), { ghLogins: async () => logins })
    const fix = ['gh auth switch -h github.com -u bob-work', 'gh auth refresh -h github.com -s project', 'gh auth switch -h github.com -u alice']
    expect(await t.creator.plan('bob-work')).toEqual({ ok: false, message: 'bob-work cannot manage project boards: its token lacks the project scope', fix })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: false, fix })
    expect(t.calls).toEqual([])
    expect(t.seen.asked).toEqual([])
  })
  it("an account's runner that cannot call says why", async () => {
    const t = make(two, () => ({ code: 1, stdout: '', stderr: 'GitHub account bob-work needs to log in again' }))
    expect(await t.creator.plan('bob-work')).toEqual({ ok: false, message: 'GitHub account bob-work needs to log in again' })
  })
  it('a failure that is not gh speaking shows a fixed text, never the raw output', async () => {
    const html = make(two, () => ({ code: 1, stdout: '<html>502 Bad Gateway token=abc</html>', stderr: '' }))
    expect(await html.creator.plan('bob-work')).toEqual({ ok: false, message: 'GitHub did not answer (gh exited 1)' })
    // Exit 0 with nothing usable is a failure too, not an owner GitHub does not know.
    const empty = make(two, () => ({ code: 0, stdout: 'null', stderr: '' }))
    expect(await empty.creator.plan('bob-work')).toEqual({ ok: false, message: 'GitHub did not answer (gh exited 0)' })
  })
  it('boards GitHub did not list stop the plan: a name could not be checked', async () => {
    const t = make(two, github({ boards: null }))
    expect(await t.creator.plan('bob-work')).toEqual({ ok: false, message: "GitHub did not list globex's boards, so a board of the same name cannot be ruled out" })
    const owner = { __typename: 'Organization', id: 'O_1', login: 'globex', projectsV2: null }
    const scoped = make(two, () => bad({ repositoryOwner: owner, r0: { id: 'R_1', issues: { totalCount: 2 } } }, "Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']", 'INSUFFICIENT_SCOPES', 'repositoryOwner'))
    const r = await scoped.creator.plan('bob-work')
    expect(r).toMatchObject({ ok: false, fix: ['gh auth switch -h github.com -u bob-work', 'gh auth refresh -h github.com -s project', 'gh auth switch -h github.com -u alice'] })
    expect(r.ok ? '' : r.message).toMatch(/^GitHub did not list globex's boards \(Your token has not been granted the required scopes/)
    expect(await scoped.creator.create(BOB, false)).toMatchObject({ ok: false })
    expect(scoped.seen.asked).toEqual([])
  })
  it('a count GitHub left out is unknown, and the confirmation says so', async () => {
    const t = make(two, github({ planCount: null }))
    expect(await t.creator.plan('bob-work')).toMatchObject({ ok: true, repos: [{ repo: 'globex/app', id: 'R_1', open: null }], total: 0 })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 2 })
    expect(t.seen.asked[0].lines[3]).toBe('An unknown number of open issues added to it (1000 at most)')
  })
})

describe('create', () => {
  it('creates the project, sets its columns, links, adds the issues with their columns, then selects the board', async () => {
    const t = make(two, github())
    const r = await t.creator.create({ account: 'bob-work', title: '  App   board ' }, false)
    expect(r).toEqual({ ok: true, url: URL7, title: 'App board', added: 2, total: 2, failed: [], left: 0, unset: 0, unread: [], warnings: [], message: 'Added 2 issues to App board' })
    expect(kinds(t.calls)).toEqual([...CHECKS, 'create', 'field', 'options', 'link', 'ids', 'add', 'status'])
    const c = t.calls.slice(1)
    expect(c[1].vars).toMatchObject({ o: 'O_1', t: 'App board' })
    expect(c[3].vars.f).toBe('F_1')
    expect(c[3].doc).toContain('{id: "o-prog", name: "In Dev", color: YELLOW, description: ""}')
    expect(c[4].vars).toMatchObject({ p: 'PVT_1', r: 'R_1' })
    expect(c[6].doc).toContain('contentId: "I_1"')
    expect(c[7].vars).toMatchObject({ p: 'PVT_1', f: 'F_1' })
    expect(c[7].doc).toContain('itemId: "PVTI_1", fieldId: $f, value: {singleSelectOptionId: "o-todo"}')
    expect(c[7].doc).toContain('itemId: "PVTI_2", fieldId: $f, value: {singleSelectOptionId: "o-prog"}') // #2 is In Dev on the Board
    expect(t.seen.used.every((l) => l === 'bob-work')).toBe(true)
    expect(t.seen.asked).toEqual([{ message: 'Create a GitHub board as bob-work?', lines: ['A GitHub project "App board" under globex', 'Columns: Todo, In Dev, PR Raised, Done', 'Linked to 1 repository: globex/app', '2 open issues added to it', 'The board selected for bob-work in MasterDeck'] }])
    const saved = t.seen.saved[0] as { accounts: { login: string; projects: Record<string, unknown>[] }[] }
    expect(saved.accounts.map((a) => [a.login, a.projects.length])).toEqual([['alice', 1], ['bob-work', 1]])
    expect(saved.accounts[1].projects[0]).toMatchObject({ owner: 'globex', ownerType: 'organization', number: 7, id: 'PVT_1', title: 'App board', statusFieldId: 'F_1', statusOptions: { Todo: 'o-todo', 'In Dev': 'o-prog', 'PR Raised': 'o-new', Done: 'o-done' }, columns: ['Todo', 'In Dev', 'PR Raised', 'Done'], sprintless: true })
    expect(t.seen.refreshed).toBe(1)
    expect(t.seen.progress).toEqual(expect.arrayContaining(['Creating the project…', 'Adding issues 2 of 2…']))
  })
  it('every variable goes to gh as a raw string (-f), never a typed one (-F reads @files and turns "123" into a number)', async () => {
    const t = make(two, github({ issues: 120 }))
    await t.creator.create({ account: 'bob-work', title: '@/etc/passwd' }, false)
    expect(t.calls.length).toBeGreaterThan(8)
    for (const c of t.calls) {
      expect(c.args.slice(0, 2)).toEqual(['api', 'graphql'])
      const rest = c.args.slice(2)
      expect(rest.length % 2).toBe(0)
      rest.forEach((a, i) => (i % 2 === 0 ? expect(a).toBe('-f') : expect(a).toMatch(/^[a-z]+=/)))
      expect(c.args.some((a) => a.startsWith('-F') || a.startsWith('--field'))).toBe(false)
    }
    expect(t.calls[2].args).toContain('t=@/etc/passwd')
    expect(t.calls.filter((c) => c.vars.c !== undefined).map((c) => c.vars.c)).toEqual(['100']) // the cursor, as text
  })
  it("one account: the plain runner, the board in the top-level list, the confirmation names gh's active login", async () => {
    const t = make(one, github())
    expect(await t.creator.create({ title: 'T' }, false)).toMatchObject({ ok: true, added: 2 })
    expect(t.seen.used.every((l) => l === null)).toBe(true)
    expect(t.seen.asked[0].message).toBe('Create a GitHub board as alice?')
    expect(t.seen.saved).toEqual([{ projects: [expect.objectContaining({ owner: 'acme', number: 7, sprintless: true })] }])
    // gh names no active login: no name to give.
    const quiet = make(one, github(), { ghLogins: async () => [] })
    await quiet.creator.create({ title: 'T' }, false)
    expect(quiet.seen.asked[0].message).toBe('Create a GitHub board?')
  })
  it('nothing is written when the confirmation is declined', async () => {
    const t = make(two, github(), { confirm: async () => false })
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'cancelled' })
    expect(kinds(t.calls)).toEqual(['plan'])
    expect(t.seen.saved).toEqual([])
  })
  it('a board of that name is refused before anything is written', async () => {
    const t = make(two, github())
    expect(await t.creator.create({ account: 'bob-work', title: 'roadmap' }, false)).toEqual(DUP)
    expect(kinds(t.calls)).toEqual(['plan'])
    expect(t.seen.asked).toEqual([])
  })
  it('refuses a remote caller and a bad name without any call', async () => {
    const t = make(two, github())
    expect(await t.creator.create(BOB, true)).toEqual({ ok: false, message: 'Create the board from MasterDeck on your Mac' })
    expect(await t.creator.retry('bob-work', true)).toEqual({ ok: false, message: 'Create the board from MasterDeck on your Mac' })
    expect(await t.creator.create({ account: 'bob-work', title: '   ' }, false)).toEqual({ ok: false, message: 'give the board a name (up to 100 characters)' })
    expect(await t.creator.create({ account: 'bob-work', title: 'B‮draob' }, false)).toMatchObject({ ok: false })
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
    // GitHub refused: nothing exists, so no "it may have been created".
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'gh: Your token has not been granted the required scopes to execute this query', fix: ['gh auth switch -h github.com -u bob-work', 'gh auth refresh -h github.com -s project', 'gh auth switch -h github.com -u alice'] })
    expect(kinds(t.calls)).toEqual([...CHECKS, 'create'])
    expect(t.seen.saved).toEqual([])
  })
  it('columns that cannot be set stop the run, with the project named', async () => {
    const t = make(two, github({ updateFails: true }))
    const r = await t.creator.create(BOB, false)
    expect(r).toMatchObject({ ok: false, url: URL7 })
    expect(r.message).toBe(`The board was created (${URL7}) but its columns could not be set: gh: Field cannot be changed. Delete it on GitHub, or pick it in Setup → Repos & boards.`)
    expect(kinds(t.calls)).toEqual([...CHECKS, 'create', 'field', 'options'])
    expect(t.seen.saved).toEqual([])
  })
  it('a project without a Status field gets one; an unread field is not replaced by a second one', async () => {
    const made = make(two, github({ noStatus: true }))
    expect(await made.creator.create(BOB, false)).toMatchObject({ ok: true })
    expect(kinds(made.calls).slice(0, 5)).toEqual([...CHECKS, 'create', 'field', 'new-field'])
    const unread = make(two, github({ statusReadFails: true }))
    expect(await unread.creator.create(BOB, false)).toMatchObject({ ok: false, url: URL7 })
    expect(kinds(unread.calls)).toEqual([...CHECKS, 'create', 'field'])
  })
  it('a repository that cannot be linked is a warning', async () => {
    const t = make(two, github({ linkFails: true }))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 2, warnings: ['globex/app could not be linked to the board'] })
  })
  it('a refused issue is reported and can be retried', async () => {
    const w: World = { issues: 45, addFail: [22] }
    const t = make(two, github(w))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 44, total: 45, failed: ['app#22'], left: 0, message: 'Added 44 of 45 issues to B' })
    expect(count(t.calls, 'add')).toBe(3) // 20 + 20 + 5
    expect(count(t.calls, 'status')).toBe(3)
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
    expect(count(t.calls, 'add')).toBe(2) // it did not go on to the third batch
    expect(t.seen.saved).toHaveLength(1)
    w.rateAt = undefined
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 25, total: 25, left: 0 })
  })
  it('adds at most 1000 issues and says so', async () => {
    const t = make(two, github({ issues: 1005 }))
    const r = await t.creator.create(BOB, false)
    expect(r).toMatchObject({ ok: true, added: 1000, total: 1000, warnings: ['Only the first 1000 open issues were added'] })
    expect(count(t.calls, 'ids')).toBe(10)
  })
  it('exactly 1000 issues is everything: no word about a limit', async () => {
    const t = make(two, github({ issues: 1000 }))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 1000, total: 1000, warnings: [], unread: [] })
    // The limit is reached in the first repository and the second still has issues: that is a cut.
    const cut = make(wide, github({ count: { app: 1000, web: 3 } }))
    expect(await cut.creator.create(BOB, false)).toMatchObject({ ok: true, added: 1000, warnings: ['Only the first 1000 open issues were added'], unread: [] })
    expect(count(cut.calls, 'ids')).toBe(10) // web is not read: nothing of it would fit
    const fits = make(wide, github({ count: { app: 1000, web: 0 } }))
    expect(await fits.creator.create(BOB, false)).toMatchObject({ ok: true, added: 1000, warnings: [] })
  })
})

describe('the columns come from the Board, read before anything is written', () => {
  it('no Board loaded for the account: refused, nothing is created', async () => {
    const asked: (string | null)[] = []
    const t = make(two, github(), { columns: (login) => (asked.push(login), null) })
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'Open the Board tab and wait for it to load, then try again. Nothing was created.' })
    expect(kinds(t.calls)).toEqual(CHECKS)
    expect(asked).toEqual(['bob-work'])
    expect(t.seen.saved).toEqual([])
  })
  it('the snapshot is taken after the confirmation and before the project is made', async () => {
    const at: string[][] = []
    const t = make(two, github(), { columns: () => (at.push(kinds(t.calls)), () => 'Todo') })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true })
    expect(at).toEqual([CHECKS])
    expect(t.seen.asked).toHaveLength(1)
  })
  it('columnsOf: the derived cards of the account, or null when its issues were not read', () => {
    const card = (repo: string, number: number, status: string, derived = true): BoardCard => ({ repo, number, status, derived }) as unknown as BoardCard
    const board = (derived: Board['derived'], cards: BoardCard[]): Board => ({ takenAt: null, sprint: null, columns: [], cards, derived })
    const b = board([{ account: 'bob-work', repos: ['globex/app'], total: 2, shown: 2, skipped: [], missing: [] }], [card('globex/app', 1, 'PR Raised'), card('globex/app', 2, 'In Dev'), card('globex/app', 3, 'Blocked'), card('acme/tracker', 1, 'In Dev', false)])
    const of = columnsOf(b, 'bob-work')!
    expect([of('globex/app', 1), of('Globex/App', 2), of('globex/app', 3), of('globex/app', 9), of('acme/tracker', 1)]).toEqual(['PR Raised', 'In Dev', 'Todo', 'Todo', 'Todo'])
    expect(columnsOf(null, 'bob-work')).toBeNull() // nothing loaded yet
    expect(columnsOf(b, 'alice')).toBeNull() // alice's issues are not what was read
    expect(columnsOf(board(undefined, []), null)).toBeNull() // the last read failed, or is from before
    // One account: its part has no login. No open issue is still a loaded Board.
    expect(columnsOf(board([{ account: null, repos: ['acme/tracker'], total: 0, shown: 0, skipped: [], missing: [] }], []), null)!('acme/tracker', 1)).toBe('Todo')
  })
})

describe('Try again', () => {
  it("one account: refused when gh's active login is no longer the one that confirmed", async () => {
    let active = 'alice'
    const logins = async (): Promise<GhAccount[]> => LOGINS.map((x) => ({ ...x, active: x.login === active }))
    const w: World = { issues: 45, rateAt: 2 }
    const t = make(one, github(w), { ghLogins: logins })
    expect(await t.creator.create({ title: 'T' }, false)).toMatchObject({ ok: true, added: 20, left: 25 })
    w.rateAt = undefined
    const sent = t.calls.length
    active = 'bob-work'
    expect(await t.creator.retry(undefined, false)).toEqual({ ok: false, url: URL7, retry: true, message: "gh's active account changed to bob-work; nothing was added. Switch gh back to alice (gh auth switch --user alice), then try again." })
    active = ''
    expect(await t.creator.retry(undefined, false)).toMatchObject({ ok: false, retry: true, message: "gh's active account changed; nothing was added. Switch gh back to alice (gh auth switch --user alice), then try again." })
    expect(t.calls.length).toBe(sent) // nothing was sent as the other login
    // Back to the login that confirmed: the rest is added.
    active = 'alice'
    expect(await t.creator.retry(undefined, false)).toMatchObject({ ok: true, added: 25, left: 0 })
    // Two or more accounts: each call carries the account's own token; gh's active login plays no part.
    const w2: World = { issues: 45, rateAt: 2 }
    const multi = make(two, github(w2), { ghLogins: logins })
    expect(await multi.creator.create(BOB, false)).toMatchObject({ ok: true, added: 20, left: 25 })
    w2.rateAt = undefined
    active = 'bob-work'
    expect(await multi.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 25 })
  })
  it('keeps the column each issue had when the board was made', async () => {
    const w: World = { issues: 45, addFail: [22, 23] }
    let board: (n: number) => DerivedColumn = (n) => (n === 22 ? 'PR Raised' : n === 23 ? 'In Dev' : 'Todo')
    let snapshots = 0
    const t = make(two, github(w), { columns: () => (snapshots++, (_r, n) => board(n)) })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 43, failed: ['app#22', 'app#23'] })
    // The board is selected now: the tab shows the new board, where these issues are not, so the Board has no column for them.
    board = () => 'Todo'
    w.addFail = []
    const before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 2 })
    const status = t.calls.slice(before)[1].doc
    expect(status).toContain('itemId: "PVTI_22", fieldId: $f, value: {singleSelectOptionId: "o-new"}')
    expect(status).toContain('itemId: "PVTI_23", fieldId: $f, value: {singleSelectOptionId: "o-prog"}')
    expect(snapshots).toBe(1) // one look at the Board, when the board was made
  })
  it('a repository whose issues cannot be read is named, and Try again reads it', async () => {
    const w: World = { count: { app: 2, web: 3 }, idsFail: ['web'] }
    // What the Board shows when the board is made; after that the tab shows the new board.
    const shown = new Map([['globex/web#1', 'PR Raised' as DerivedColumn]])
    const t = make(wide, github(w), {
      columns: () => {
        const then = new Map(shown)
        return (repo, n) => then.get(`${repo}#${n}`) ?? 'Todo'
      },
    })
    const r = await t.creator.create(BOB, false)
    expect(r).toEqual({
      ok: true, url: URL7, title: 'B', added: 2, total: 2, failed: [], left: 0, unset: 0, unread: ['globex/web'],
      warnings: ['Could not read the open issues of globex/web: 2 of 5 added'], message: 'Added 2 of 5 issues to B',
    })
    expect(t.seen.asked[0].lines[3]).toBe('5 open issues added to it')
    shown.clear()
    // Still unreadable: still not a clean success, still retryable.
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 0, total: 0, unread: ['globex/web'], warnings: ['Could not read the open issues of globex/web: 2 of 5 added'], message: 'Added 0 of 3 issues to B' })
    w.idsFail = []
    const before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toEqual({ ok: true, url: URL7, title: 'B', added: 3, total: 3, failed: [], left: 0, unset: 0, unread: [], warnings: [], message: 'Added 3 issues to B' })
    const again = t.calls.slice(before)
    expect(kinds(again)).toEqual(['ids', 'add', 'status'])
    expect(again[0].doc).toContain('name: "web"')
    expect(again[1].doc).not.toContain('contentId: "I_1"') // app's issues are on the board already
    expect(again[2].doc).toContain('itemId: "PVTI_web_1", fieldId: $f, value: {singleSelectOptionId: "o-new"}') // its column when the board was made
    expect(await t.creator.retry('bob-work', false)).toEqual({ ok: false, message: 'nothing left to add' })
  })
  it('a page that fails half-way, a repository GitHub answers null for and a rate limit all count as unread', async () => {
    const w: World = { issues: 150, idsFail: ['app'], idsFailFrom: 100 }
    const t = make(two, github(w))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 100, total: 100, unread: ['globex/app'], warnings: ['Could not read the open issues of globex/app: 100 of 150 added'], message: 'Added 100 of 150 issues to B' })
    w.idsFail = []
    const before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 50, total: 50, unread: [], warnings: [] })
    const adds = t.calls.slice(before).filter((c) => c.doc.includes('addProjectV2ItemById('))
    expect(adds).toHaveLength(3)
    expect(adds[0].doc).toContain('contentId: "I_101"')
    expect(adds.some((c) => c.doc.includes('contentId: "I_100"'))).toBe(false) // only what is not there yet

    const gone = make(two, github({ idsNull: ['app'] }))
    expect(await gone.creator.create(BOB, false)).toMatchObject({ ok: true, added: 0, unread: ['globex/app'], warnings: ['Could not read the open issues of globex/app: 0 of 2 added'] })
    // A rate limit: the next repository is not asked either.
    const limited = make(wide, github({ idsRate: ['app'] }))
    expect(await limited.creator.create(BOB, false)).toMatchObject({ ok: true, added: 0, unread: ['globex/app', 'globex/web'] })
    expect(count(limited.calls, 'ids')).toBe(1)
  })
  it('a status request that fails stops the run; Try again adds those issues again and sets their Status', async () => {
    for (const how of ['statusFailAt', 'statusRateAt'] as const) {
      const w: World = { issues: 45, [how]: 2 }
      const t = make(two, github(w))
      expect(await t.creator.create(BOB, false), how).toMatchObject({ ok: true, added: 20, total: 45, failed: [], left: 25, unset: 0, message: 'Added 20 of 45 issues to B' })
      expect(count(t.calls, 'add')).toBe(2) // no third batch
      expect(count(t.calls, 'status')).toBe(2)
      // What the retry meets is a fresh GitHub: its first status request answers.
      w[how] = undefined
      const before = t.calls.length
      expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 25, total: 25, left: 0, unset: 0 })
      const again = t.calls.slice(before)
      expect(kinds(again)).toEqual(['add', 'status', 'add', 'status'])
      expect(again[0].doc).toContain('contentId: "I_21"')
      expect(again[1].doc).toContain('itemId: "PVTI_22", fieldId: $f, value: {singleSelectOptionId: "o-todo"}')
    }
  })
  it('an item whose Status GitHub refuses is counted, and the run goes on', async () => {
    const t = make(two, github({ issues: 45, statusItemFail: [1] }))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, added: 45, total: 45, failed: [], left: 0, unset: 3, message: 'Added 45 issues to B' })
    expect(count(t.calls, 'add')).toBe(3)
    expect(await t.creator.retry('bob-work', false)).toEqual({ ok: false, message: 'nothing left to add' })
  })
  it('is refused while a board is being created', async () => {
    const w: World = { issues: 3, addFail: [2] }
    let hold = false
    let answer: (v: boolean) => void = () => {}
    const t = make(two, github(w), { confirm: () => (hold ? new Promise<boolean>((done) => (answer = done)) : Promise.resolve(true)) })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, failed: ['app#2'] })
    hold = true
    const second = t.creator.create({ ...BOB, title: 'C' }, false)
    await new Promise((r) => setTimeout(r, 0))
    const before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toEqual({ ok: false, message: 'already creating a board' })
    expect(t.calls.length).toBe(before)
    answer(false)
    await second
    w.addFail = []
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 1 })
  })
})

describe('between the confirmation and the first write', () => {
  /** A config that becomes `then` once the confirmation is on screen. */
  function changing(then: AppConfig, w: World = {}, change?: (w: World) => void) {
    let cfg = two
    return make(() => cfg, github(w), {
      confirm: async () => {
        cfg = then
        change?.(w)
        return true
      },
    })
  }
  it('an account that got a board meanwhile is refused', async () => {
    const t = changing(boarded)
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'Nothing was created: this account already has a board selected' })
    expect(kinds(t.calls)).toEqual(['plan'])
    expect(t.seen.saved).toEqual([])
  })
  it('an account that was disconnected meanwhile is refused', async () => {
    const t = changing(swapped)
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'Nothing was created: not a connected GitHub account' })
    expect(kinds(t.calls)).toEqual(['plan'])
  })
  it('a board of that name made meanwhile is refused', async () => {
    const t = changing(two, {}, (w) => (w.boards = [ROADMAP, { number: 9, title: 'b', url: 'https://github.com/orgs/globex/projects/9', closed: false }]))
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, url: 'https://github.com/orgs/globex/projects/9', message: 'globex already has a board named "b". Pick it in Setup → Repos & boards, or choose another name.' })
    expect(kinds(t.calls)).toEqual(CHECKS)
  })
  it('another owner or other repositories than the ones confirmed are refused', async () => {
    const owner = changing(two, {}, (w) => (w.ownerId = 'O_2'))
    expect(await owner.creator.create(BOB, false)).toEqual({ ok: false, message: 'Nothing was created: the account or its repositories changed while you were confirming. Try again.' })
    expect(kinds(owner.calls)).toEqual(CHECKS)
    const repos = changing(wide)
    expect(await repos.creator.create(BOB, false)).toMatchObject({ ok: false, message: 'Nothing was created: the account or its repositories changed while you were confirming. Try again.' })
    expect(kinds(repos.calls)).toEqual(CHECKS)
  })
  it("one account: gh's active login is the account, so a switch while confirming is refused", async () => {
    let active = 'alice'
    const logins = async (): Promise<GhAccount[]> => LOGINS.map((a) => ({ ...a, active: a.login === active }))
    const t = make(one, github(), { ghLogins: logins, confirm: async (message) => (t.seen.asked.push({ message, lines: [] }), (active = 'bob-work'), true) })
    expect(await t.creator.create({ title: 'T' }, false)).toEqual({ ok: false, message: "gh's active account changed to bob-work; nothing was created" })
    expect(t.seen.asked[0].message).toBe('Create a GitHub board as alice?')
    expect(kinds(t.calls)).toEqual(CHECKS)
    // gh no longer names one at all.
    active = 'alice'
    const gone = make(one, github(), { ghLogins: logins, confirm: async () => ((active = ''), true) })
    expect(await gone.creator.create({ title: 'T' }, false)).toEqual({ ok: false, message: "gh's active account changed; nothing was created" })
    // Two or more accounts: every call carries the account's own token, gh's active login plays no part.
    active = 'alice'
    const multi = make(two, github(), { ghLogins: logins, confirm: async () => ((active = 'bob-work'), true) })
    expect(await multi.creator.create(BOB, false)).toMatchObject({ ok: true })
  })
  it('more open boards than the plan read: the confirmation says the name check is not complete', async () => {
    const t = make(two, github({ moreBoards: true }))
    expect(await t.creator.plan('bob-work')).toMatchObject({ ok: true, moreBoards: true })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true })
    expect(t.seen.asked[0].lines.at(-1)).toBe("The name could not be checked against all of globex's boards")
  })
  it('a confirmation that throws creates nothing and frees the next run', async () => {
    let boom = true
    const t = make(two, github(), {
      confirm: async () => {
        if (boom) throw new Error('window is gone')
        return false
      },
    })
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'Nothing was created: window is gone' })
    expect(kinds(t.calls)).toEqual(['plan'])
    boom = false
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, message: 'cancelled' }) // not "already creating a board"
  })
})

describe('accountGh: the runner of a connected account, or an error', () => {
  const inner = () => {
    const used: (string | null)[] = []
    const run: GhRunner = async () => ({ code: 0, stdout: '{"data":{}}', stderr: '' })
    return { used, of: (l: string | null) => (used.push(l), run) }
  }
  it('runs as the account while it is connected', async () => {
    const i = inner()
    expect(await accountGh(() => two, i.of)('bob-work')(['api', 'graphql'])).toMatchObject({ code: 0 })
    expect(await accountGh(() => one, i.of)(null)(['api', 'graphql'])).toMatchObject({ code: 0 })
    expect(i.used).toEqual(['bob-work', null])
  })
  it('never falls back to another account', async () => {
    const i = inner()
    expect(await accountGh(() => two, i.of)('mallory')(['api', 'graphql'])).toMatchObject({ code: 1, stderr: 'GitHub account mallory is not connected' })
    expect(await accountGh(() => two, i.of)('Bob-Work')(['api', 'graphql'])).toMatchObject({ code: 1 }) // the config's spelling only
    expect(await accountGh(() => two, i.of)(null)(['api', 'graphql'])).toMatchObject({ code: 1, stderr: 'no GitHub account was named' })
    // One account: only "the only one".
    expect(await accountGh(() => one, i.of)('bob-work')(['api', 'graphql'])).toMatchObject({ code: 1, stderr: 'GitHub account bob-work is not connected' })
    expect(i.used).toEqual([])
  })
  it('checks on every call: an account disconnected in the middle of a run stops there', async () => {
    const i = inner()
    let cfg = two
    const gh = accountGh(() => cfg, i.of)('bob-work')
    expect(await gh(['api', 'graphql'])).toMatchObject({ code: 0 })
    cfg = swapped
    expect(await gh(['api', 'graphql'])).toMatchObject({ code: 1, stderr: 'GitHub account bob-work is not connected' })
    expect(i.used).toEqual(['bob-work'])
  })
})

describe('once the project exists, its address is never lost', () => {
  it('a progress report that throws changes nothing', async () => {
    const t = make(two, github({ issues: 45 }), {
      progress: () => {
        throw new Error('Object has been destroyed') // the window was closed
      },
    })
    expect(await t.creator.create(BOB, false)).toEqual({ ok: true, url: URL7, title: 'B', added: 45, total: 45, failed: [], left: 0, unset: 0, unread: [], warnings: [], message: 'Added 45 issues to B' })
    expect(t.seen.saved).toHaveLength(1)
  })
  it('a save that throws: the result names the board, and Try again selects it', async () => {
    let broken = true
    const t = make(two, github(), {
      save: async (patch) => {
        if (broken) throw new Error('master: not found')
        t.seen.saved.push(patch)
        return { ok: true, message: 'saved' }
      },
    })
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, url: URL7, retry: true, message: `The board was created (${URL7}) but MasterDeck stopped before it was finished: master: not found. Try again to finish it.` })
    expect(t.seen.refreshed).toBe(0)
    broken = false
    const before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, url: URL7, added: 0, total: 0, message: 'Added 0 issues to B' })
    expect(t.calls.length).toBe(before) // both issues were added the first time
    expect(t.seen.saved).toHaveLength(1)
    expect(t.seen.refreshed).toBe(1)
    expect(await t.creator.retry('bob-work', false)).toEqual({ ok: false, message: 'nothing left to add' })
  })
  it('a gh that throws while adding: what was added stays added, the rest can be retried', async () => {
    const w: World = { issues: 45 }
    let trip = true
    // The second batch's call throws, once.
    const t = make(two, github(w), {
      wait: async () => {
        if (trip) w.addThrows = true
        trip = false
      },
    })
    expect(await t.creator.create(BOB, false)).toEqual({ ok: false, url: URL7, retry: true, message: `The board was created (${URL7}) but MasterDeck stopped before it was finished: spawn gh EAGAIN. Try again to finish it.` })
    expect(t.seen.saved).toEqual([])
    w.addThrows = false
    const before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 25, total: 25 })
    expect(t.calls[before].doc).toContain('contentId: "I_21"')
    expect(t.seen.saved).toHaveLength(1) // selected by the retry
  })
  it('a throw while linking, before any issue is read: Try again reads and adds them', async () => {
    let broke = false
    const world = github()
    const t = make(two, (doc, vars) => {
      if (doc.includes('linkProjectV2ToRepository(') && !broke) {
        broke = true
        throw new Error('spawn gh EAGAIN')
      }
      return world(doc, vars)
    })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: false, url: URL7, retry: true })
    const before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 2, total: 2, unread: [] })
    expect(kinds(t.calls.slice(before))).toEqual(['link', 'ids', 'add', 'status']) // the link that threw is made now
    expect(t.seen.saved).toHaveLength(1)
  })
  it('Try again links the repositories that could not be linked, and only those', async () => {
    const w: World = { count: { app: 3, web: 0 }, addFail: [2] }
    const world = github(w)
    let refuse = true
    const t = make(wide, (doc, vars) => (refuse && doc.includes('linkProjectV2ToRepository(') && vars.r === 'R_2' ? bad({ linkProjectV2ToRepository: null }, 'not allowed') : world(doc, vars)))
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: true, failed: ['app#2'], warnings: ['globex/web could not be linked to the board'] })
    // Still refused: the warning again.
    let before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, failed: ['app#2'], warnings: ['globex/web could not be linked to the board'] })
    expect(t.calls.slice(before).filter((c) => c.doc.includes('linkProjectV2ToRepository(')).map((c) => c.vars.r)).toEqual(['R_2'])
    refuse = false
    w.addFail = []
    before = t.calls.length
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, added: 1, warnings: [] })
    expect(kinds(t.calls.slice(before))).toEqual(['link', 'add', 'status'])
  })
  it('a board the user picked in Setup after a failed save is not saved a second time', async () => {
    let cfg = two
    let refuse = true
    let saves = 0
    const t = make(() => cfg, github(), { save: async () => (refuse ? { ok: false, message: 'accounts must be a list' } : (saves++, { ok: true, message: 'saved' })) })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: false, url: URL7, retry: true })
    cfg = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [ALICE, account('bob-work', 'globex', 'app', [{ owner: 'globex', number: 7, title: 'B' }])] })
    refuse = false
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, url: URL7, added: 0 })
    expect(saves).toBe(0)
    expect(t.seen.refreshed).toBe(1)
    expect(await t.creator.retry('bob-work', false)).toEqual({ ok: false, message: 'nothing left to add' })
  })
  it('a refresh that throws after the board was selected', async () => {
    let broken = true
    const t = make(two, github(), {
      refresh: () => {
        if (broken) throw new Error('disk full')
        t.seen.refreshed++
      },
    })
    expect(await t.creator.create(BOB, false)).toMatchObject({ ok: false, url: URL7, retry: true })
    broken = false
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, url: URL7 })
    expect(t.seen.saved).toHaveLength(1) // not saved twice
  })
  it('a config that cannot be saved: the result has what was added, and Try again saves again', async () => {
    let refuse = true
    const t = make(two, github({ issues: 3, addFail: [2] }), { save: async (patch) => (refuse ? { ok: false, message: 'accounts must be a list' } : (t.seen.saved.push(patch), { ok: true, message: 'saved' })) })
    expect(await t.creator.create(BOB, false)).toEqual({
      ok: false, url: URL7, retry: true, added: 2, total: 3, failed: ['app#2'], left: 0,
      message: `The board was created (${URL7}) and 2 of 3 issues were added, but MasterDeck could not select it: accounts must be a list. Try again, or pick it in Setup → Repos & boards.`,
    })
    expect(t.seen.refreshed).toBe(0)
    refuse = false
    expect(await t.creator.retry('bob-work', false)).toMatchObject({ ok: true, url: URL7, added: 0, total: 1, failed: ['app#2'] })
    expect(t.seen.saved).toHaveLength(1)
    expect(t.seen.refreshed).toBe(1)
  })
  it('an account that is gone when the board is to be selected: nothing is written, and the result says so', async () => {
    let cfg = two
    const t = make(() => cfg, github(), { progress: (p) => void (p.text.startsWith('Selecting') && (cfg = swapped)) })
    expect(await t.creator.create(BOB, false)).toMatchObject({
      ok: false, url: URL7, retry: true, added: 2, total: 2,
      message: `The board was created (${URL7}) and 2 of 2 issues were added, but MasterDeck could not select it: bob-work is no longer a connected account. Try again, or pick it in Setup → Repos & boards.`,
    })
    expect(t.seen.saved).toEqual([])
    expect(t.seen.refreshed).toBe(0)
  })
  it('a create call with no answer may have made the board: the result says to look first', async () => {
    const timeout = make(two, github({ createAnswer: TIMEOUT }))
    expect(await timeout.creator.create(BOB, false)).toEqual({ ok: false, message: `gh: connection timed out.${MAYBE}` })
    const garbage = make(two, github({ createAnswer: { code: 0, stdout: '<html>secret</html>', stderr: '' } }))
    expect(await garbage.creator.create(BOB, false)).toEqual({ ok: false, message: `GitHub did not answer (gh exited 0).${MAYBE}` })
    const thrown = make(two, github({ createThrows: true }))
    expect(await thrown.creator.create(BOB, false)).toEqual({ ok: false, message: `spawn gh ENOENT.${MAYBE}` })
    // GitHub said no (even with no data at all), or the call was never sent: nothing can exist.
    const refused = make(two, github({ createAnswer: bad(null, 'Resource not accessible by personal access token', 'FORBIDDEN') }))
    expect(await refused.creator.create(BOB, false)).toEqual({ ok: false, message: 'gh: Resource not accessible by personal access token' })
    const limited = make(two, github({ createAnswer: bad(null, 'API rate limit exceeded', 'RATE_LIMITED') }))
    expect(await limited.creator.create(BOB, false)).toEqual({ ok: false, message: 'gh: API rate limit exceeded' })
    const unsent = await accountGh(() => one, () => async () => TIMEOUT)('bob-work')(['api', 'graphql'])
    const stopped = make(two, github({ createAnswer: unsent }))
    expect(await stopped.creator.create(BOB, false)).toEqual({ ok: false, message: 'GitHub account bob-work is not connected' })
    for (const t of [timeout, garbage, thrown]) {
      expect(kinds(t.calls)).toEqual([...CHECKS, 'create'])
      expect(t.seen.saved).toEqual([])
    }
    expect(await thrown.creator.create(BOB, false)).not.toEqual({ ok: false, message: 'already creating a board' })
  })
  it('a board GitHub gave no address for is named without empty brackets', async () => {
    const t = make(two, github({ noUrl: true, updateFails: true }))
    const r = await t.creator.create(BOB, false)
    expect(r).toMatchObject({ ok: false, url: '' })
    expect(r.message).toBe('The board was created but its columns could not be set: gh: Field cannot be changed. Delete it on GitHub, or pick it in Setup → Repos & boards.')
    const kept = make(two, github({ noUrl: true }), { save: async () => ({ ok: false, message: 'no' }) })
    expect((await kept.creator.create(BOB, false)).message).toBe('The board was created and 2 of 2 issues were added, but MasterDeck could not select it: no. Try again, or pick it in Setup → Repos & boards.')
  })
})
