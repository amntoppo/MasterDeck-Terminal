import { describe, expect, it } from 'vitest'
import { parseConfig } from './appConfig'
import {
  addItems, BOARD_ADD_MAX, boardConfigPatch, boardEntry, cleanTitle, confirmLines, CREATE_PROJECT, createStatusField, defaultBoardTitle, gql, issueIdsQuery,
  lacksProjectScope, LINK_REPO, okId, optionIds, parseField, parsePlan, planQuery, SCOPE_ERROR, scopeFix, setStatuses, STATUS_FIELD, titleTaken, updateStatusField, type BoardPlan,
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
    expect(gql('gh: not found')).toEqual({ data: {}, errors: [] })
    expect(gql(JSON.stringify({ data: null }))).toEqual({ data: {}, errors: [] })
  })
  it('the plan: owner, repositories with counts, the ones GitHub does not answer for, open boards', () => {
    const out = JSON.stringify({ data: {
      repositoryOwner: { __typename: 'User', id: 'U_1', login: 'alice', projectsV2: { nodes: [{ number: 3, title: 'Roadmap', url: 'https://github.com/users/alice/projects/3', closed: false }, { number: 2, title: 'Old', url: 'u', closed: true }, null] } },
      r0: { id: 'R_1', nameWithOwner: 'alice/tracker', issues: { totalCount: 26 } }, r1: null,
    } })
    expect(parsePlan(out, ['alice/tracker', 'alice/gone'])).toEqual({
      ownerId: 'U_1', ownerType: 'user', repos: [{ repo: 'alice/tracker', id: 'R_1', open: 26 }], missing: ['alice/gone'],
      existing: [{ number: 3, title: 'Roadmap', url: 'https://github.com/users/alice/projects/3' }],
    })
    expect(parsePlan('{}', ['acme/tracker'])).toEqual({ ownerId: null, ownerType: 'organization', repos: [], missing: ['acme/tracker'], existing: [] })
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
    expect(scopeFix('bob-work', 'alice')).toEqual(['gh auth switch -u bob-work', 'gh auth refresh -h github.com -s project', 'gh auth switch -u alice'])
    expect(scopeFix('bob-work', null)).toEqual(['gh auth refresh -h github.com -s project'])
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
  })
})
