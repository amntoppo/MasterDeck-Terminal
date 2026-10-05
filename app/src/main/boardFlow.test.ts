import { describe, expect, it } from 'vitest'
import { parseConfig, setConfig } from '@shared/appConfig'
import { emptyLinks, withLink, withPr, type LinkFile } from '@shared/ticketLinks'
import type { AppState, Session } from '@shared/types'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileFlow, edgeId, type CompiledStep, type FlowNode } from '@shared/flow'
import { BoardFlow, LinkedSteps, type BoardFlowDeps } from './boardFlow'

setConfig(parseConfig({
  owner: 'acme', issueRepo: 'tracker',
  projects: [{ owner: 'acme', number: 1, id: 'P', statusFieldId: 'F', statusOptions: { Todo: '1', 'In Dev': '2', 'PR Raised': '3', 'Dev Done': '4' }, columns: ['Todo', 'In Dev', 'PR Raised', 'Dev Done'], statuses: { ready: 'Todo', inProgress: 'In Dev', prRaised: 'PR Raised', devDone: 'Dev Done' } }],
}))
const SID = '44444444-4444-4444-8444-444444444444'
const PR = 'https://github.com/acme/web/pull/5'
const sess = (over: Partial<Session> = {}): Session => ({ key: 'k1', sessionId: SID, name: 'fix-12', kind: 'background', bgId: 'k1', pid: 1, cwd: '/w', state: 'idle', rawState: 'idle', startedAt: 0, issue: 12, ...over })

function setup(file: LinkFile, prs: Record<string, { state: string; isDraft: boolean }>) {
  const moves: string[] = []
  const linked: string[] = []
  const prLinks: string[] = []
  let f = file
  const deps: BoardFlowDeps = {
    ops: {
      move: async (t, s) => (moves.push(`#${t.number} ${s}`), { ok: true, message: 'moved' }),
      linkPr: async (_t, url) => (prLinks.push(url), true),
    },
    links: { read: () => f, addPr: (sid, url) => (f = withPr(f, sid, url)) },
    prStates: async (urls) => Object.fromEntries(urls.filter((u) => prs[u]).map((u) => [u, prs[u]])),
    link: async (t, sid) => (linked.push(`${sid} #${t.number}`), { ok: true, message: 'linked' }),
    builtinOn: () => true,
    onMoved: () => {},
    createdPrs: () => [PR, 'https://github.com/acme/web/pull/6'],
  }
  return { flow: new BoardFlow(deps), moves, linked, prLinks, deps }
}
const state = (over: Partial<AppState>): AppState =>
  ({ sessions: [sess()], sessionPrs: {}, proposals: [], board: { cards: [{ number: 12, repo: null, project: 'acme/1', title: 't', url: '', status: 'In Dev', prs: [], assignees: [], labels: [], milestone: null, type: null }] }, issues: [], ...over }) as unknown as AppState

describe('BoardFlow', () => {
  it('records and links a new PR of a linked session, then moves to PR Raised once it is ready', async () => {
    const { flow, moves, prLinks } = setup(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), { [PR]: { state: 'OPEN', isDraft: true } })
    await flow.tick(state({ sessionPrs: { [SID]: [PR] } }), 0)
    expect(prLinks).toEqual([PR])
    expect(moves).toEqual([]) // a draft
    const ready = setup(withPr(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), SID, PR), { [PR]: { state: 'OPEN', isDraft: false } })
    await ready.flow.tick(state({ sessionPrs: { [SID]: [PR] } }), 0)
    expect(ready.moves).toEqual(['#12 PR Raised'])
    expect(ready.prLinks).toEqual([]) // already recorded
  })
  it('moves to Dev Done when every PR is merged; never twice; not when the card is already there', async () => {
    const base = withPr(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), SID, PR)
    const { flow, moves } = setup(base, { [PR]: { state: 'MERGED', isDraft: false } })
    await flow.tick(state({}), 0)
    await flow.tick(state({}), 31_000)
    expect(moves).toEqual(['#12 Dev Done'])
    const there = setup(base, { [PR]: { state: 'MERGED', isDraft: false } })
    await there.flow.tick(state({ board: { cards: [{ number: 12, repo: null, project: 'acme/1', status: 'Dev Done' }] } as never }), 0)
    expect(there.moves).toEqual([])
  })
  it('links a session master spawned for an issue', async () => {
    const { flow, linked } = setup(emptyLinks(), {})
    await flow.tick(state({ sessions: [sess({ issue: null })], proposals: [{ id: 1, kind: 'ASSIGN', issue: 12, status: 'sent', summary: '', message: '', note: null, target: { spawn: { name: 'fix-12' } } }] }), 0)
    expect(linked).toEqual([`${SID} #12`])
  })
  it('does nothing for sessions whose workflow left the ticket built-in out', async () => {
    const s = setup(withPr(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), SID, PR), { [PR]: { state: 'MERGED', isDraft: false } })
    s.deps.builtinOn = () => false
    await new BoardFlow(s.deps).tick(state({}), 0)
    expect(s.moves).toEqual([])
  })
})

describe('BoardFlow errors', () => {
  it('a link file that cannot be written is logged; the other PRs still go on', async () => {
    const other = '55555555-5555-4555-8555-555555555555'
    const PR2 = 'https://github.com/acme/web/pull/6'
    const f = withLink(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), other, { repo: null, number: 13 }, 't', '', new Date(0))
    const s = setup(f, {})
    const logs: string[] = []
    s.deps.log = (m) => logs.push(m)
    const addPr = s.deps.links.addPr
    s.deps.links.addPr = (sid, url) => {
      if (sid === SID) throw new Error('EACCES')
      addPr(sid, url)
    }
    await new BoardFlow(s.deps).tick(state({ sessionPrs: { [SID]: [PR], [other]: [PR2] } }), 0)
    expect(s.prLinks).toEqual([PR2])
    expect(logs.join()).toMatch(/EACCES/)
  })
})

describe('LinkedSteps', () => {
  const step = (id: string, trigger: CompiledStep['trigger'], note: string): CompiledStep => ({ id, trigger, note })
  function make(steps: Record<string, CompiledStep[]>, dir = mkdtempSync(join(tmpdir(), 'ls-'))) {
    const sent: string[] = []
    const runs: string[] = []
    const ls = new LinkedSteps({
      file: join(dir, 'linked-steps.json'),
      markDir: dir,
      steps: (sid) => steps[sid] ?? [],
      send: async (s, text) => (sent.push(`${s.name}: ${text}`), { ok: true, message: 'sent' }),
      logRun: (sid, trigger, ids) => runs.push(`${sid} ${trigger} ${ids.join(' ')}`),
    })
    return { ls, sent, runs, dir }
  }
  const linked = { [SID]: [step('a1', 'linked', 'Read the issue.'), step('i1', 'idle', 'Nudge.'), step('b2', 'linked', 'Plan it.')] }

  it('delivers the linked steps once, after the turn', async () => {
    const { ls, sent, runs } = make(linked)
    ls.queue(SID)
    await ls.deliver([sess({ state: 'working' })])
    expect(sent).toEqual([])
    await ls.deliver([sess()])
    expect(sent).toEqual(['fix-12: Read the issue.\n\nPlan it.'])
    expect(runs).toEqual([`${SID} linked a1 b2`])
    ls.queue(SID) // linked again
    await ls.deliver([sess()])
    expect(sent).toHaveLength(1)
  })
  it('sends nothing when the workflow has no linked step, or the session copy left it out', async () => {
    const none = make({ [SID]: [step('i1', 'idle', 'Nudge.')] })
    none.ls.queue(SID)
    await none.ls.deliver([sess()])
    expect(none.sent).toEqual([])
    const other = '55555555-5555-4555-8555-555555555555'
    const lacks = make({ [other]: linked[SID] })
    lacks.ls.queue(SID)
    await lacks.ls.deliver([sess()])
    expect(lacks.sent).toEqual([])
  })
  it('survives a restart: a pending delivery still goes, a done one is not resent', async () => {
    const first = make(linked)
    first.ls.queue(SID)
    const second = make(linked, first.dir)
    await second.ls.deliver([sess()])
    expect(second.sent).toHaveLength(1)
    const third = make(linked, first.dir)
    third.ls.queue(SID)
    await third.ls.deliver([sess()])
    expect(third.sent).toEqual([])
  })
  it('drops a pending delivery once the session ended', async () => {
    const { ls, sent, dir } = make(linked)
    ls.queue(SID)
    await ls.deliver([sess({ state: 'done' })])
    await make(linked, dir).ls.deliver([sess()])
    expect(sent).toEqual([])
  })
})

describe('BoardFlow fix round 1', () => {
  const S2 = '55555555-5555-4555-8555-555555555555'
  const S3 = '66666666-6666-4666-8666-666666666666'
  const PR2 = 'https://github.com/acme/web/pull/6'
  const PR3 = 'https://github.com/acme/web/pull/7'
  const card = (number: number, status: string) => ({ number, repo: null, project: 'acme/1', status })
  it('reads every ticket\'s PR states in one call, leaving out tickets already at Dev Done', async () => {
    let f = withLink(withLink(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), S2, { repo: null, number: 13 }, 't', '', new Date(0)), S3, { repo: null, number: 14 }, 't', '', new Date(0))
    f = withPr(withPr(withPr(f, SID, PR), S2, PR2), S3, PR3)
    const s = setup(f, { [PR]: { state: 'OPEN', isDraft: false }, [PR2]: { state: 'MERGED', isDraft: false }, [PR3]: { state: 'MERGED', isDraft: false } })
    const calls: string[][] = []
    const inner = s.deps.prStates
    s.deps.prStates = (urls) => (calls.push(urls), inner(urls))
    await new BoardFlow(s.deps).tick(state({ board: { cards: [card(12, 'In Dev'), card(13, 'In Dev'), card(14, 'Dev Done')] } as never }), 0)
    expect(calls).toEqual([[PR, PR2]])
    expect(s.moves).toEqual(['#12 PR Raised', '#13 Dev Done'])
  })
  it('skips a ticket whose board is not known yet', async () => {
    const s = setup(withPr(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), SID, PR), { [PR]: { state: 'MERGED', isDraft: false } })
    await s.flow.tick(state({ board: { cards: [] } as never }), 0)
    expect(s.moves).toEqual([])
  })
  it('logs a PR it could not link under Development', async () => {
    const s = setup(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), {})
    const logs: string[] = []
    s.deps.log = (m) => logs.push(m)
    s.deps.ops.linkPr = async () => false
    await new BoardFlow(s.deps).tick(state({ sessionPrs: { [SID]: [PR] } }), 0)
    expect(logs.join()).toContain(PR)
  })
  it('remembers across a restart which sessions it already tried to link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-'))
    const s = setup(emptyLinks(), {})
    s.deps.linkTriedFile = join(dir, 'tried.json')
    const st = state({ sessions: [sess({ issue: null })], proposals: [{ id: 1, kind: 'ASSIGN', issue: 12, status: 'sent', summary: '', message: '', note: null, target: { spawn: { name: 'fix-12' } } }] as never })
    await new BoardFlow(s.deps).tick(st, 0)
    await new BoardFlow(s.deps).tick(st, 0)
    expect(s.linked).toEqual([`${SID} #12`])
  })
})

describe('LinkedSteps fix round 1', () => {
  it('sends exactly what the hook would add (the compiled notes, no extra header)', async () => {
    const at = { x: 0, y: 0 }
    const { steps } = compileFlow({
      nodes: [{ id: 'l', ...at, kind: 'trigger', trigger: 'linked' } as FlowNode, { id: 'i', ...at, kind: 'instruction', text: 'Read the issue.' } as FlowNode],
      edges: [{ id: edgeId('l', 'i'), from: 'l', to: 'i', kind: 'then' }],
    })
    expect(steps).toHaveLength(1)
    const dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const sent: string[] = []
    const ls = new LinkedSteps({ file: join(dir, 'p.json'), markDir: dir, steps: () => steps, send: async (_s, t) => (sent.push(t), { ok: true, message: '' }), logRun: () => {} })
    ls.queue(SID)
    await ls.deliver([sess()])
    expect(sent).toEqual([steps[0].note])
    expect(sent[0]).toMatch(/^Workflow step \(when a session is linked to its issue\):\n/)
  })
  it('a marker that cannot be written still logs the run and is not sent again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const sent: string[] = []
    const runs: string[] = []
    const mk = () => new LinkedSteps({
      file: join(dir, 'p.json'), markDir: join(dir, 'missing'),
      steps: () => [{ id: 'a1', trigger: 'linked', note: 'N' }],
      send: async (_s, t) => (sent.push(t), { ok: true, message: '' }),
      logRun: (sid) => runs.push(sid),
      log: () => {},
    })
    const ls = mk()
    ls.queue(SID)
    await ls.deliver([sess()])
    await ls.deliver([sess()])
    await mk().deliver([sess()])
    expect(sent).toEqual(['N'])
    expect(runs).toEqual([SID])
  })
})

describe('BoardFlow final review', () => {
  const linked = () => withPr(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', 'acme/web@feat-12', new Date(0)), SID, PR)
  it('never re-pushes a card the user moved back, even after a restart: done moves are kept on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-'))
    const s = setup(linked(), { [PR]: { state: 'OPEN', isDraft: false } })
    s.deps.movedFile = join(dir, 'moved.json')
    await new BoardFlow(s.deps).tick(state({}), 0)
    expect(s.moves).toEqual(['#12 PR Raised'])
    // Moved back to In Dev by hand (the card still says In Dev): not again, not after a restart.
    const flow = new BoardFlow(s.deps)
    await flow.tick(state({}), 0)
    await flow.tick(state({}), 2 * 30 * 60_000)
    expect(s.moves).toEqual(['#12 PR Raised'])
  })
  it('a reopened ticket with a new PR moves again (a done move is per ticket, target and PR set)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-'))
    const PR6 = 'https://github.com/acme/web/pull/6'
    const s = setup(linked(), { [PR]: { state: 'OPEN', isDraft: false }, [PR6]: { state: 'OPEN', isDraft: false } })
    s.deps.movedFile = join(dir, 'moved.json')
    await new BoardFlow(s.deps).tick(state({}), 0)
    const more = withPr(linked(), SID, PR6)
    s.deps.links = { read: () => more, addPr: () => {} }
    await new BoardFlow(s.deps).tick(state({}), 0)
    expect(s.moves).toEqual(['#12 PR Raised', '#12 PR Raised'])
  })
  it('a move that found the card already there (or left it) counts as done; a failure retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-'))
    const s = setup(linked(), { [PR]: { state: 'OPEN', isDraft: false } })
    s.deps.movedFile = join(dir, 'moved.json')
    s.deps.ops.move = async (t, st) => (s.moves.push(`#${t.number} ${st}`), { ok: true, message: 'already at PR Raised' })
    await new BoardFlow(s.deps).tick(state({}), 0)
    await new BoardFlow(s.deps).tick(state({}), 31 * 60_000)
    expect(s.moves).toEqual(['#12 PR Raised'])
    const f = setup(linked(), { [PR]: { state: 'OPEN', isDraft: false } })
    f.deps.movedFile = join(dir, 'moved-f.json')
    f.deps.ops.move = async (t, st) => (f.moves.push(`#${t.number} ${st}`), { ok: false, message: 'no access' })
    const flow = new BoardFlow(f.deps)
    await flow.tick(state({}), 0)
    await flow.tick(state({}), 31 * 60_000)
    expect(f.moves).toEqual(['#12 PR Raised', '#12 PR Raised'])
  })
  it('imported links are history: no PRs recorded or moves made until a session re-links the ticket', async () => {
    const imported = { ...linked(), sessions: { [SID]: { ...linked().sessions[SID], imported: true } } }
    const s = setup(imported, { [PR]: { state: 'MERGED', isDraft: false }, 'https://github.com/acme/web/pull/6': { state: 'OPEN', isDraft: false } })
    await s.flow.tick(state({ sessionPrs: { [SID]: ['https://github.com/acme/web/pull/6'] } }), 0)
    expect(s.moves).toEqual([])
    expect(s.prLinks).toEqual([])
  })
  it('records only PRs the session created or that are on its linked branch; a cwd-branch PR stays display-only', async () => {
    const PR7 = 'https://github.com/acme/web/pull/7'
    const PR8 = 'https://github.com/acme/web/pull/8'
    const s = setup(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', 'acme/web@feat-12', new Date(0)), {})
    s.deps.createdPrs = (sid) => (sid === SID ? [PR] : [])
    const prLive = { [PR7]: { headRef: 'feat-12' }, [PR8]: { headRef: 'main' } }
    await new BoardFlow(s.deps).tick(state({ sessionPrs: { [SID]: [PR, PR7, PR8] }, prLive } as never), 0)
    expect(s.prLinks).toEqual([PR, PR7])
  })
  it('a ticket of an account with no board is never moved, read or retried', async () => {
    const base = withPr(withLink(emptyLinks(), SID, { repo: null, number: 12 }, 't', '', new Date(0)), SID, PR)
    const s = setup(base, { [PR]: { state: 'MERGED', isDraft: false } })
    let reads = 0
    const inner = s.deps.prStates
    s.deps.prStates = async (urls) => (reads++, inner(urls))
    const flow = new BoardFlow(s.deps)
    // Its card has no board (project null): there is nothing to move, whatever its PRs say.
    const derived = { cards: [{ number: 12, repo: null, project: null, derived: true, state: 'OPEN', status: 'Done' }] } as never
    await flow.tick(state({ board: derived }), 0)
    await flow.tick(state({ board: derived }), 31_000)
    await flow.tick(state({ board: derived }), 31 * 60_000)
    expect(s.moves).toEqual([])
    expect(reads).toBe(0)
  })
})
