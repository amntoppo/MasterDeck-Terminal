import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyFreshness, FRESH_WINDOW_MS, mapState, normalizeAgents } from './agents'

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../test/fixtures/agents.json'), 'utf8'))

describe('mapState', () => {
  it('maps the known raw values', () => {
    expect(mapState('blocked')).toBe('needs-input')
    expect(mapState('running')).toBe('working')
    expect(mapState('busy')).toBe('working')
    expect(mapState('idle')).toBe('idle')
    expect(mapState('completed')).toBe('done')
  })
  it('treats unknown values as idle', () => {
    expect(mapState('mystery')).toBe('idle')
  })
})

describe('normalizeAgents', () => {
  it('parses the captured real output', () => {
    const s = normalizeAgents(fixture)
    expect(s.length).toBe(fixture.length)
    const master = s.find((x) => x.name === 'master-agent')!
    expect(master.kind).toBe('interactive')
    expect(master.bgId).toBeNull()
    const bg = s.find((x) => x.kind === 'background')!
    expect(bg.bgId).toMatch(/^[0-9a-f]{8}$/)
  })
  it('keeps the raw value of an unknown state', () => {
    const [s] = normalizeAgents([{ sessionId: 'abc12345-x', kind: 'background', id: 'abc12345', state: 'weird' }])
    expect(s.state).toBe('idle')
    expect(s.rawState).toBe('weird')
  })
  it('falls back to the id prefix when a row has no name', () => {
    const [s] = normalizeAgents([{ sessionId: 'ea39fd38-be85', kind: 'background', id: 'ea39fd38', state: 'blocked' }])
    expect(s.name).toBe('ea39fd38')
  })
  it('drops rows without a sessionId and ignores non-arrays', () => {
    expect(normalizeAgents([{ name: 'x' }, null, 3])).toEqual([])
    expect(normalizeAgents({ not: 'an array' })).toEqual([])
  })
})

describe('resumed background sessions', () => {
  // Real row after `claude attach` resumed a parked session: new sessionId, same id, live status.
  const row = { pid: 61578, id: '4ece16d2', kind: 'background', startedAt: 1, sessionId: 'b125e8ba-ea27', name: 'app-cancellation-flow', status: 'idle', state: 'blocked' }
  it('keys by the background id and trusts the live status', () => {
    const [s] = normalizeAgents([row])
    expect(s.key).toBe('4ece16d2')
    expect(s.state).toBe('idle')
    expect(s.rawState).toBe('idle')
  })
  it('a live done-state row with an idle process is idle', () => {
    const [s] = normalizeAgents([{ ...row, state: 'done' }])
    expect(s.state).toBe('idle')
  })
  it('interactive sessions are keyed by sessionId', () => {
    const [s] = normalizeAgents([{ pid: 1, kind: 'interactive', sessionId: 'abc', status: 'busy' }])
    expect(s.key).toBe('abc')
  })
})

describe('applyFreshness', () => {
  const [bg] = normalizeAgents([{ sessionId: 's1', kind: 'background', id: 's1', state: 'blocked' }])
  const now = 10 * FRESH_WINDOW_MS
  it('keeps a recently written blocked session as needs-input', () => {
    expect(applyFreshness([bg], { s1: now - 1000 }, now)[0].state).toBe('needs-input')
  })
  it('turns a quiet or transcript-less blocked session into suspended', () => {
    expect(applyFreshness([bg], { s1: now - FRESH_WINDOW_MS - 1 }, now)[0].state).toBe('suspended')
    expect(applyFreshness([bg], {}, now)[0].state).toBe('suspended')
  })
})
