import { describe, expect, it } from 'vitest'
import type { CompiledLoop } from './flow'
import { loopBadge, loopLine, loopNudge, loopViews, parseLoopFile, type LoopView } from './loops'

const NOW = 1_760_000_000_000
const H = 3600_000

const def = (over: Partial<CompiledLoop> = {}): CompiledLoop => ({
  id: 'lp',
  name: 'Fix',
  check: { command: 'npm test', output: '', outputMode: 'match', timeoutMin: 5 },
  agentDone: { on: false, goal: '' },
  limits: { iterations: 10, minutes: 0, stall: 0 },
  plan: '1. Fix.',
  met: '',
  limit: '',
  then: '',
  after: null,
  ...over,
})

const check = (over: Record<string, unknown> = {}) => ({ n: 1, at: NOW - 1000, ms: 10, passed: false, said: false, exit: 1, tail: 'FAIL', hash: 'h', ...over })
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'lp', step: 's', state: 'open', iteration: 0, startedAt: NOW - 60_000, history: [], reason: null, lastCheck: null, ...over,
})

const view = (over: Partial<LoopView> = {}): LoopView => ({
  id: 'lp', name: 'Fix', state: 'open', iteration: 3, max: 10, startedAt: NOW - 12 * 60_000, minutes: 0, reason: null, endedAt: null,
  lastCheck: { ran: true, passed: false, said: false, tail: 'FAIL', at: NOW }, ...over,
})

describe('parseLoopFile', () => {
  it('drops junk entries and unknown states, never throws', () => {
    for (const raw of [null, 3, 'x', [], { loops: 'no' }, { loops: null }]) expect(parseLoopFile(raw)).toEqual({ loops: [] })
    const f = parseLoopFile({
      loops: [
        entry(),
        entry({ id: 'b', state: 'running' }),
        entry({ id: 'BAD ID' }),
        entry({ id: 'c', startedAt: 'yesterday' }),
        7,
        null,
        entry({ id: 'd', state: 'limit', extra: 5, stallFrom: 3, history: [check(), 'junk', { n: 'x' }], lastCheck: check({ exit: null }) }),
      ],
    })
    expect(f.loops.map((e) => e.id)).toEqual(['lp', 'd'])
    expect(f.loops[1]).toMatchObject({ extra: 5, stallFrom: 3, history: [check()], lastCheck: { exit: null } })
  })
})

describe('loopViews', () => {
  it('names and limits from the workflow, with what Run 5 more added', () => {
    const v = loopViews(parseLoopFile({ loops: [entry({ iteration: 3, extra: 5, lastCheck: check() })] }), [def({ limits: { iterations: 10, minutes: 30, stall: 0 } })], NOW)
    expect(v).toEqual([
      { id: 'lp', name: 'Fix', state: 'open', iteration: 3, max: 15, startedAt: NOW - 60_000, minutes: 30, reason: null, endedAt: null, lastCheck: { ran: true, passed: false, said: false, tail: 'FAIL', at: NOW - 1000 } },
    ])
  })

  it('a loop its workflow no longer has keeps its id as its name', () => {
    expect(loopViews(parseLoopFile({ loops: [entry()] }), [], NOW)[0]).toMatchObject({ name: 'lp', max: 0 })
  })

  it('at most 3 per session, newest first; closed ones older than a day dropped; tail cut to 1 KB', () => {
    const loops = [
      entry({ id: 'a', startedAt: NOW - 5 * H }),
      entry({ id: 'b', startedAt: NOW - 4 * H, state: 'met', lastCheck: check({ at: NOW - 3 * H }) }),
      entry({ id: 'c', startedAt: NOW - 3 * H, state: 'stopped', endedAt: NOW - 2 * H }),
      entry({ id: 'd', startedAt: NOW - 2 * H, state: 'limit', lastCheck: check({ at: NOW - 1 * H, tail: 'x'.repeat(3000) + 'END' }) }),
      entry({ id: 'old', startedAt: NOW - 30 * H, state: 'met', lastCheck: check({ at: NOW - 25 * H }) }),
    ]
    const v = loopViews(parseLoopFile({ loops }), [], NOW)
    expect(v.map((x) => x.id)).toEqual(['d', 'c', 'b'])
    expect(v[0].lastCheck?.tail.length).toBe(1024)
    expect(v[0].lastCheck?.tail.endsWith('END')).toBe(true)
    expect(v[0].endedAt).toBe(NOW - H)
    expect(v[1].endedAt).toBe(NOW - 2 * H)
  })

  it('an open loop stays however old', () => {
    expect(loopViews(parseLoopFile({ loops: [entry({ startedAt: NOW - 48 * H })] }), [], NOW)).toHaveLength(1)
  })
})

describe('loopLine', () => {
  it('open: iteration, minutes, the last check', () => {
    expect(loopLine(view(), NOW)).toBe('↻ Fix · iteration 3/10 · 12 min · last check failed')
    expect(loopLine(view({ lastCheck: { ran: true, passed: true, said: true, tail: '', at: NOW } }), NOW)).toContain('last check passed')
    expect(loopLine(view({ lastCheck: { ran: false, passed: false, said: false, tail: '', at: NOW } }), NOW)).toContain('not done yet')
    expect(loopLine(view({ iteration: 0, lastCheck: null }), NOW)).toBe('↻ Fix · iteration 0/10 · 12 min · first round')
  })

  it('closed: how it ended', () => {
    expect(loopLine(view({ state: 'met', iteration: 4, reason: 'criterion met after 4 iterations' }), NOW)).toBe('↻ Fix · done: criterion met after 4 iterations')
    expect(loopLine(view({ state: 'limit', reason: 'stopped: 10/10 iterations, `npm test` still failing' }), NOW)).toBe('↻ Fix · stopped: 10/10 iterations, `npm test` still failing')
    expect(loopLine(view({ state: 'stopped', reason: 'stopped by you' }), NOW)).toBe('↻ Fix · stopped by you')
  })
})

describe('loopBadge', () => {
  it('open: the count; met or at a limit within the hour; else nothing', () => {
    expect(loopBadge(view(), NOW)).toBe('↻ 3/10')
    expect(loopBadge(view({ state: 'met', endedAt: NOW - 10 * 60_000 }), NOW)).toBe('↻ ✓')
    expect(loopBadge(view({ state: 'limit', endedAt: NOW - 10 * 60_000 }), NOW)).toBe('↻ !')
    expect(loopBadge(view({ state: 'met', endedAt: NOW - 2 * H }), NOW)).toBeNull()
    expect(loopBadge(view({ state: 'limit', endedAt: NOW - 2 * H }), NOW)).toBeNull()
    expect(loopBadge(view({ state: 'stopped', endedAt: NOW }), NOW)).toBeNull()
  })
})

describe('loopNudge', () => {
  it('fixed text; the name never starts a command and carries no control characters', () => {
    expect(loopNudge('Fix the tests')).toBe('Continue the loop "Fix the tests".')
    expect(loopNudge('/compact\nnow')).toBe('Continue the loop "compact now".')
    expect(loopNudge('  !rm -rf "x"\u0007')).toBe(`Continue the loop "rm -rf 'x'".`)
    expect(loopNudge('')).toBe('Continue the loop "loop".')
  })
})
