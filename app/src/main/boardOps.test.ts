import { describe, expect, it } from 'vitest'
import { parseConfig, setConfig, type AppConfig } from '@shared/appConfig'
import { BoardOps, linkTicket, parseCreateArgs, type LinkDeps } from './boardOps'
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
