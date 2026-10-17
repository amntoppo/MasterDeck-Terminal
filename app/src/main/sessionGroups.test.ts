import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionGroupStore } from './sessionGroups'

const dir = () => mkdtempSync(join(tmpdir(), 'groups-'))

describe('SessionGroupStore', () => {
  it('round-trips tabs and assignments through the file', () => {
    const f = join(dir(), 'session-groups.json')
    const s = new SessionGroupStore(f)
    const r = s.act({ op: 'add', name: 'Backend' })
    expect(r.ok).toBe(true)
    expect(s.act({ op: 'assign', key: 'abcd1234', group: r.id }).ok).toBe(true)
    const t = new SessionGroupStore(f)
    expect(t.all()).toEqual({ groups: [{ id: r.id, name: 'Backend' }], of: { abcd1234: r.id } })
    expect(JSON.parse(readFileSync(f, 'utf8')).version).toBe(1)
    expect(readdirSync(dirname(f)).some((n) => n.endsWith('.tmp'))).toBe(false)
  })
  it('refuses a bad op without writing', () => {
    const f = join(dir(), 'session-groups.json')
    const s = new SessionGroupStore(f)
    expect(s.act({ op: 'add', name: '  ' })).toEqual({ ok: false, message: 'Name the tab.' })
    expect(() => readFileSync(f)).toThrow()
  })
  it('moves a corrupt file aside and starts empty', () => {
    const d = dir()
    const f = join(d, 'session-groups.json')
    writeFileSync(f, '{not json')
    const s = new SessionGroupStore(f, () => 7)
    expect(s.all()).toEqual({ groups: [], of: {} })
    expect(readdirSync(d)).toContain('session-groups.json.corrupt-7')
  })
  it('carries a copy and prunes after the grace', () => {
    let now = 0
    const f = join(dir(), 'session-groups.json')
    const s = new SessionGroupStore(f, () => now)
    const id = s.act({ op: 'add', name: 'A' }).id
    s.act({ op: 'assign', key: 'old00000', group: id })
    s.carry('old00000', 'new00000')
    expect(new SessionGroupStore(f).all().of).toEqual({ new00000: id })
    s.prune(new Set(['other000']))
    now = 11 * 60_000
    s.prune(new Set(['other000']))
    expect(new SessionGroupStore(f).all().of).toEqual({})
  })
})

