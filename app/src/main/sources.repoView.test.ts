import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '@shared/appConfig'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { toRemoteSnapshot } from '@shared/remoteSnapshot'
import { RATE_LIMITED, Sources } from './sources'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-repoview-'))
})
afterEach(() => {
  delete process.env.MASTERDECK_REPO_FIXTURE
  rmSync(dir, { recursive: true, force: true })
})

const BOARD = { owner: 'acme', number: 1, title: 'Delivery', columns: ['To Do', 'In QA'] }
const boarded = parseConfig({ owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [BOARD] })

function make() {
  const p = (n: string) => join(dir, n)
  const paths = { libDir: dir, bundledTee: p('tee'), installedTee: p('tee2'), home: dir, statsDir: p('stats'), claudeSettings: p('settings.json'), projectsDir: p('projects'), ledger: p('ledger'), masterWorkspace: dir, python: 'python3', babysitState: p('bs'), ticketLinks: p('links.json'), bundledSkills: p('skills'), skillsDir: p('skills2'), config: p('config.json') }
  const states: unknown[] = []
  const cli = { repoIssues: vi.fn(async () => ({ ok: false as const, message: 'no cli in tests' })) }
  const src = new Sources(paths as never, (async () => ({ code: 1, stdout: '', stderr: 'no' })) as never, cli as never, (s) => states.push(s))
  const priv = src as unknown as Record<string, any>
  priv.config = boarded
  return { src, priv, cli, states }
}

describe('Sources and the repository view', () => {
  it('the built state has no repoView until a tab asked', () => {
    const { src } = make()
    expect(src.build().repoView).toBeUndefined()
  })
  it('the remote snapshot never carries it', () => {
    const { src, priv } = make()
    const s = src.build()
    const withView = { ...s, repoView: { cards: [], repos: [{ repo: 'acme/api', account: null, ok: true, total: 1, shown: 1, takenAt: 1 }] }, settings: DEFAULT_SETTINGS }
    expect(JSON.stringify(toRemoteSnapshot(withView as never, 'v'))).not.toContain('repoView')
    expect(Object.keys(toRemoteSnapshot(withView as never, 'v'))).not.toContain('repoView')
    expect(priv.repoIssues).toBeDefined()
  })
  it('the fixture only acts when MASTERDECK_REPO_FIXTURE is set', async () => {
    const a = make()
    a.src.askRepos(['acme/api'])
    await new Promise((r) => setTimeout(r, 5))
    expect(a.cli.repoIssues).toHaveBeenCalledTimes(1) // no fixture: the CLI is asked
    const fx = join(dir, 'fx.json')
    writeFileSync(fx, JSON.stringify({ taken_at: 'x', cards: [], repos: [{ repo: 'acme/web', account: null, ok: true, total: 0, shown: 0 }] }))
    process.env.MASTERDECK_REPO_FIXTURE = fx
    const b = make()
    b.src.askRepos(['acme/web', 'acme/api'])
    await new Promise((r) => setTimeout(r, 5))
    expect(b.cli.repoIssues).not.toHaveBeenCalled()
  })
  it('only the Board\'s own Refresh forces the repository read', async () => {
    const { src, priv } = make()
    const refresh = vi.spyOn(priv.repoIssues, 'refresh').mockResolvedValue({ ok: true, message: 'x' })
    for (const m of ['refreshSnapshot', 'refreshBoard', 'refreshPeople', 'refreshTeamPrs']) priv[m] = vi.fn(async () => ({ ok: true, message: 'x' }))
    await src.refreshGithub(true) // after a ticket, an assign, Setup
    await src.refreshGithub() // the hourly refresh
    await src.refreshGithub(true, true) // the Refresh / Retry button
    expect(refresh.mock.calls.map((c) => c[0])).toEqual([false, false, true])
  })
  it('names the repositories of the cards on the boards it has loaded (for the Assign popup), each once', () => {
    const { src, priv } = make()
    expect(src.boardRepos()).toEqual([])
    const card = (repo: string | null) => ({ number: 1, repo, project: 'acme/1', title: 't', url: '', status: 'To Do', prs: [], assignees: [], labels: [], milestone: null, type: null })
    priv.boards = { '@current': { takenAt: 1, sprint: null, columns: [], cards: [card('partner/portal'), card('Partner/Portal'), card('acme/api')] }, 'Sprint 2': { takenAt: 1, sprint: null, columns: [], cards: [card('acme/web')] } }
    expect(src.boardRepos()).toEqual(['partner/portal', 'acme/api', 'acme/web'])
  })
  it('only cards of a board Setup still selects count, and each knows its board', () => {
    const { src, priv } = make()
    const card = (repo: string | null, project: string | null, number = 1) => ({ number, repo, project, title: 't', url: '', status: 'To Do', prs: [], assignees: [], labels: [], milestone: null, type: null })
    priv.boards = { '@current': { takenAt: 1, sprint: null, columns: [], cards: [card('partner/portal', 'acme/1', 4), card('old/gone', 'acme/9'), card('acme/loose', null), card('partner/portal', 'acme/1', 5)] } }
    expect(src.boardRepos()).toEqual(['partner/portal']) // acme/9 was removed in Setup; a card with no board is no board's
    expect(src.boardOf('Partner/Portal', 5)).toBe('acme/1')
    expect(src.boardOf('partner/portal')).toBe('acme/1')
    expect(src.boardOf('old/gone', 1)).toBeNull()
    expect(src.boardOf(null, 4)).toBeNull()
  })
  it('a rate-limited repository note starts the pause', () => {
    for (const t of ['acme/api not read: RATE_LIMITED', 'gh: API rate limit exceeded', 'secondary rate limit', 'abuse detection mechanism']) expect(RATE_LIMITED.test(t)).toBe(true)
    expect(RATE_LIMITED.test('Not found: acme/old')).toBe(false)
  })
})
