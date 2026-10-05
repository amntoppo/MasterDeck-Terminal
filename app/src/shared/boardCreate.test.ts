import { describe, expect, it } from 'vitest'
import { parseConfig } from './appConfig'
import {
  addItems, BOARD_ADD_MAX, boardConfigPatch, boardEntry, cleanTitle, confirmLines, CREATE_PROJECT, createStatusField, defaultBoardTitle, gql, issueIdsQuery,
  lacksProjectScope, LINK_REPO, okId, optionIds, parseField, parsePlan, planQuery, SCOPE_ERROR, scopeFix, planTotal, setStatuses, STATUS_FIELD, titleTaken, updateStatusField, type BoardPlan,
} from './boardCreate'
import type { GhAccount } from './ghAuth'

const DEFAULTS = [{ id: 'o-todo', name: 'Todo' }, { id: 'o-prog', name: 'In Progress' }, { id: 'o-done', name: 'Done' }]
const OPTIONS = { Todo: 'o-todo', 'In Dev': 'o-prog', 'PR Raised': 'o-new', Done: 'o-done' }
const account = (login: string, owner: string, repo: string, projects: unknown[], primary = false) => ({
  login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repo, repos: [`${owner}/${repo}`], projects, ...(primary ? { primary: true } : {}),
})
const gh = (login: string, scopes: string[], active = false): GhAccount => ({ login, active, ok: true, scopes })

describe('documents', () => {
  it('reads never say "mutation", writes always do (the shared cache routes on that word)', () => {
    for (const q of [planQuery(['acme/tracker']), STATUS_FIELD, issueIdsQuery('acme/tracker')]) expect(q).not.toMatch(/mutation/)
    for (const m of [CREATE_PROJECT, updateStatusField(DEFAULTS), createStatusField(), LINK_REPO, addItems(['I_1']), setStatuses([{ item: 'PVTI_1', option: 'o-todo' }])]) expect(m).toMatch(/^mutation\(/)
  })
  it('uses the verified mutation names and inputs', () => {
    expect(CREATE_PROJECT).toContain('createProjectV2(input: {ownerId: $o, title: $t})')
    expect(LINK_REPO).toContain('linkProjectV2ToRepository(input: {projectId: $p, repositoryId: $r})')
    expect(addItems(['I_1', 'I_2'])).toBe('mutation($p: ID!) { a0: addProjectV2ItemById(input: {projectId: $p, contentId: "I_1"}) { item { id } } a1: addProjectV2ItemById(input: {projectId: $p, contentId: "I_2"}) { item { id } } }')
    expect(setStatuses([{ item: 'PVTI_1', option: 'o-todo' }])).toBe('mutation($p: ID!, $f: ID!) { s0: updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: "PVTI_1", fieldId: $f, value: {singleSelectOptionId: "o-todo"}}) { projectV2Item { id } } }')
    expect(issueIdsQuery('acme/tracker')).toContain('repository(owner: "acme", name: "tracker") { issues(states: OPEN, first: 100, after: $c')
    expect(planQuery(['acme/tracker', 'acme/api'])).toContain('r1: repository(owner: "acme", name: "api") { id nameWithOwner issues(states: OPEN) { totalCount } }')
    expect(planQuery([])).toContain('repositoryOwner(login: $login)')
  })
  it('renames the default Status options in place and adds the new one', () => {
    const m = updateStatusField(DEFAULTS)
    expect(m).toContain('updateProjectV2Field(input: {fieldId: $f, singleSelectOptions: [{id: "o-todo", name: "Todo", color: GRAY, description: ""}, {id: "o-prog", name: "In Dev", color: YELLOW, description: ""}, {name: "PR Raised", color: BLUE, description: ""}, {id: "o-done", name: "Done", color: GREEN, description: ""}]})')
    // A field without the defaults: four new options, no id.
    expect(updateStatusField([{ id: 'x', name: 'Backlog' }])).not.toContain('id: "')
    expect(createStatusField()).toContain('createProjectV2Field(input: {projectId: $p, dataType: SINGLE_SELECT, name: "Status", singleSelectOptions: [{name: "Todo"')
  })
  it('keeps an option that already has the new name (a second run over a renamed field)', () => {
    const renamed = [{ id: 'o-todo', name: 'Todo' }, { id: 'o-prog', name: 'In Dev' }, { id: 'o-new', name: 'PR Raised' }, { id: 'o-done', name: 'Done' }]
    expect(updateStatusField(renamed)).toContain('[{id: "o-todo", name: "Todo", color: GRAY, description: ""}, {id: "o-prog", name: "In Dev", color: YELLOW, description: ""}, {id: "o-new", name: "PR Raised", color: BLUE, description: ""}, {id: "o-done", name: "Done", color: GREEN, description: ""}]')
    // Both the old and the new name are there: the new name's option is the one kept.
    expect(updateStatusField([{ id: 'o-old', name: 'In Progress' }, { id: 'o-dev', name: 'In Dev' }])).toContain('{id: "o-dev", name: "In Dev"')
  })
  it('asks only for the open boards of the owner', () => {
    expect(planQuery(['acme/tracker'])).toContain('projectsV2(first: 100, query: "is:open") { pageInfo { hasNextPage } nodes { number title url closed } }')
  })
  it('never puts an id it cannot trust into a document', () => {
    expect(okId('PVT_kwDOA-b_c=')).toBe(true)
    for (const bad of ['a"b', 'a\\b', 'a b', '', 'x'.repeat(201), 7, null]) expect(okId(bad)).toBe(false)
    expect(updateStatusField([{ id: 'o"x', name: 'Todo' }])).toContain('[{name: "Todo"')
    expect(() => addItems(['I_1', 'a"}) { evil'])).toThrow(/bad id/)
    expect(() => setStatuses([{ item: 'PVTI_1', option: '"' }])).toThrow(/bad id/)
  })
})

describe('answers', () => {
  it('reads data and which alias an error is for', () => {
    const g = gql(JSON.stringify({ data: { a0: { item: { id: 'PVTI_1' } }, a1: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve', path: ['a1'] }, {}] }))
    expect(g.data.a1).toBeNull()
    expect(g.errors).toEqual([{ message: 'Could not resolve', alias: 'a1', type: 'NOT_FOUND' }, { message: 'GitHub error', alias: null, type: null }])
    expect(g.ok).toBe(true) // a partial answer is an answer
  })
  it('a call with no data is a failure, never a clean empty answer', () => {
    const none = [{ message: 'GitHub did not answer', alias: null, type: 'NO_ANSWER' }]
    expect(gql('gh: not found')).toEqual({ ok: false, data: {}, errors: none })
    expect(gql('')).toEqual({ ok: false, data: {}, errors: none })
    expect(gql(JSON.stringify({ data: null }))).toEqual({ ok: false, data: {}, errors: none })
    expect(gql(JSON.stringify({ data: [] }))).toEqual({ ok: false, data: {}, errors: none })
    expect(gql('{}')).toEqual({ ok: false, data: {}, errors: none })
    // GitHub's own reason is kept when it gave one.
    expect(gql(JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }))).toEqual({ ok: false, data: {}, errors: [{ message: 'API rate limit exceeded', alias: null, type: 'RATE_LIMITED' }] })
    expect(gql(JSON.stringify({ data: {} }))).toEqual({ ok: true, data: {}, errors: [] })
  })
  it('the plan: owner, repositories with counts, the ones GitHub does not answer for, open boards', () => {
    const out = JSON.stringify({ data: {
      repositoryOwner: { __typename: 'User', id: 'U_1', login: 'alice', projectsV2: { nodes: [{ number: 3, title: 'Roadmap', url: 'https://github.com/users/alice/projects/3', closed: false }, { number: 2, title: 'Old', url: 'u', closed: true }, null] } },
      r0: { id: 'R_1', nameWithOwner: 'alice/tracker', issues: { totalCount: 26 } }, r1: null,
    } })
    expect(parsePlan(out, ['alice/tracker', 'alice/gone'])).toEqual({
      ok: true, errors: [], boardsRead: true, moreBoards: false,
      ownerId: 'U_1', ownerType: 'user', repos: [{ repo: 'alice/tracker', id: 'R_1', open: 26 }], missing: ['alice/gone'],
      existing: [{ number: 3, title: 'Roadmap', url: 'https://github.com/users/alice/projects/3' }],
    })
    expect(parsePlan('{}', ['acme/tracker'])).toEqual({ ok: false, errors: [{ message: 'GitHub did not answer', alias: null, type: 'NO_ANSWER' }], boardsRead: false, moreBoards: false, ownerId: null, ownerType: 'organization', repos: [], missing: ['acme/tracker'], existing: [] })
  })
  it('the plan: an owner with more open boards than one page says so', () => {
    const owner = (more: unknown) => JSON.stringify({ data: { repositoryOwner: { __typename: 'Organization', id: 'O_1', projectsV2: { pageInfo: { hasNextPage: more }, nodes: [] } }, r0: { id: 'R_1', issues: { totalCount: 1 } } } })
    expect(parsePlan(owner(true), ['acme/tracker'])).toMatchObject({ boardsRead: true, moreBoards: true })
    expect(parsePlan(owner(false), ['acme/tracker']).moreBoards).toBe(false)
  })
  it('the plan: boards GitHub did not list are not "no boards"', () => {
    const owner = { __typename: 'Organization', id: 'O_1', login: 'acme' }
    const r0 = { id: 'R_1', nameWithOwner: 'acme/tracker', issues: { totalCount: 1 } }
    // A partial error under the owner: the list may be short, so the name check cannot be trusted.
    const partial = parsePlan(JSON.stringify({ data: { repositoryOwner: { ...owner, projectsV2: null }, r0 }, errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'requires read:project', path: ['repositoryOwner', 'projectsV2'] }] }), ['acme/tracker'])
    expect(partial).toMatchObject({ ok: true, boardsRead: false, ownerId: 'O_1', existing: [], errors: [{ message: 'requires read:project', alias: 'repositoryOwner', type: 'INSUFFICIENT_SCOPES' }] })
    expect(parsePlan(JSON.stringify({ data: { repositoryOwner: { ...owner, projectsV2: { nodes: [] } }, r0 }, errors: [{ message: 'timeout', path: ['repositoryOwner', 'projectsV2', 'nodes'] }] }), ['acme/tracker']).boardsRead).toBe(false)
    expect(parsePlan(JSON.stringify({ data: { repositoryOwner: owner, r0 } }), ['acme/tracker']).boardsRead).toBe(false)
    // A repository GitHub does not answer for is its own matter: the boards were read.
    expect(parsePlan(JSON.stringify({ data: { repositoryOwner: { ...owner, projectsV2: { nodes: [] } }, r0, r1: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository', path: ['r1'] }] }), ['acme/tracker', 'acme/gone'])).toMatchObject({ boardsRead: true, missing: ['acme/gone'] })
  })
  it('the plan: a count GitHub did not give is unknown, not 0', () => {
    const out = JSON.stringify({ data: { repositoryOwner: { __typename: 'Organization', id: 'O_1', projectsV2: { nodes: [] } }, r0: { id: 'R_1', issues: null }, r1: { id: 'R_2', issues: { totalCount: 4 } } } })
    expect(parsePlan(out, ['acme/tracker', 'acme/api']).repos).toEqual([{ repo: 'acme/tracker', id: 'R_1', open: null }, { repo: 'acme/api', id: 'R_2', open: 4 }])
  })
  it('the Status field and its four options', () => {
    const f = parseField({ id: 'F_1', options: [{ id: 'o-todo', name: 'Todo' }, { id: 'o-prog', name: 'In Dev' }, { id: 'o-new', name: 'PR Raised' }, { id: 'o-done', name: 'Done' }, { id: 'bad"', name: 'X' }] })!
    expect(f.id).toBe('F_1')
    expect(optionIds(f.options)).toEqual(OPTIONS)
    expect(optionIds(DEFAULTS)).toBeNull() // In Dev and PR Raised are missing
    expect(parseField(null)).toBeNull()
    expect(parseField({ options: [] })).toBeNull()
  })
})

describe('titles', () => {
  it('default, cleaning and duplicates', () => {
    expect(defaultBoardTitle('tracker')).toBe('tracker board')
    expect(defaultBoardTitle('')).toBe('Issues board')
    expect(cleanTitle('  App \n board ')).toBe('App board')
    expect(cleanTitle('')).toBeNull()
    expect(cleanTitle('   ')).toBeNull()
    expect(cleanTitle('x'.repeat(101))).toBeNull()
    expect(cleanTitle('a\u0007b')).toBeNull()
    expect(cleanTitle(7)).toBeNull()
    // Characters that reorder or hide text would make the confirmation show another name.
    for (const c of ['\u202e', '\u202a', '\u2066', '\u2069', '\u200b', '\u200d', '\u200e', '\u200f', '\u2060', '\u061c', '\ufeff', '\u0085', '\u009b']) expect(cleanTitle(`a${c}b`), JSON.stringify(c)).toBeNull()
    expect(cleanTitle('Tableau été ボード')).toBe('Tableau été ボード')
    const existing = [{ title: 'Roadmap', url: 'u', number: 3 }]
    expect(titleTaken(existing, ' roadmap ')).toEqual(existing[0])
    expect(titleTaken(existing, 'Roadmap 2')).toBeNull()
  })
})

describe('config', () => {
  const entry = boardEntry({ owner: 'globex', ownerType: 'organization', number: 7, id: 'PVT_1', title: 'app board', fieldId: 'F_1', options: OPTIONS })
  it('the board entry', () => {
    expect(entry).toEqual({
      owner: 'globex', ownerType: 'organization', number: 7, id: 'PVT_1', title: 'app board', statusField: 'Status', statusFieldId: 'F_1',
      statusOptions: OPTIONS, columns: ['Todo', 'In Dev', 'PR Raised', 'Done'],
      statuses: { ready: 'Todo', inProgress: 'In Dev', prRaised: 'PR Raised', devDone: 'Done', blocked: [], done: ['Done'], finished: ['Done'], assignable: ['Todo'], resumable: ['In Dev', 'PR Raised'], rank: {} },
      sprintField: '', sprintless: true,
    })
  })
  it('goes into its account, the others untouched', () => {
    const c = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [account('alice', 'acme', 'tracker', [{ owner: 'acme', number: 1, title: 'Delivery' }], true), account('bob-work', 'globex', 'app', [])] })
    const p = boardConfigPatch(c, 'bob-work', entry) as { accounts: { login: string; primary?: boolean; projects: unknown[] }[] }
    expect(Object.keys(p)).toEqual(['accounts'])
    expect(p.accounts.map((a) => [a.login, a.primary, a.projects.length])).toEqual([['alice', true, 1], ['bob-work', undefined, 1]])
    expect(p.accounts[1].projects[0]).toBe(entry)
    expect(p.accounts[0]).toBe(c.accounts[0])
    // One account, no login given: the only one.
    const solo = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [account('alice', 'acme', 'tracker', [], true)] })
    expect((boardConfigPatch(solo, null, entry) as typeof p).accounts[0].projects).toEqual([entry])
  })
  it('finds the account whatever the case of its login, and writes nothing for one that is not there', () => {
    const c = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [account('alice', 'acme', 'tracker', [], true), account('Bob-Work', 'globex', 'app', [])] })
    const p = boardConfigPatch(c, 'bob-work', entry) as { accounts: { login: string; projects: unknown[] }[] }
    expect(p.accounts.map((a) => [a.login, a.projects.length])).toEqual([['alice', 0], ['Bob-Work', 1]])
    // No account took it: null, so the caller reports that nothing was selected.
    expect(boardConfigPatch(c, 'mallory', entry)).toBeNull()
  })
  it('a board the account already has is not added a second time', () => {
    const picked = { owner: 'Globex', number: 7, title: 'app board' } // chosen in Setup after a run that could not select it
    const c = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [account('alice', 'acme', 'tracker', [], true), account('bob-work', 'globex', 'app', [picked])] })
    expect(boardConfigPatch(c, 'bob-work', entry)).toBe('selected')
    // Another account having it does not select it for this one.
    expect(boardConfigPatch(c, 'alice', entry)).toMatchObject({ accounts: [{ login: 'alice', projects: [entry] }, { login: 'bob-work' }] })
    const byId = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [account('alice', 'acme', 'tracker', [{ owner: 'renamed', number: 1, id: 'PVT_1', title: 'x' }], true)] })
    expect(boardConfigPatch(byId, null, entry)).toBe('selected')
    expect(boardConfigPatch(parseConfig({ owner: 'acme', issueRepo: 'tracker', projects: [{ owner: 'globex', number: 7, title: 'x' }] }), null, entry)).toBe('selected')
  })
  it('the patch for a config with no accounts list', () => {
    expect(boardConfigPatch(parseConfig({ owner: 'acme', issueRepo: 'tracker' }), null, entry)).toEqual({ projects: [entry] })
  })
})

describe('the project scope', () => {
  it('lacksProjectScope: only when gh lists the scopes and project is not among them', () => {
    const list = [gh('alice', ['repo', 'project'], true), gh('bob-work', ['repo', 'read:project']), gh('carol', [])]
    expect(lacksProjectScope(list, 'alice')).toBe(false)
    expect(lacksProjectScope(list, 'BOB-WORK')).toBe(true) // read:project cannot create
    expect(lacksProjectScope(list, 'carol')).toBe(false) // no scope line (a fine-grained token): GitHub decides
    expect(lacksProjectScope(list, 'dave')).toBe(false) // gh does not know it: the runner refuses with its own reason
    expect(lacksProjectScope(list, null)).toBe(false) // one account: gh's active one
    expect(lacksProjectScope([gh('alice', ['repo'], true)], null)).toBe(true)
  })
  it('scopeFix for the active and for a second account', () => {
    expect(scopeFix('alice', 'alice')).toEqual(['gh auth refresh -h github.com -s project'])
    expect(scopeFix(null, 'alice')).toEqual(['gh auth refresh -h github.com -s project'])
    expect(scopeFix('bob-work', 'alice')).toEqual(['gh auth switch -h github.com -u bob-work', 'gh auth refresh -h github.com -s project', 'gh auth switch -h github.com -u alice'])
    expect(scopeFix('Alice', 'alice')).toEqual(['gh auth refresh -h github.com -s project'])
    // gh's active account is not known: a bare refresh could widen another account's token, so switch first.
    expect(scopeFix('bob-work', null)).toEqual(['gh auth switch -h github.com -u bob-work', 'gh auth refresh -h github.com -s project'])
    expect(scopeFix(null, null)).toEqual(['gh auth refresh -h github.com -s project'])
  })
  it("recognises GitHub's scope errors", () => {
    expect(SCOPE_ERROR.test("Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']")).toBe(true)
    expect(SCOPE_ERROR.test('{"errors":[{"type":"INSUFFICIENT_SCOPES"}]}')).toBe(true)
    expect(SCOPE_ERROR.test('Could not resolve to a Repository')).toBe(false)
  })
})

describe('confirmLines', () => {
  const plan: BoardPlan = { account: 'bob-work', owner: 'globex', ownerType: 'organization', ownerId: 'O_1', title: 'app board', repos: [{ repo: 'globex/app', id: 'R_1', open: 26 }], missing: [], skipped: [], total: 26, existing: [] }
  it('lists what will be created', () => {
    expect(confirmLines(plan, 'App board')).toEqual([
      'A GitHub project "App board" under globex',
      'Columns: Todo, In Dev, PR Raised, Done',
      'Linked to 1 repository: globex/app',
      '26 open issues added to it',
      'The board selected for bob-work in MasterDeck',
    ])
  })
  it('says what is left out', () => {
    const big = { ...plan, account: null, total: BOARD_ADD_MAX + 5, repos: [...plan.repos, { repo: 'globex/web', id: 'R_2', open: 1 }], missing: ['globex/gone'], skipped: ['globex/old'] }
    expect(confirmLines(big, 'T')).toEqual([
      'A GitHub project "T" under globex',
      'Columns: Todo, In Dev, PR Raised, Done',
      'Linked to 2 repositories: globex/app, globex/web',
      `The first ${BOARD_ADD_MAX} of ${BOARD_ADD_MAX + 5} open issues added to it`,
      'The board selected for globex in MasterDeck',
      'Left out: globex/gone (GitHub did not answer), globex/old (more than 10 repositories)',
    ])
    expect(confirmLines({ ...plan, total: 1 }, 'T')[3]).toBe('1 open issue added to it')
    // More boards than were read: the name check is not complete, and the person is told before confirming.
    expect(confirmLines({ ...plan, moreBoards: true }, 'T').at(-1)).toBe("The name could not be checked against all of globex's boards")
    expect(confirmLines({ ...plan, moreBoards: false }, 'T')).toHaveLength(5)
    // One repository's count is unknown: the total is too.
    const unknown = { ...plan, total: 3, repos: [{ repo: 'globex/app', id: 'R_1', open: null }, { repo: 'globex/web', id: 'R_2', open: 3 }] }
    expect(planTotal(unknown)).toBeNull()
    expect(planTotal(plan)).toBe(26)
    expect(confirmLines(unknown, 'T')[3]).toBe(`An unknown number of open issues added to it (${BOARD_ADD_MAX} at most)`)
  })
})
