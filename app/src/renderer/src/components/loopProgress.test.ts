// A session's workflow loop rendered to static markup (no browser): the Details line and the session row's badge.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import type { LoopView } from '@shared/loops'
import { rowLoop } from '@shared/loops'
import { SESSIONS } from '../../../web/preview/fixture'

const NOW = Date.parse('2026-10-10T10:00:00Z')
const view = (over: Partial<LoopView> = {}): LoopView => ({
  id: 'n-tests1', name: 'Fix the tests', state: 'open', iteration: 3, max: 10, startedAt: NOW - 12 * 60_000, minutes: 0, reason: null, endedAt: null,
  lastCheck: { ran: true, passed: false, said: false, tail: '2 failed', at: NOW - 60_000 }, ...over,
})

const g = globalThis as Record<string, unknown>
let LoopProgress: typeof import('./SessionWorkflow').LoopProgress
let SessionRow: typeof import('./Sidebar').SessionRow
let LoopRound: typeof import('./SessionWorkflow').LoopRound
beforeAll(async () => {
  g.localStorage = { getItem: () => null, setItem: () => {} }
  g.window ??= { deck: { platform: 'darwin' }, addEventListener: () => {}, removeEventListener: () => {} }
  g.document ??= { body: {} }
  LoopProgress = (await import('./SessionWorkflow')).LoopProgress
  SessionRow = (await import('./Sidebar')).SessionRow
  LoopRound = (await import('./SessionWorkflow')).LoopRound
})

const details = (loops?: LoopView[]) => renderToStaticMarkup(createElement(LoopProgress, { sessionId: 's1', loops, now: NOW }))
const row = (loops?: LoopView[]) =>
  renderToStaticMarkup(createElement(SessionRow, { s: SESSIONS[0], active: false, now: NOW, onClick: () => {}, loop: rowLoop(loops, NOW) }))

describe('loop progress in Details', () => {
  it('an open loop: its line, pulsing, with History and Stop loop', () => {
    const html = details([view()])
    expect(html).toContain('↻ Fix the tests · iteration 3/10 · 12 min · last check failed')
    expect(html).toContain('wfw-dot live')
    expect(html).toContain('History')
    expect(html).toContain('Stop loop')
  })

  it('a loop at its limit: the reason, History, no Stop loop', () => {
    const html = details([view({ state: 'limit', reason: 'stopped after 10 iterations', endedAt: NOW - 60_000 })])
    expect(html).toContain('↻ Fix the tests · stopped after 10 iterations')
    expect(html).toContain('History')
    expect(html).not.toContain('Stop loop')
    expect(html).not.toContain('live')
  })

  it('nothing without loops', () => {
    expect(details(undefined)).toBe('')
    expect(details([])).toBe('')
  })
})

describe('a round in History', () => {
  const round = { n: 2, at: NOW, ms: 1200, passed: false, said: false, exit: 1, tail: '2 failed', hash: 'h' }
  it("shows the round's PROGRESS line under its summary, as text", () => {
    const html = renderToStaticMarkup(createElement(LoopRound, { c: { ...round, progress: 'fixed <b>the</b> encoder' } }))
    expect(html).toContain('<div class="wfl-round-prog">fixed &lt;b&gt;the&lt;/b&gt; encoder</div>')
    expect(renderToStaticMarkup(createElement(LoopRound, { c: round }))).not.toContain('wfl-round-prog')
  })
})

describe('the session row badge', () => {
  it('the count while open, its line as the tooltip', () => {
    const html = row([view()])
    expect(html).toContain('<span class="srow-loop " title="↻ Fix the tests · iteration 3/10 · 12 min · last check failed">↻ 3/10</span>')
  })

  it('↻ ! for a loop at its limit within the hour', () => {
    expect(row([view({ state: 'limit', endedAt: NOW - 60_000 })])).toContain('class="srow-loop limit"')
  })

  it('no badge without loops', () => {
    expect(row(undefined)).not.toContain('srow-loop')
    expect(row([view({ state: 'stopped', endedAt: NOW })])).not.toContain('srow-loop')
  })
})
