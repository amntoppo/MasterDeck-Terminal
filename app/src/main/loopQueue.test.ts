import { describe, expect, it } from 'vitest'
import type { LoopView } from '@shared/loops'
import type { Session } from '@shared/types'
import { LoopQueue } from './loopQueue'

const SID = 'aaaaaaaa-1111-2222-3333-444444444444'
const T = 1_760_000_000_000

const sess = (state: Session['state']): Session => ({
  key: 'k', sessionId: SID, name: 'api', kind: 'background', bgId: 'aaaaaaaa', pid: 1, cwd: '/', state, rawState: state, startedAt: 1, issue: null,
})
const view = (state: LoopView['state']): LoopView => ({
  id: 'lp', name: 'Fix', state, iteration: 2, max: 10, startedAt: 1, minutes: 0, reason: null, endedAt: state === 'open' ? null : T, lastCheck: null,
})
const open = { [SID]: [view('open')] }
const met = { [SID]: [view('met')] }

function setup(o: { queued?: number; served?: number } = {}) {
  const q = new LoopQueue()
  const tick = (loops: Record<string, LoopView[]> | undefined, state: Session['state'], now: number) =>
    q.tick(loops, [sess(state)], () => o.queued ?? 2, () => o.served, now).map((s) => s.sessionId)
  return { q, tick }
}

describe('LoopQueue: the queue goes on after a loop closes', () => {
  it('a loop that closed on an idle session hands its next queued prompt over, once', () => {
    const { tick } = setup()
    expect(tick(open, 'working', T)).toEqual([])
    // The stop went through: the deck hook saw the loop open and handed nothing over.
    expect(tick(met, 'working', T + 1000)).toEqual([])
    expect(tick(met, 'idle', T + 2000)).toEqual([SID])
    expect(tick(met, 'idle', T + 3000)).toEqual([])
  })

  it('nothing when the deck hook handed a prompt over since the loop closed', () => {
    const { tick } = setup({ served: T + 1500 })
    tick(open, 'working', T)
    tick(met, 'working', T + 1000)
    expect(tick(met, 'idle', T + 5000)).toEqual([])
  })

  it('nothing with an empty queue, a loop open again, or after the wait', () => {
    const empty = setup({ queued: 0 })
    empty.tick(open, 'working', T)
    empty.tick(met, 'idle', T + 1000)
    expect(empty.tick(met, 'idle', T + 2000)).toEqual([])
    const again = setup()
    again.tick(open, 'working', T)
    again.tick(met, 'working', T + 1000)
    expect(again.tick(open, 'idle', T + 2000)).toEqual([])
    const late = setup()
    late.tick(open, 'working', T)
    late.tick(met, 'working', T + 1000)
    expect(late.tick(met, 'idle', T + 1000 + 3 * 60_000)).toEqual([])
  })

  it('a loop already closed at the first look is not a closing', () => {
    const { tick } = setup()
    expect(tick(met, 'idle', T)).toEqual([])
    expect(tick(undefined, 'idle', T + 1000)).toEqual([])
  })
})
