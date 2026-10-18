import { describe, expect, it } from 'vitest'
import {
  ALL,
  applyGroupOp,
  carryGroup,
  claimWaits,
  cleanName,
  emptyGroups,
  GROUP_MAX,
  inGroup,
  newGroupId,
  parseGroups,
  pruneGroups,
  shownTab,
  type GroupWait,
  type SessionGroups,
} from './sessionGroups'

const ids = () => {
  let n = 0
  return () => `g0000000${n++}`
}
const two = (): SessionGroups => ({
  groups: [
    { id: 'g00000000', name: 'A' },
    { id: 'g00000001', name: 'B' },
  ],
  of: { k1: 'g00000000', k2: 'g00000001' },
})
const ok = (r: ReturnType<typeof applyGroupOp>): SessionGroups => {
  if (!r.ok) throw new Error(r.message)
  return r.groups
}

describe('cleanName', () => {
  it('trims, folds spaces and drops control characters', () => {
    expect(cleanName('  Front\u0007  end ', [])).toEqual({ name: 'Front end' })
  })
  it('refuses empty, long, All and duplicates ignoring case', () => {
    expect(cleanName(' ', [])).toEqual({ error: 'Name the tab.' })
    expect(cleanName('x'.repeat(41), [])).toHaveProperty('error')
    expect(cleanName('all', [])).toHaveProperty('error')
    expect(cleanName('a', two().groups)).toHaveProperty('error')
    expect(cleanName('a', two().groups, 'g00000000')).toEqual({ name: 'a' })
    expect(cleanName(3, [])).toHaveProperty('error')
  })
})

describe('applyGroupOp', () => {
  it('adds a tab at the end with a new id', () => {
    const r = applyGroupOp(two(), { op: 'add', name: 'C' }, () => 'g0000000c')
    expect(r.ok && r.id).toBe('g0000000c')
    expect(ok(r).groups.map((g) => g.name)).toEqual(['A', 'B', 'C'])
  })
  it('never reuses an id', () => {
    const r = applyGroupOp(two(), { op: 'add', name: 'C' }, ids())
    expect(r.ok && r.id).toBe('g00000002')
  })
  it('refuses a tab over the limit', () => {
    const d: SessionGroups = { groups: Array.from({ length: GROUP_MAX }, (_, i) => ({ id: `g${String(i).padStart(8, '0')}`, name: `t${i}` })), of: {} }
    expect(applyGroupOp(d, { op: 'add', name: 'x' }).ok).toBe(false)
  })
  it('renames, and refuses a gone tab', () => {
    expect(ok(applyGroupOp(two(), { op: 'rename', id: 'g00000001', name: 'Bee' })).groups[1].name).toBe('Bee')
    expect(applyGroupOp(two(), { op: 'rename', id: 'gffffffff', name: 'x' })).toEqual({ ok: false, message: 'That tab is gone.' })
  })
  it('moves a tab before another or to the end', () => {
    const d = ok(applyGroupOp(two(), { op: 'add', name: 'C' }, () => 'g0000000c'))
    expect(ok(applyGroupOp(d, { op: 'move', id: 'g0000000c', before: 'g00000000' })).groups.map((g) => g.name)).toEqual(['C', 'A', 'B'])
    expect(ok(applyGroupOp(d, { op: 'move', id: 'g00000000', before: null })).groups.map((g) => g.name)).toEqual(['B', 'C', 'A'])
    expect(ok(applyGroupOp(d, { op: 'move', id: 'g00000000', before: 'g00000000' }))).toBe(d)
    expect(applyGroupOp(d, { op: 'move', id: 'g00000000', before: 'gffffffff' }).ok).toBe(false)
  })
  it('removes a tab and only its assignments', () => {
    expect(ok(applyGroupOp(two(), { op: 'remove', id: 'g00000000' }))).toEqual({ groups: [{ id: 'g00000001', name: 'B' }], of: { k2: 'g00000001' } })
  })
  it('assigns, moves between tabs and takes out (null or All)', () => {
    let d = ok(applyGroupOp(two(), { op: 'assign', key: 'k3', group: 'g00000000' }))
    expect(d.of.k3).toBe('g00000000')
    d = ok(applyGroupOp(d, { op: 'assign', key: 'k3', group: 'g00000001' }))
    expect(d.of.k3).toBe('g00000001')
    d = ok(applyGroupOp(d, { op: 'assign', key: 'k3', group: ALL }))
    expect('k3' in d.of).toBe(false)
    expect(ok(applyGroupOp(d, { op: 'assign', key: 'k1', group: null })).of).toEqual({ k2: 'g00000001' })
  })
  it('refuses bad input', () => {
    expect(applyGroupOp(two(), null).ok).toBe(false)
    expect(applyGroupOp(two(), { op: 'nope' }).ok).toBe(false)
    expect(applyGroupOp(two(), { op: 'assign', key: '../x', group: null }).ok).toBe(false)
    expect(applyGroupOp(two(), { op: 'assign', key: 'k9', group: 'gffffffff' }).ok).toBe(false)
    expect(applyGroupOp(two(), { op: 'assign', key: '__proto__', group: 'g00000000' }).ok).toBe(false)
    expect(applyGroupOp(two(), { op: 'assign', key: 'constructor', group: null }).ok).toBe(false)
    expect(parseGroups({ groups: [{ id: 'g00000000', name: 'A' }], of: JSON.parse('{"__proto__":"g00000000"}') })?.of).toEqual({})
  })
  it('leaves the input untouched', () => {
    const d = two()
    applyGroupOp(d, { op: 'remove', id: 'g00000000' })
    applyGroupOp(d, { op: 'assign', key: 'k1', group: null })
    expect(d).toEqual(two())
  })
})

describe('carryGroup', () => {
  it('moves the old key to the copy', () => {
    expect(carryGroup(two(), 'k1', 'k9').of).toEqual({ k9: 'g00000000', k2: 'g00000001' })
  })
  it('returns the same value when there is nothing to carry', () => {
    const d = two()
    expect(carryGroup(d, 'zz', 'k9')).toBe(d)
    expect(carryGroup(d, 'k1', 'k1')).toBe(d)
  })
})

describe('claimWaits', () => {
  const wait = (o: Partial<GroupWait> = {}): GroupWait => ({ name: 'new-1', group: 'g00000001', skip: [], at: 0, ...o })
  const live = (key: string, name: string, state = 'idle') => ({ key, name, state })
  it('puts the session in its tab when it appears, on a later poll too', () => {
    const d = two()
    const w = [wait()]
    const first = claimWaits(d, w, [live('k1', 'other')], 10)
    expect(first.groups).toBe(d)
    expect(first.waits).toBe(w)
    const later = claimWaits(d, w, [live('k1', 'other'), live('n1', 'new-1', 'working')], 20)
    expect(later.groups.of).toEqual({ ...d.of, n1: 'g00000001' })
    expect(later.waits).toEqual([])
    expect(d.of).toEqual(two().of)
  })
  it('never pulls in an older session of that name or a done one', () => {
    const d = two()
    const r = claimWaits(d, [wait({ skip: ['o1'] })], [live('o1', 'new-1'), live('o2', 'new-1', 'done')], 10)
    expect(r.groups).toBe(d)
    expect(r.waits).toHaveLength(1)
  })
  it('leaves a session already in a tab where it is', () => {
    const d = two()
    const r = claimWaits(d, [wait({ name: 'one' })], [live('k1', 'one')], 10)
    expect(r.groups).toBe(d)
    expect(r.waits).toEqual([])
  })
  it('drops the wait when its tab is deleted: the session stays in All', () => {
    const gone = ok(applyGroupOp(two(), { op: 'remove', id: 'g00000001' }))
    const r = claimWaits(gone, [wait()], [live('n1', 'new-1')], 10)
    expect(r.groups).toBe(gone)
    expect(r.waits).toEqual([])
    expect(r.groups.of.n1).toBeUndefined()
  })
  it('drops the wait when the session never shows up in time', () => {
    const d = two()
    expect(claimWaits(d, [wait()], [], 100, 100).waits).toHaveLength(1)
    expect(claimWaits(d, [wait()], [], 101, 100).waits).toEqual([])
    expect(claimWaits(d, [wait()], [live('n1', 'new-1')], 101, 100).groups).toBe(d)
  })
})

describe('pruneGroups', () => {
  it('drops a missing session only after the grace', () => {
    const since = new Map<string, number>()
    const d = two()
    expect(pruneGroups(d, new Set(['k1']), since, 0, 100)).toBe(d)
    const out = pruneGroups(d, new Set(['k1']), since, 100, 100)
    expect(out.of).toEqual({ k1: 'g00000000' })
    expect(since.size).toBe(0)
  })
  it('forgets the clock of a session that came back', () => {
    const since = new Map<string, number>()
    pruneGroups(two(), new Set(['k1']), since, 0, 100)
    expect(pruneGroups(two(), new Set(['k1', 'k2']), since, 50, 100).of).toEqual(two().of)
    expect(since.size).toBe(0)
  })
  it('clears nothing on an empty list', () => {
    const d = two()
    expect(pruneGroups(d, new Set(), new Map(), 1e9, 0)).toBe(d)
  })
})

describe('parseGroups', () => {
  it('keeps good tabs and assignments, drops the rest', () => {
    expect(
      parseGroups({
        version: 1,
        groups: [{ id: 'g00000000', name: 'A' }, { id: 'bad', name: 'B' }, { id: 'g00000001', name: 'a' }, { id: 'g00000002', name: ' C ' }],
        of: { k1: 'g00000000', k2: 'g00000001', 'x/y': 'g00000000', k3: 5 },
      }),
    ).toEqual({ groups: [{ id: 'g00000000', name: 'A' }, { id: 'g00000002', name: 'C' }], of: { k1: 'g00000000' } })
  })
  it('is null for something that is no groups file', () => {
    expect(parseGroups(null)).toBeNull()
    expect(parseGroups([])).toBeNull()
    expect(parseGroups({ of: {} })).toBeNull()
  })
})

describe('inGroup and shownTab', () => {
  const list = [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }]
  it('lists every session in All or a gone tab, else the tab’s own', () => {
    expect(inGroup(list, two(), ALL)).toBe(list)
    expect(inGroup(list, two(), 'gffffffff')).toBe(list)
    expect(inGroup(list, two(), 'g00000001')).toEqual([{ key: 'k2' }])
    expect(inGroup(list, undefined, 'g00000001')).toBe(list)
  })
  it('falls back to All when the picked tab is gone', () => {
    expect(shownTab(two(), 'g00000000')).toBe('g00000000')
    expect(shownTab(two(), 'gffffffff')).toBe(ALL)
    expect(shownTab(emptyGroups(), ALL)).toBe(ALL)
  })
})

describe('newGroupId', () => {
  it('is g and 8 hex characters', () => {
    expect(newGroupId()).toMatch(/^g[0-9a-f]{8}$/)
  })
})
