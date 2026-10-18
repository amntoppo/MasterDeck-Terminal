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
  it('puts an expected session in its tab when it is listed, and keeps it there across a copy', () => {
    let now = 0
    const f = join(dir(), 'session-groups.json')
    const s = new SessionGroupStore(f, () => now)
    const id = s.act({ op: 'add', name: 'A' }).id!
    s.expect('new-1', id, ['old00000'])
    s.claim([{ key: 'old00000', name: 'new-1' }])
    expect(s.all().of).toEqual({})
    now = 5_000
    s.claim([{ key: 'new00001', name: 'new-1' }])
    expect(new SessionGroupStore(f).all().of).toEqual({ new00001: id })
    s.carry('new00001', 'copy0001')
    expect(new SessionGroupStore(f).all().of).toEqual({ copy0001: id })
  })
  it('ignores All and unknown tabs, and forgets a failed start', () => {
    const f = join(dir(), 'session-groups.json')
    const s = new SessionGroupStore(f)
    const id = s.act({ op: 'add', name: 'A' }).id!
    s.expect('a', 'all', [])
    s.expect('b', 'g99999999', [])
    s.expect('c', id, [])
    s.unexpect('c')
    s.claim(['a', 'b', 'c'].map((n) => ({ key: `${n}0000000`, name: n })))
    expect(s.all().of).toEqual({})
  })
  it('drops the wait when its tab is deleted first', () => {
    const f = join(dir(), 'session-groups.json')
    const s = new SessionGroupStore(f)
    const id = s.act({ op: 'add', name: 'A' }).id!
    s.expect('n', id, [])
    s.act({ op: 'remove', id })
    s.claim([{ key: 'n0000000', name: 'n' }])
    expect(s.all()).toEqual({ groups: [], of: {} })
  })
})
