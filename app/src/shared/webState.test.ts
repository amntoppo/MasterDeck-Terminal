import { describe, expect, it } from 'vitest'
import type { AppState, Proposal } from './types'
import { fitWebState, WEB_STATE_BUDGET } from './webState'

const prompt = 'p'.repeat(20_000)
const prop = (id: number, status: string): Proposal => ({
  id, kind: 'ASSIGN', issue: id, status, summary: `s${id}`, message: prompt, note: `n${id}`, target: { spawn: { name: `t${id}`, prompt, cwd: '/w' } },
})
const pr = (n: number, state: 'open' | 'merged' | 'closed') => ({ url: `https://github.com/acme/api/pull/${n}`, number: n, state, title: 't'.repeat(600) })
const make = (over: Partial<AppState> = {}): AppState =>
  ({ sessions: [{ key: 'a' }], proposals: [], teamPrs: [], inbox: { open: [], snoozed: [], history: [] }, pastSessions: {}, ...over }) as unknown as AppState

describe('fitWebState (#168: the web never gets a state it cannot be sent)', () => {
  it('a small state goes as it is, with no cut', () => {
    const s = make({ proposals: [prop(1, 'proposed')] })
    const f = fitWebState(s)
    expect(f.cut).toEqual([])
    expect(f.tooLarge).toBe(false)
    expect(f.state.webCut).toBeUndefined()
    expect(f.state.proposals[0].message).toBe(prompt)
    expect(JSON.parse(f.json)).toEqual(f.state)
  })

  it('finished proposals always lose their prompt; open ones keep it', () => {
    const f = fitWebState(make({ proposals: [prop(1, 'done'), prop(2, 'rejected'), prop(3, 'sent'), prop(4, 'question')] }))
    expect(f.state.proposals.map((p) => p.message.length)).toEqual([0, 0, prompt.length, prompt.length])
    expect(f.state.proposals[0].target.spawn).toEqual({ name: 't1', cwd: '/w' })
    expect(f.state.proposals[0]).toMatchObject({ summary: 's1', note: 'n1' })
    expect(f.cut).toEqual([])
  })

  it('the shape of the real Mac (#168): 1.2 MB of long ledger fits without cutting anything else', () => {
    const proposals = [...Array.from({ length: 46 }, (_, i) => prop(i, 'done')), ...Array.from({ length: 10 }, (_, i) => prop(100 + i, 'sent'))]
    const teamPrs = Array.from({ length: 400 }, (_, i) => pr(i, i % 4 ? 'merged' : 'open'))
    const s = make({ proposals, teamPrs } as Partial<AppState>)
    expect(JSON.stringify(s).length).toBeGreaterThan(1_200_000)
    const f = fitWebState(s)
    expect(f.bytes).toBeLessThanOrEqual(WEB_STATE_BUDGET)
    expect(f.cut).toEqual([])
    expect(f.state.teamPrs).toHaveLength(400)
  })

  it('still over: cuts closed PRs, then finished proposals, then history, and says so', () => {
    const teamPrs = Array.from({ length: 1000 }, (_, i) => pr(i, i % 20 ? 'merged' : 'open'))
    const proposals = [...Array.from({ length: 200 }, (_, i) => prop(10 + i, 'done')), prop(2, 'proposed')]
    const f = fitWebState(make({ teamPrs, proposals } as Partial<AppState>), 90_000)
    expect(f.cut).toEqual(['teamPrsClosed', 'proposalsClosed'])
    expect(f.state.webCut).toEqual(['teamPrsClosed', 'proposalsClosed'])
    expect(f.state.teamPrs.every((p) => p.state === 'open')).toBe(true)
    expect(f.state.proposals.map((p) => p.id)).toEqual([2])
    expect(f.bytes).toBeLessThanOrEqual(90_000)
    expect(JSON.parse(f.json)).toEqual(f.state)
  })

  it('nothing to cut: tooLarge, the bridge sends a notice instead', () => {
    const f = fitWebState(make({ sessions: [{ key: 'x'.repeat(300_000) }] } as unknown as Partial<AppState>), 100_000)
    expect(f.tooLarge).toBe(true)
    expect(f.cut).toEqual(['teamPrsClosed', 'proposalsClosed', 'inboxHistory', 'pastSessions'])
  })

  it('does not change the state it was given', () => {
    const s = make({ proposals: [prop(1, 'done')] })
    fitWebState(s, 10)
    expect(s.proposals[0].message).toBe(prompt)
    expect(s.webCut).toBeUndefined()
  })
})
