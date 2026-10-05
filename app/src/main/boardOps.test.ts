import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig, setConfig, type AppConfig } from '@shared/appConfig'
import { BoardOps, linkTicket, parseCreateArgs, bodyFileAllowed, sweepTicketDirs, ticketBuilderScript, type LinkDeps } from './boardOps'
import type { GhRunner } from './ghc'

const cfg: AppConfig = parseConfig({
  owner: 'acme', issueRepo: 'tracker', repos: ['acme/web'],
  projects: [{ owner: 'acme', number: 1, id: 'PVT_1', statusFieldId: 'F1', statusOptions: { Todo: 'o1', 'In Dev': 'o2', 'PR Raised': 'o3', 'Dev Done': 'o4' }, columns: ['Todo', 'In Dev', 'PR Raised', 'Dev Done'], statuses: { ready: 'Todo', inProgress: 'In Dev', prRaised: 'PR Raised', devDone: 'Dev Done' } }],
})
// fullRepo / ticketLabel read the global config.
setConfig(cfg)

/** A gh that answers from a list of [matcher, stdout] and records every call. Never runs gh. */
function fakeGh(answers: [RegExp, string][]) {
  const calls: string[][] = []
  const gh: GhRunner = async (args) => {
    calls.push(args)
    const hit = answers.find(([re]) => re.test(args.join(' ')))
    return hit ? { code: 0, stdout: hit[1], stderr: '' } : { code: 1, stdout: '', stderr: 'unexpected call' }
  }
  return { gh, calls }
}
const issue = (status: string, onBoard = true) =>
  JSON.stringify({ data: { repository: { issue: { title: 'Fix it', state: 'OPEN', projectItems: { nodes: onBoard ? [{ id: 'ITEM_1', project: { number: 1, owner: { login: 'acme' } }, fieldValues: { nodes: [{ name: status, field: { id: 'F1' } }, { name: 'High', field: { id: 'F9' } }] } }] : [] } } } } })

describe('BoardOps', () => {
  it('reads the item and status on the first configured board', async () => {
    const { gh } = fakeGh([[/graphql/, issue('Todo')]])
    expect(await new BoardOps(gh, () => cfg).issueInfo({ repo: null, number: 12 })).toEqual({ title: 'Fix it', state: 'OPEN', item: 'ITEM_1', project: 'acme/1', status: 'Todo' })
  })
  it('moves forward only, unless forced', async () => {
    const { gh, calls } = fakeGh([[/graphql/, issue('PR Raised')], [/item-edit/, '']])
    const ops = new BoardOps(gh, () => cfg)
    const back = await ops.move({ repo: null, number: 12 }, 'In Dev')
    expect(back).toEqual({ ok: true, message: '#12 left at PR Raised (not moving back to In Dev)' })
    expect(calls.some((c) => c.includes('item-edit'))).toBe(false)
    const forced = await ops.setStatus({ repo: null, number: 12 }, 'In Dev')
    expect(forced.ok).toBe(true)
    expect(calls.at(-1)).toEqual(['project', 'item-edit', '--project-id', 'PVT_1', '--id', 'ITEM_1', '--field-id', 'F1', '--single-select-option-id', 'o2'])
  })
  it('refuses unknown statuses and tickets on no selected board', async () => {
    expect((await new BoardOps(fakeGh([[/graphql/, issue('Todo')]]).gh, () => cfg).move({ repo: null, number: 1 }, 'Nope')).message).toMatch(/unknown status 'Nope'/)
    expect((await new BoardOps(fakeGh([[/graphql/, issue('Todo', false)]]).gh, () => cfg).move({ repo: null, number: 1 }, 'In Dev')).message).toMatch(/not on any selected board/)
  })
  it('reads before writing without the cache', async () => {
    const seen: { force?: boolean }[] = []
    const gh: GhRunner = async (args, opts) => (seen.push(opts ?? {}), { code: 0, stdout: args[0] === 'api' ? issue('Todo') : '', stderr: '' })
    await new BoardOps(gh, () => cfg).move({ repo: null, number: 12 }, 'In Dev')
    expect(seen[0].force).toBe(true)
  })
  it('links a PR under Development with addCloseIssueReferences', async () => {
    const { gh, calls } = fakeGh([
      [/issue\(number/, 'I_1\n'],
      [/pullRequest\(number/, 'PR_9\n'],
      [/addCloseIssueReferences/, '{}'],
    ])
    expect(await new BoardOps(gh, () => cfg).linkPr({ repo: null, number: 12 }, 'https://github.com/acme/web/pull/9')).toBe(true)
    expect(calls.at(-1)).toContain('i=I_1')
    expect(calls.at(-1)).toContain('p=PR_9')
    expect(await new BoardOps(gh, () => cfg).linkPr({ repo: null, number: 12 }, 'not a url')).toBe(false)
  })
  it('creates: dry run touches nothing; a real run adds to the board, sets status and the current sprint', async () => {
    const dry = fakeGh([])
    const plan = await new BoardOps(dry.gh, () => cfg).create({ title: 'T', body: '', status: 'Todo', dryRun: true })
    expect(plan).toMatchObject({ ok: true, dryRun: true, project: 'acme/1', status: 'Todo' })
    expect(dry.calls).toEqual([])
    const now = new Date()
    const start = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
    const { gh, calls } = fakeGh([
      [/^issue create/, 'https://github.com/acme/tracker/issues/77\n'],
      [/item-add/, JSON.stringify({ id: 'ITEM_77' })],
      [/ProjectV2IterationField/, JSON.stringify({ data: { node: { field: { id: 'SF', configuration: { iterations: [{ id: 'IT1', title: 'S1', startDate: start, duration: 14 }] } } } } })],
      [/item-edit/, ''],
    ])
    const r = await new BoardOps(gh, () => cfg).create({ title: 'T', body: 'b', status: 'Todo', sprint: '@current', labels: ['bug'] })
    expect(r).toEqual({ ok: true, url: 'https://github.com/acme/tracker/issues/77', number: 77, project: 'acme/1', status: 'Todo', sprint: '@current' })
    expect(calls[0]).toEqual(['issue', 'create', '-R', 'acme/tracker', '--title', 'T', '--body', 'b', '--label', 'bug'])
    expect(calls.filter((c) => c[1] === 'item-edit').map((c) => c.at(-1))).toEqual(['o1', 'IT1'])
  })
  it('parses tt.sh create flags', () => {
    expect(parseCreateArgs(['--title', 'T', '--repo', 'acme/web', '--label', 'a', '--label', 'b', '--assignee', 'x,y', '--dry-run'])).toEqual({ title: 'T', body: '', repo: 'acme/web', labels: ['a', 'b'], assignees: ['x', 'y'], dryRun: true })
    expect(parseCreateArgs(['--what'])).toEqual({ error: 'create: unknown option --what' })
  })
})

describe('linkTicket', () => {
  const SID = '33333333-3333-4333-8333-333333333333'
  const deps = (over: Partial<LinkDeps> = {}) => {
    const log: string[] = []
    const d: LinkDeps = {
      ops: new BoardOps(fakeGh([[/graphql/, issue('Todo')], [/item-edit/, '']]).gh, () => cfg),
      link: (sid, t, title, branch) => void log.push(`link ${sid} #${t.number} ${title} ${branch}`),
      branch: async () => 'acme/web@feat',
      moves: () => true,
      mark: (sid, tr) => void log.push(`mark ${sid} ${tr}`),
      reload: () => void log.push('reload'),
      noteStatus: (t, s) => void log.push(`note #${t.number} ${s}`),
      ...over,
    }
    return { d, log }
  }
  it('links, marks the linked stage, moves to In Dev when the workflow keeps ticket', async () => {
    const { d, log } = deps()
    const r = await linkTicket(d, { repo: null, number: 12 }, SID, '/tmp/x')
    expect(r).toEqual({ ok: true, message: 'linked session to #12 Fix it; #12: Todo -> In Dev' })
    expect(log).toEqual([`link ${SID} #12 Fix it acme/web@feat`, 'reload', `mark ${SID} linked`, 'note #12 In Dev'])
  })
  it('does not move when the workflow drops ticket, but still links and marks', async () => {
    const { d, log } = deps({ moves: () => false })
    const r = await linkTicket(d, { repo: null, number: 12 }, SID, null)
    expect(r).toEqual({ ok: true, message: 'linked session to #12 Fix it' })
    expect(log).toEqual([`link ${SID} #12 Fix it `, 'reload', `mark ${SID} linked`])
  })
  it('returns a failed result when the link cannot be written', async () => {
    const { d, log } = deps({ link: () => { throw new Error('EACCES') } })
    const r = await linkTicket(d, { repo: null, number: 12 }, SID, null)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/could not save the link.*EACCES/)
    expect(log).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('create-ticket.sh', () => {
  it('hands its flags to MasterDeck and prints the answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-'))
    mkdirSync(join(dir, 'requests'), { recursive: true })
    const script = join(dir, 'create-ticket.sh')
    writeFileSync(script, ticketBuilderScript(dir), { mode: 0o755 })
    const done = new Promise<string>((res) => execFile(script, ['--title', 'A "quoted" title', '--dry-run'], (_e, out) => res(out)))
    let req: string | undefined
    for (let i = 0; i < 40 && !req; i++) {
      await new Promise((r) => setTimeout(r, 100))
      req = readdirSync(join(dir, 'requests')).find((n) => n.endsWith('.req'))
    }
    expect(req).toBeDefined()
    const id = req!.slice(0, -4)
    expect(readFileSync(join(dir, 'requests', req!), 'utf8').split('\0').slice(0, -1)).toEqual(['--title', 'A "quoted" title', '--dry-run'])
    renameSync(join(dir, 'requests', req!), join(dir, 'requests', `${id}.taken`))
    writeFileSync(join(dir, 'answers', `${id}.json`), '{"ok":true,"dryRun":true}')
    expect(JSON.parse(await done)).toEqual({ ok: true, dryRun: true })
  }, 20_000)
})

describe.skipIf(process.platform === 'win32')('create-ticket.sh edge cases', () => {
  it('prints usage and exits 1 with no arguments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb0-'))
    const script = join(dir, 'c.sh')
    writeFileSync(script, ticketBuilderScript(dir), { mode: 0o755 })
    const r = await new Promise<{ code: number | null; out: string }>((res) => execFile(script, [], (e, out) => res({ code: e ? (e as { code?: number }).code ?? 1 : 0, out })))
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out).error).toMatch(/usage/)
  })
  it('exits 1 on an ok:false answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb1-'))
    mkdirSync(join(dir, 'requests'))
    const script = join(dir, 'c.sh')
    writeFileSync(script, ticketBuilderScript(dir), { mode: 0o755 })
    const done = new Promise<number>((res) => execFile(script, ['--title', 'x'], (e) => res(e ? (e as { code?: number }).code ?? 1 : 0)))
    let req: string | undefined
    for (let i = 0; i < 40 && !req; i++) { await new Promise((r) => setTimeout(r, 100)); req = readdirSync(join(dir, 'requests')).find((n) => n.endsWith('.req')) }
    writeFileSync(join(dir, 'answers', `${req!.slice(0, -4)}.json`), '{"ok":false,"error":"no"}')
    expect(await done).toBe(1)
  }, 20_000)
})

describe('bodyFileAllowed', () => {
  it('accepts only regular files really inside the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-'))
    const out = mkdtempSync(join(tmpdir(), 'bf-out-'))
    writeFileSync(join(dir, 'ok.md'), 'x')
    writeFileSync(join(out, 'secret'), 's')
    symlinkSync(join(out, 'secret'), join(dir, 'link.md'))
    mkdirSync(join(dir, 'sub'))
    expect(bodyFileAllowed(dir, 'ok.md')).toBe(join(realpathSync(dir), 'ok.md'))
    expect(bodyFileAllowed(dir, 'link.md')).toBeNull()
    expect(bodyFileAllowed(dir, '../' + out.split('/').pop() + '/secret')).toBeNull()
    expect(bodyFileAllowed(dir, join(out, 'secret'))).toBeNull()
    expect(bodyFileAllowed(dir, 'sub')).toBeNull()
    expect(bodyFileAllowed(dir, 'missing.md')).toBeNull()
  })
})

describe('sweepTicketDirs', () => {
  it('drops stale requests, old claims/answers and temp files, keeps fresh ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-'))
    mkdirSync(join(dir, 'requests')); mkdirSync(join(dir, 'answers'))
    const age = (f: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(f, t, t) }
    const mk = (sub: string, n: string, ms = 0) => { const f = join(dir, sub, n); writeFileSync(f, ''); age(f, ms) }
    mk('requests', '1-1-1.req', 3 * 60_000); mk('requests', '2-2-2.req', 10_000)
    mk('requests', '3-3-3.taken', 11 * 60_000); mk('requests', '4-4-4.taken', 60_000); mk('requests', '5-5-5.tmp')
    mk('answers', '6-6-6.json', 11 * 60_000); mk('answers', '7-7-7.json', 1000)
    sweepTicketDirs(dir)
    expect(readdirSync(join(dir, 'requests')).sort()).toEqual(['2-2-2.req', '4-4-4.taken'])
    expect(readdirSync(join(dir, 'answers'))).toEqual(['7-7-7.json'])
  })
})

describe('an account with no board', () => {
  const account = (login: string, owner: string, repo: string, projects: unknown[], primary = false) => ({
    login, name: login, email: `${login}@example.test`, owner, ownerType: 'organization', issueRepo: repo, repos: [`${owner}/${repo}`], projects, ...(primary ? { primary: true } : {}),
  })
  const bare = parseConfig({ owner: 'acme', issueRepo: 'tracker' })
  const two = parseConfig({
    owner: 'acme', issueRepo: 'tracker',
    accounts: [account('alice', 'acme', 'tracker', [{ owner: 'acme', number: 1, id: 'PVT_1', statusFieldId: 'F1', statusOptions: { Todo: 'o1' }, columns: ['Todo'] }], true), account('bob-work', 'globex', 'app', [])],
  })

  it('creates the issue with no board step, dropping status and sprint', async () => {
    const { gh, calls } = fakeGh([[/issue create/, 'https://github.com/acme/tracker/issues/7\n']])
    expect(await new BoardOps(gh, () => bare).create({ title: 'T', body: '', status: 'Todo', sprint: '@current' })).toEqual({ ok: true, url: 'https://github.com/acme/tracker/issues/7', number: 7, project: '', status: '', sprint: '' })
    expect(calls).toHaveLength(1)
    expect(await new BoardOps(gh, () => bare).create({ title: 'T', body: '', status: 'Todo', dryRun: true })).toEqual({ ok: true, dryRun: true, project: '', status: '', sprint: '' })
  })
  it("never falls back to another account's board", async () => {
    const { gh, calls } = fakeGh([[/issue create/, 'https://github.com/globex/app/issues/3\n']])
    expect(await new BoardOps(gh, () => two).create({ repo: 'globex/app', title: 'T', body: '' })).toMatchObject({ ok: true, number: 3, project: '' })
    expect(calls.some((c) => c.includes('item-add'))).toBe(false)
    // An account with a board still gets its default board, and a board named outright is used as before.
    expect(await new BoardOps(gh, () => two).create({ repo: 'acme/tracker', title: 'T', body: '', dryRun: true })).toMatchObject({ ok: true, project: 'acme/1' })
    expect(await new BoardOps(gh, () => two).create({ repo: 'globex/app', project: 'acme/1', status: 'Todo', title: 'T', body: '', dryRun: true })).toMatchObject({ ok: true, project: 'acme/1', status: 'Todo' })
  })
  it("a ticket made as an account with no board never lands on another account's board", async () => {
    // Create with Claude on bob-work's tab (no board), told to file it in alice's repo: no --project given.
    const { gh, calls } = fakeGh([[/issue create/, 'https://github.com/acme/tracker/issues/8\n']])
    expect(await new BoardOps(gh, () => two).create({ repo: 'acme/tracker', title: 'T', body: '', status: 'Todo', sprint: '@current', account: 'bob-work' })).toEqual({ ok: true, url: 'https://github.com/acme/tracker/issues/8', number: 8, project: '', status: '', sprint: '' })
    expect(calls.some((c) => c.includes('item-add'))).toBe(false)
    // A board named outright is not its own: refused before anything is created.
    const before = calls.length
    expect(await new BoardOps(gh, () => two).create({ repo: 'globex/app', project: 'acme/1', status: 'Todo', title: 'T', body: '', account: 'bob-work' })).toEqual({ ok: false, error: 'create: acme/1 is not a board of bob-work, which has no GitHub board' })
    expect(await new BoardOps(gh, () => two).create({ repo: 'globex/app', project: 'acme/1', title: 'T', body: '', account: 'bob-work', dryRun: true })).toMatchObject({ ok: false })
    expect(calls.length).toBe(before)
    // An account with a board: as before, with or without the account named.
    expect(await new BoardOps(gh, () => two).create({ repo: 'acme/tracker', title: 'T', body: '', account: 'alice', dryRun: true })).toMatchObject({ ok: true, project: 'acme/1' })
    expect(await new BoardOps(gh, () => two).create({ repo: 'globex/app', project: 'acme/1', status: 'Todo', title: 'T', body: '', account: 'alice', dryRun: true })).toMatchObject({ ok: true, project: 'acme/1', status: 'Todo' })
    // One account (no accounts list): the name is ignored, the first board is the default as ever.
    expect(await new BoardOps(gh, () => cfg).create({ title: 'T', body: '', account: 'bob-work', dryRun: true })).toMatchObject({ ok: true, project: 'acme/1' })
    // A login that is not connected says nothing about boards: the repo decides, as before.
    expect(await new BoardOps(gh, () => two).create({ repo: 'acme/tracker', title: 'T', body: '', account: 'mallory', dryRun: true })).toMatchObject({ ok: true, project: 'acme/1' })
  })
  it('links a session to an issue that has no card to move', async () => {
    const linked: string[] = []
    const moves: string[] = []
    const deps: LinkDeps = {
      ops: { issueInfo: async () => ({ title: 'Fix it', state: 'OPEN', item: null, project: null, status: '' }), move: async (_t, s) => (moves.push(s), { ok: true, message: 'moved' }) },
      link: (sid, t) => void linked.push(`${sid} #${t.number}`),
      branch: async () => '',
      moves: () => true,
      mark: () => {},
      reload: () => {},
      noteStatus: () => {},
      boardless: () => true,
    }
    expect(await linkTicket(deps, { repo: null, number: 12 }, 's1', null)).toEqual({ ok: true, message: 'linked session to #12 Fix it' })
    expect(linked).toEqual(['s1 #12'])
    expect(moves).toEqual([])
    // With a board selected, an issue that is not on it is refused as before; so is a caller from before this field.
    expect((await linkTicket({ ...deps, boardless: () => false }, { repo: null, number: 12 }, 's1', null)).message).toBe('#12 is not on any selected board')
    const { boardless: _unused, ...old } = deps
    expect((await linkTicket(old, { repo: null, number: 12 }, 's1', null)).ok).toBe(false)
    expect(linked).toEqual(['s1 #12'])
  })
})
