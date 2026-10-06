import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PeerStore } from './peers'

const dir = () => mkdtempSync(join(tmpdir(), 'peers-'))

describe('PeerStore', () => {
  it('round-trips edges and seen through the file', () => {
    const f = join(dir(), 'session-peers.json')
    const s = new PeerStore(f)
    s.load()
    expect(s.set('a', 'b', true)).toEqual({ ok: true, message: 'linked' })
    s.markSeen('a', 'b', 42)
    s.flush()
    const t = new PeerStore(f)
    t.load()
    expect(t.of('b')).toEqual(['a'])
    expect(t.seen('a', 'b')).toBe(42)
    expect(t.set('a', 'b', false)).toEqual({ ok: true, message: 'unlinked' })
    expect(t.of('a')).toEqual([])
  })
  it('moves a corrupt file aside and starts empty', () => {
    const d = dir()
    const f = join(d, 'session-peers.json')
    writeFileSync(f, '{not json')
    const s = new PeerStore(f)
    s.load()
    expect(s.of('a')).toEqual([])
    expect(readdirSync(d).some((n) => n.startsWith('session-peers.json.corrupt-'))).toBe(true)
  })
  it('prunes dead keys and reports them', () => {
    const s = new PeerStore(join(dir(), 'p.json'))
    s.load()
    s.set('a', 'b', true)
    expect(s.prune(new Set(['a']))).toEqual(['b'])
    expect(s.of('a')).toEqual([])
  })
  it('claims an expected session by name and expires old expectations', () => {
    let now = 1_000_000
    const s = new PeerStore(join(dir(), 'p.json'), () => now)
    s.load()
    s.expect('new-one', ['a', 'b'])
    expect(s.claim([{ key: 'a', name: 'a', state: 'idle' }])).toBe(false)
    expect(s.claim([{ key: 'n1', name: 'new-one', state: 'working' }, { key: 'a', name: 'a', state: 'idle' }])).toBe(true)
    expect(s.of('n1').sort()).toEqual(['a', 'b'])
    s.expect('late', ['a'])
    now += 11 * 60_000
    expect(s.claim([{ key: 'l1', name: 'late', state: 'idle' }])).toBe(false)
    expect(s.of('l1')).toEqual([])
  })
  it('calls onChange after a save', () => {
    const s = new PeerStore(join(dir(), 'p.json'))
    s.load()
    let n = 0
    s.onChange(() => n++)
    s.set('a', 'b', true)
    expect(n).toBe(1)
    expect(readFileSync(s.file, 'utf8')).toContain('"edges"')
  })
  it('carries edges and seen to a new key', () => {
    const s = new PeerStore(join(dir(), 'p.json'))
    s.load()
    s.set('old', 'b', true)
    s.markSeen('old', 'b', 7)
    s.carry('old', 'new')
    expect(s.of('new')).toEqual(['b'])
    expect(s.of('old')).toEqual([])
    expect(s.of('b')).toEqual(['new'])
    expect(s.seen('new', 'b')).toBe(7)
    expect(s.seen('old', 'b')).toBe(0)
  })
})
