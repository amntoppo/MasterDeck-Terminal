import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '@shared/appConfig'
import { ticketAccount } from '@shared/accounts'
import { folderAccount, isTicketBuilderSession, pumpTicketDir, ticketBuilderDir, ticketDirOk, ticketDirs, ticketPane } from './ticketDirs'

const A = { login: 'alice', primary: true, name: 'Alice', email: 'a@acme.test', owner: 'acme', issueRepo: 'tracker', repos: ['acme/tracker', 'acme/api'], projects: [] }
const B = { login: 'bob-work', name: 'Bob', email: 'b@globex.test', owner: 'globex', issueRepo: 'app', repos: ['globex/app'], projects: [] }
const two = parseConfig({ owner: 'acme', issueRepo: 'tracker', accounts: [A, B] })

describe('ticketBuilderDir', () => {
  it('one shared folder with one account, a folder per tab with several; a bad tab id is refused', () => {
    expect(ticketBuilderDir('/h', null, false)).toBe(join('/h', 'ticket-builder'))
    expect(ticketBuilderDir('/h', 'board-x', false)).toBe(join('/h', 'ticket-builder'))
    expect(ticketBuilderDir('/h', 'board-mine-bob-work', true)).toBe(join('/h', 'ticket-builder', 'tab-board-mine-bob-work'))
    for (const bad of [null, '', '../x', 'a b', 'x'.repeat(65), 'a/b'])
      expect(() => ticketBuilderDir('/h', bad, true)).toThrow(/tab/)
  })
})

describe('ticketDirs', () => {
  it('the shared folder with one account; only tab-<id> folders with several', () => {
    const home = mkdtempSync(join(tmpdir(), 'td-'))
    const root = join(home, 'ticket-builder')
    for (const d of ['tab-a', 'tab-b_2', 'other', 'tab-bad name', 'requests']) mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, 'tab-file'), '')
    expect(ticketDirs(home, false)).toEqual([root])
    expect(ticketDirs(home, true).sort()).toEqual([join(root, 'tab-a'), join(root, 'tab-b_2')])
    expect(ticketDirs(join(home, 'missing'), true)).toEqual([])
  })
})

describe('ticketPane', () => {
  const ok = (l?: string) => ({ ok: true as const, args: ['--settings', `/acc/${l}.settings.json`] })
  it('one account: the shared folder, no settings, tab and account ignored', () => {
    expect(ticketPane('/h', false, { tab: 't1', account: 'bob-work' }, ok)).toEqual({ cwd: join('/h', 'ticket-builder'), settings: [] })
  })
  it("several: the tab's folder, as the tab's account", () => {
    expect(ticketPane('/h', true, { tab: 't1', account: 'bob-work' }, ok)).toEqual({
      cwd: join('/h', 'ticket-builder', 'tab-t1'),
      tab: 't1',
      settings: ['--settings', '/acc/bob-work.settings.json'],
    })
  })
  it('several: a bad tab, no account, or an account that cannot start is refused (never the active gh account)', () => {
    expect(ticketPane('/h', true, { tab: '../x', account: 'alice' }, ok)).toMatchObject({ error: expect.stringMatching(/tab/) })
    expect(ticketPane('/h', true, { tab: 't1' }, ok)).toMatchObject({ error: expect.stringMatching(/account/) })
    expect(ticketPane('/h', true, { tab: 't1', account: 'alice' }, () => ({ ok: false, message: 'GitHub account alice needs to log in again' }))).toEqual({
      error: 'GitHub account alice needs to log in again',
    })
    // Accounts still loading (no file args yet): refused, never run as gh's active account.
    expect(ticketPane('/h', true, { tab: 't1', account: 'alice' }, () => ({ ok: true, args: [] }))).toEqual({
      error: 'GitHub accounts are still loading; try again in a few seconds',
    })
  })
})

describe('pumpTicketDir', () => {
  it("creates a request as its own folder's account, not another tab's", async () => {
    const home = mkdtempSync(join(tmpdir(), 'tp-'))
    const a = join(home, 'ticket-builder', 'tab-a')
    const b = join(home, 'ticket-builder', 'tab-b')
    for (const [d, acct] of [[a, 'bob-work'], [b, 'alice']]) {
      mkdirSync(join(d, 'requests'), { recursive: true })
      writeFileSync(join(d, 'context.json'), JSON.stringify({ account: acct }))
    }
    writeFileSync(join(a, 'body.md'), 'the body')
    writeFileSync(join(a, 'requests', '1-2-3.req'), ['--title', 'T', '--repo', 'acme/api', '--body-file', 'body.md', ''].join('\0'))
    const made: { account: string | null; title: string; body: string }[] = []
    const create = async (p: { title: string; repo?: string; body: string }, picked: string | null) => {
      made.push({ account: ticketAccount(picked, p.repo || null, two), title: p.title, body: p.body })
      return { ok: true, url: 'https://github.com/acme/api/issues/9', number: 9 }
    }
    for (const d of [a, b]) await pumpTicketDir(d, create)
    expect(made).toEqual([{ account: 'bob-work', title: 'T', body: 'the body' }])
    expect(JSON.parse(readFileSync(join(a, 'answers', '1-2-3.json'), 'utf8'))).toMatchObject({ ok: true, number: 9 })
    expect(readFileSync(join(a, 'created.jsonl'), 'utf8')).toContain('"number":9')
    expect(readdirSync(b)).not.toContain('created.jsonl')
  })
  it('a body file outside its folder is refused', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tp2-'))
    mkdirSync(join(d, 'requests'))
    writeFileSync(join(d, 'requests', '1-1-1.req'), ['--title', 'T', '--body-file', '/etc/hosts', ''].join('\0'))
    let called = false
    await pumpTicketDir(d, async () => ((called = true), { ok: true }))
    expect(called).toBe(false)
    expect(readFileSync(join(d, 'answers', '1-1-1.json'), 'utf8')).toContain('outside the ticket folder')
  })
})

describe('pumpTicketDir with a settings bar', () => {
  const bar = { repo: 'acme/web', project: 'acme/1', status: 'Todo', assignees: ['ann'], labels: ['bug'], milestone: '', sprint: '@current', sprintField: 'Sprint' }
  const run = async (args: string[], settings: unknown) => {
    const d = mkdtempSync(join(tmpdir(), 'tps-'))
    mkdirSync(join(d, 'requests'))
    writeFileSync(join(d, 'context.json'), JSON.stringify({ settings }))
    writeFileSync(join(d, 'requests', '1-1-1.req'), [...args, ''].join('\0'))
    const seen: Record<string, unknown>[] = []
    await pumpTicketDir(d, async (p) => (seen.push(p), { ok: true, url: 'https://github.com/acme/web/issues/3', number: 3 }))
    return { seen, answer: JSON.parse(readFileSync(join(d, 'answers', '1-1-1.json'), 'utf8')) }
  }
  it("creates with the bar's values, whatever the session passed, and says which it replaced", async () => {
    const { seen, answer } = await run(['--title', 'T', '--repo', 'acme/api', '--assignee', 'bob', '--milestone', 'v2', '--status', 'Todo'], bar)
    expect(seen[0]).toMatchObject({ title: 'T', repo: 'acme/web', project: 'acme/1', status: 'Todo', assignees: ['ann'], labels: ['bug'], sprint: '@current', sprintField: 'Sprint' })
    expect(seen[0].milestone).toBeUndefined()
    expect(answer.applied).toMatchObject({ repo: 'acme/web', assignees: ['ann'], sprint: '@current' })
    expect(answer.overridden.map((o: { field: string }) => o.field)).toEqual(['repo', 'assignees', 'milestone'])
    expect(answer.note).toContain('settings bar')
  })
  it('without a bar the flags pass as before', async () => {
    const { seen, answer } = await run(['--title', 'T', '--repo', 'acme/api'], undefined)
    expect(seen[0]).toMatchObject({ repo: 'acme/api' })
    expect(answer.applied).toBeUndefined()
  })
  it('a bar that cannot be read refuses the create instead of dropping the bar', async () => {
    const { seen, answer } = await run(['--title', 'T', '--repo', 'acme/api'], { repo: 'not a repo' })
    expect(seen).toEqual([])
    expect(answer).toMatchObject({ ok: false })
    expect(answer.error).toContain('settings bar')
  })
})

describe('isTicketBuilderSession', () => {
  it("is the shared folder's or any tab folder's session, or one named md-ticket-builder[-tab]", () => {
    const h = '/h'
    expect(isTicketBuilderSession({ name: 'x', cwd: join(h, 'ticket-builder') }, h)).toBe(true)
    expect(isTicketBuilderSession({ name: 'x', cwd: join(h, 'ticket-builder', 'tab-t1') }, h)).toBe(true)
    expect(isTicketBuilderSession({ name: 'md-ticket-builder-t1', cwd: '/w' }, h)).toBe(true)
    expect(isTicketBuilderSession({ name: 'md-ticket-builder', cwd: '/w' }, h)).toBe(true)
    expect(isTicketBuilderSession({ name: 'fix', cwd: join(h, 'ticket-builder', 'other') }, h)).toBe(false)
    expect(isTicketBuilderSession({ name: 'fix', cwd: '/w' }, h)).toBe(false)
  })
})

describe('symlinked tab folders', () => {
  it('are skipped by the pump and refused by ticketDirOk; real ones pass', () => {
    const home = mkdtempSync(join(tmpdir(), 'tl-'))
    const root = join(home, 'ticket-builder')
    const elsewhere = mkdtempSync(join(tmpdir(), 'tl-out-'))
    mkdirSync(join(root, 'tab-a'), { recursive: true })
    symlinkSync(elsewhere, join(root, 'tab-x'))
    expect(ticketDirs(home, true)).toEqual([join(root, 'tab-a')])
    expect(ticketDirOk(home, join(root, 'tab-a'))).toBe(true)
    expect(ticketDirOk(home, join(root, 'tab-x'))).toBe(false)
    expect(ticketDirOk(home, join(root, 'tab-new'))).toBe(true) // not made yet
    expect(ticketDirOk(home, root)).toBe(true)
    expect(ticketPane(home, true, { tab: 'x', account: 'alice' }, () => ({ ok: true, args: [] }))).toMatchObject({ error: expect.stringMatching(/folder/) })
  })
})

describe('folderAccount', () => {
  it("a tab folder's context.json account; null when none", () => {
    const home = mkdtempSync(join(tmpdir(), 'fa-'))
    const d = join(home, 'ticket-builder', 'tab-a')
    mkdirSync(d, { recursive: true })
    expect(folderAccount(home, 'a')).toBeNull()
    writeFileSync(join(d, 'context.json'), JSON.stringify({ account: 'bob-work' }))
    expect(folderAccount(home, 'a')).toBe('bob-work')
    expect(folderAccount(home, '../x')).toBeNull()
  })
})
