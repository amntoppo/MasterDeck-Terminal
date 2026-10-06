import { describe, expect, it } from 'vitest'
import { MAX_PEERS, addEdge, adjacency, carryKey, emptyPeers, parsePeers, peersOf, pruneEdges, removeEdge } from './peers'

describe('peers graph', () => {
  it('adds one undirected edge, deduped', () => {
    const d = emptyPeers()
    expect(addEdge(d, 'a', 'b')).toEqual({ ok: true })
    expect(addEdge(d, 'b', 'a')).toEqual({ ok: true })
    expect(d.edges).toHaveLength(1)
    expect(peersOf(d, 'a')).toEqual(['b'])
    expect(peersOf(d, 'b')).toEqual(['a'])
  })
  it('refuses a self edge and an empty key', () => {
    const d = emptyPeers()
    expect(addEdge(d, 'a', 'a').ok).toBe(false)
    expect(addEdge(d, '', 'a').ok).toBe(false)
  })
  it('refuses more than MAX_PEERS on either side', () => {
    const d = emptyPeers()
    for (let i = 0; i < MAX_PEERS; i++) expect(addEdge(d, 'a', `p${i}`).ok).toBe(true)
    const r = addEdge(d, 'a', 'one-more')
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.message).toMatch(/8/)
    expect(addEdge(d, 'one-more', 'a').ok).toBe(false)
  })
  it('removes from either side and clears seen', () => {
    const d = emptyPeers()
    addEdge(d, 'a', 'b')
    d.seen = { a: { b: 5 }, b: { a: 6 } }
    expect(removeEdge(d, 'b', 'a')).toBe(true)
    expect(removeEdge(d, 'b', 'a')).toBe(false)
    expect(peersOf(d, 'a')).toEqual([])
    expect(d.seen).toEqual({ a: {}, b: {} })
  })
  it('prunes dead endpoints and their seen rows', () => {
    const d = emptyPeers()
    addEdge(d, 'a', 'b')
    addEdge(d, 'a', 'c')
    d.seen = { a: { b: 1, c: 2 }, b: { a: 1 } }
    expect(pruneEdges(d, new Set(['a', 'c']))).toEqual(['b'])
    expect(peersOf(d, 'a')).toEqual(['c'])
    expect(d.seen.b).toBeUndefined()
    expect(d.seen.a).toEqual({ c: 2 })
  })
  it('carries a key to a new one', () => {
    const d = emptyPeers()
    addEdge(d, 'old', 'b')
    d.seen = { old: { b: 3 }, b: { old: 4 } }
    expect(carryKey(d, 'old', 'new')).toBe(true)
    expect(peersOf(d, 'new')).toEqual(['b'])
    expect(peersOf(d, 'b')).toEqual(['new'])
    expect(d.seen).toEqual({ new: { b: 3 }, b: { new: 4 } })
    expect(carryKey(d, 'gone', 'x')).toBe(false)
  })
  it('builds a symmetric adjacency', () => {
    const d = emptyPeers()
    addEdge(d, 'a', 'b')
    addEdge(d, 'c', 'a')
    expect(adjacency(d)).toEqual({ a: ['b', 'c'], b: ['a'], c: ['a'] })
  })
  it('parses a valid file and rejects garbage', () => {
    expect(parsePeers({ version: 1, edges: [['a', 'b']], seen: {} })).toEqual({ version: 1, edges: [['a', 'b']], seen: {} })
    expect(parsePeers({ version: 1, edges: [['a', 'b'], ['a', 'a'], ['b', 'a'], 'x'], seen: { a: { b: 'no' } } })).toEqual({ version: 1, edges: [['a', 'b']], seen: { a: {} } })
    expect(parsePeers(null)).toBeNull()
    expect(parsePeers({ version: 2 })).toBeNull()
    expect(parsePeers('[]')).toBeNull()
  })
})
