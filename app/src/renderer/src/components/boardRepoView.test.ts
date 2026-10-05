// The Board tab rendered to static markup (no browser): what a tab shows with and without repositories picked.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseConfig, setConfig, type AppConfig } from '@shared/appConfig'
import { applyRead, parseRepoIssues, repoViewDeriver, viewOf } from '@shared/repoView'
import type { AppState, RepoView } from '@shared/types'
import { fixtureState } from '../../../web/preview/fixture'

const NOW = Date.parse('2026-09-25T10:00:00Z')
const BOARD = { owner: 'acme', number: 1, title: 'Delivery', columns: ['Todo', 'In Progress', 'In Review', 'Done'] }
const boarded = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [BOARD] })
const legacy = parseConfig({ owner: 'acme', issueRepo: 'tracker', project: 1 })
const loose = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'] })

// The pieces of a browser the Board touches while rendering.
const store: Record<string, string> = {}
const g = globalThis as Record<string, unknown>
let BoardView: typeof import('./BoardView').BoardView
beforeAll(async () => {
  g.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) }
  g.window = { deck: { platform: 'darwin', boardRepos: () => {}, onTicketsCreated: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {} }
  g.document = { body: {} }
  BoardView = (await import('./BoardView')).BoardView
})

/** The fixture answer of `master repo-issues`, as the state carries it. */
function fixtureView(): RepoView {
  const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../../test/fixtures/repo-issues.json'), 'utf8'))
  const entries = applyRead({}, ['acme/tracker', 'acme/api'], parseRepoIssues(fx), null, NOW)
  return repoViewDeriver()(viewOf(entries, new Map()), { sessions: [], past: {}, linkPrs: {}, prLive: {}, now: NOW })!
}

function render(o: { config?: AppConfig; repos?: string[]; assignees?: string[]; repoView?: RepoView | null; state?: AppState } = {}): string {
  const config = o.config ?? boarded
  const base = o.state ?? fixtureState()
  const state: AppState = { ...base, config, sessions: [], ...(o.repoView === null ? { repoView: undefined } : { repoView: o.repoView ?? fixtureView() }) }
  setConfig(config)
  store.boardTabs = JSON.stringify([{ id: 't1', name: 'Tab', filters: { assignees: o.assignees ?? [], labels: [], milestone: null, hasPr: 'any', search: '', hiddenColumns: [], repos: o.repos ?? [], projects: [] } }])
  store.boardTab = JSON.stringify('t1')
  const noop = () => {}
  return renderToStaticMarkup(createElement(BoardView, { state, onOpenSession: noop, onStart: noop, onPr: noop, onAssign: noop, onSummary: noop, onSetup: noop }))
}
const columns = (html: string) => [...html.matchAll(/board-col-head[^>]*>.*?<strong>([^<]*)<\/strong>/g)].map((m) => m[1])

describe('a tab with no repository picked', () => {
  it('is the board: sprint picker, Summary, cards that can be dragged, no repository line', () => {
    const html = render()
    expect(html).toContain('sprint-pick')
    expect(html).toContain('>Summary<')
    expect(html).not.toContain('repo-view')
    expect(html).not.toContain('on-board')
    expect(html).toContain('draggable="true"')
    expect(html).not.toContain('draggable="false"')
  })
  it('keeps the + on every column, the Boards filter and its own empty state', () => {
    const html = render()
    expect(html.match(/class="col-add"/g)!.length).toBe(columns(html).length)
    // Two boards: the Boards filter is offered (the repository view has none).
    const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [BOARD, { ...BOARD, number: 2, title: 'Ops' }] })
    const base = fixtureState()
    expect(render({ config: two, state: { ...base, board: { ...base.board!, projects: [{ key: 'acme/1', title: 'Delivery', columns: BOARD.columns }, { key: 'acme/2', title: 'Ops', columns: BOARD.columns }] } } })).toContain('All boards')
    const none = render({ assignees: ['nobody'] })
    expect(none).toContain('No issues match')
    expect(none).not.toContain('Back to board')
    expect(none).not.toContain('repo-view')
  })
  it('offers the Repos filter with one repository too', () => {
    // No board read yet, so the one option is the repository ticked in Setup.
    expect(render({ config: legacy, state: { ...fixtureState(), board: null } })).toContain('All repos ▾')
  })
})

describe('a tab with repositories picked (its account has a board)', () => {
  it('shows every issue of them in MasterDeck\'s columns, read-only, and says it is not the board', () => {
    const html = render({ repos: ['acme/api', 'acme/tracker'] })
    expect(html).toContain('Issues of api, tracker — not the board.')
    expect(html).toContain('Back to board')
    expect(html).toContain('api: showing the first 300 of 412 open issues.')
    expect(columns(html)).toEqual(['Todo', 'In Dev', 'PR Raised', 'Done'])
    expect(html).toContain('6 of 6 issues')
    expect(html).not.toContain('sprint-pick')
    expect(html).not.toContain('>Summary<')
    expect(html).not.toContain('All boards')
    expect(html).not.toContain('draggable="true"')
    expect(html.match(/draggable="false"/g)).toHaveLength(6)
    expect(html).not.toContain('Hold to move this column')
  })
  it('the + is on Todo only and names the repository the ticket goes to', () => {
    const html = render({ repos: ['acme/api', 'acme/tracker'] })
    expect(html.match(/class="col-add"/g)).toHaveLength(1)
    expect(html).toContain('title="New ticket in api"')
  })
  it('only the picked repositories', () => {
    const html = render({ repos: ['acme/api'] })
    expect(html).toContain('Issues of api — not the board.')
    expect(html).toContain('3 of 3 issues')
    expect(html).not.toContain('Sample task 1')
    expect(html).toContain('Paginate the invoices endpoint')
  })
  it('a card whose issue is on a board shows that board\'s column', () => {
    const html = render({ repos: ['acme/tracker'] })
    expect(html).toContain('<span class="lbl on-board" title="On the Delivery board: Dev Done">▦ Dev Done</span>')
    expect(html.match(/on-board/g)).toHaveLength(1)
  })
  it('the other filters still apply, and an empty result says so and keeps the way back', () => {
    const html = render({ repos: ['acme/api'], assignees: ['nobody'] })
    expect(html).toContain('No issues match')
    expect(html).toContain('3 issues in api; the filters hide all of them.')
    expect(html).toContain('Show everyone&#x27;s issues')
    expect(html).toContain('Back to board')
  })
  it('shows the cards already read with a note for the repositories still loading', () => {
    const v = fixtureView()
    const partial: RepoView = { ...v, repos: v.repos.map((r) => (r.repo === 'acme/tracker' ? { ...r, takenAt: null, loading: true } : r)) }
    const html = render({ repos: ['acme/api', 'acme/tracker'], repoView: partial })
    expect(html).toContain('Loading tracker…')
    expect(html).toContain('Paginate the invoices endpoint')
  })
  it('says when the issues are still loading, could not be read, or are none', () => {
    expect(render({ repos: ['acme/api'], repoView: null })).toContain('Loading issues…')
    const gone: RepoView = { cards: [], repos: [{ repo: 'acme/api', account: null, ok: false, total: 0, shown: 0, note: 'Not found: acme/api', takenAt: null }] }
    const unread = render({ repos: ['acme/api'], repoView: gone })
    expect(unread).toContain('Could not read api')
    expect(unread).toContain('Not found: acme/api')
    expect(unread).toContain('>Retry<')
    const none: RepoView = { cards: [], repos: [{ repo: 'acme/api', account: null, ok: true, total: 0, shown: 0, takenAt: NOW }] }
    expect(render({ repos: ['acme/api'], repoView: none })).toContain('api has no open issues, and none closed in the last 14 days.')
    // A tab saved before the repository was unticked in Setup.
    const stale = render({ repos: ['acme/gone'] })
    expect(stale).toContain('acme/gone is not selected in Setup.')
    expect(stale).toContain('Could not read gone')
  })
})

describe('a tab of an account with no board', () => {
  it('picking a repository only filters: the no-board line stays and nothing says "not the board"', () => {
    const html = render({ config: loose, state: fixtureState(true), repos: ['acme/web'] })
    expect(html).toContain('This account has no GitHub board.')
    expect(html).not.toContain('repo-view')
    expect(html).not.toContain('not the board')
    expect(columns(html)).toEqual(['Todo', 'In Dev', 'PR Raised', 'Done'])
  })
  it('with exactly one repository there is no Repos filter, as before; with two there is', () => {
    const one = parseConfig({ owner: 'acme', issueRepo: 'web' })
    const html = render({ config: one, state: { ...fixtureState(true), board: null } })
    expect(html).not.toContain('All repos ▾')
    expect(render({ config: loose, state: { ...fixtureState(true), board: null } })).toContain('All repos ▾')
  })
})

describe('a picked repository that is never read', () => {
  it('says why and offers Retry and the way back, instead of loading for ever', () => {
    const acct = (login: string, owner: string, repos: string[], projects: unknown[], primary = false) => ({ login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repos[0].split('/')[1], repos, projects, ...(primary ? { primary: true } : {}) })
    const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [acct('alice', 'acme', ['acme/tracker', 'acme/api'], [BOARD], true), acct('bob-work', 'globex', ['globex/app'], [])] })
    const html = render({ config: two, repos: ['globex/app'], repoView: null })
    expect(html).not.toContain('Loading issues…')
    expect(html).toContain('Could not read app')
    expect(html).toContain('globex/app is a repository of bob-work, an account with no board: its issues are on that account&#x27;s tab.')
    expect(html).toContain('Back to board')
    // Refused by MasterDeck when asked: the same, with its reason.
    const note = 'acme/api not read: MasterDeck already shows 30 repositories. Go back to the board in a tab that shows others.'
    const full = render({ repos: ['acme/api'], repoView: { cards: [], repos: [{ repo: 'acme/api', account: null, ok: false, total: 0, shown: 0, note, takenAt: null }] } })
    expect(full).toContain('Could not read api')
    expect(full).toContain(note)
    expect(full).toContain('>Retry<')
  })
})

describe('the popups name the ticket with its repository', () => {
  it('the Assign and PR popups head with repo#number', async () => {
    const { AssignPopup } = await import('./AssignPopup')
    const { PrPopup } = await import('./PrPopup')
    const card = { number: 7, repo: 'acme/api', title: 'Fix it', url: 'u', status: 'Todo', assignees: [], prs: [], labels: [] } as never
    const noop = () => {}
    const a = renderToStaticMarkup(createElement(AssignPopup, { card, state: fixtureState(), onClose: noop, onAssigned: noop, onStart: noop }))
    expect(a).toContain('api#7 Fix it')
    expect(a).toContain('aria-label="Assign api#7"')
    const p = renderToStaticMarkup(createElement(PrPopup, { card, state: fixtureState(), onClose: noop, onStartReview: noop, onStart: noop }))
    expect(p).toContain('api#7 Fix it')
  })
  it('Start a session on the Assign popup says who stays assigned', async () => {
    const { AssignPopup } = await import('./AssignPopup')
    const noop = () => {}
    const popup = (assignees: string[]) => renderToStaticMarkup(createElement(AssignPopup, { card: { number: 7, repo: 'acme/api', title: 'Fix it', url: 'u', status: 'Todo', assignees, prs: [], labels: [] } as never, state: fixtureState(), onClose: noop, onAssigned: noop, onStart: noop }))
    expect(popup([])).toContain('nobody is assigned, and nothing is written to GitHub')
    expect(popup(['bob-work'])).toContain('it stays assigned to bob-work, and nothing is written to GitHub')
    expect(popup(['bob-work'])).not.toContain('nobody is assigned')
  })
})
