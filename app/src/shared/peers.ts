/** Session ↔ session links ("Linked sessions"): a pairwise, undirected graph keyed by Session.key. */

export const MAX_PEERS = 8

export type Edge = [string, string]

export interface PeerData {
  version: 1
  edges: Edge[]
  /** seen[T][P]: the `at` of P's summary that T last received. */
  seen: Record<string, Record<string, number>>
}

export function emptyPeers(): PeerData {
  return { version: 1, edges: [], seen: {} }
}

const norm = (a: string, b: string): Edge => (a < b ? [a, b] : [b, a])
const has = (d: PeerData, a: string, b: string): boolean => d.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))

export function peersOf(d: PeerData, key: string): string[] {
  const out = new Set<string>()
  for (const [a, b] of d.edges) {
    if (a === key) out.add(b)
    else if (b === key) out.add(a)
  }
  return [...out].sort()
}

export function addEdge(d: PeerData, a: string, b: string): { ok: true } | { ok: false; message: string } {
  if (!a || !b) return { ok: false, message: 'bad session' }
  if (a === b) return { ok: false, message: 'a session cannot be linked to itself' }
  if (has(d, a, b)) return { ok: true }
  for (const k of [a, b]) if (peersOf(d, k).length >= MAX_PEERS) return { ok: false, message: `a session can be linked to at most ${MAX_PEERS} others` }
  d.edges.push(norm(a, b))
  return { ok: true }
}

export function removeEdge(d: PeerData, a: string, b: string): boolean {
  const n = d.edges.length
  d.edges = d.edges.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)))
  if (d.seen[a]) delete d.seen[a][b]
  if (d.seen[b]) delete d.seen[b][a]
  return d.edges.length !== n
}

export function pruneEdges(d: PeerData, live: Set<string>): string[] {
  const dead = new Set<string>()
  d.edges = d.edges.filter(([a, b]) => {
    const ok = live.has(a) && live.has(b)
    if (!ok) for (const k of [a, b]) if (!live.has(k)) dead.add(k)
    return ok
  })
  for (const k of dead) {
    delete d.seen[k]
    for (const row of Object.values(d.seen)) delete row[k]
  }
  return [...dead].sort()
}

export function carryKey(d: PeerData, oldKey: string, newKey: string): boolean {
  if (!oldKey || !newKey || oldKey === newKey) return false
  let changed = false
  d.edges = d.edges.map(([a, b]) => {
    if (a !== oldKey && b !== oldKey) return [a, b] as Edge
    changed = true
    return norm(a === oldKey ? newKey : a, b === oldKey ? newKey : b)
  })
  if (d.seen[oldKey]) {
    d.seen[newKey] = { ...(d.seen[newKey] ?? {}), ...d.seen[oldKey] }
    delete d.seen[oldKey]
    changed = true
  }
  for (const row of Object.values(d.seen)) if (oldKey in row) {
    row[newKey] = row[oldKey]
    delete row[oldKey]
    changed = true
  }
  return changed
}

export function adjacency(d: PeerData): Record<string, string[]> {
  const out: Record<string, Set<string>> = {}
  for (const [a, b] of d.edges) {
    ;(out[a] ??= new Set()).add(b)
    ;(out[b] ??= new Set()).add(a)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]))
}

const isKey = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length < 200

/** A session-peers.json as read from disk: edges and seen cleaned; null when it is not the file. */
export function parsePeers(raw: unknown): PeerData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1 || !Array.isArray(o.edges)) return null
  const d = emptyPeers()
  for (const e of o.edges) if (Array.isArray(e) && e.length === 2 && isKey(e[0]) && isKey(e[1]) && e[0] !== e[1] && !has(d, e[0], e[1])) d.edges.push(norm(e[0], e[1]))
  if (o.seen && typeof o.seen === 'object' && !Array.isArray(o.seen))
    for (const [t, row] of Object.entries(o.seen as Record<string, unknown>)) {
      if (!isKey(t) || !row || typeof row !== 'object' || Array.isArray(row)) continue
      d.seen[t] = {}
      for (const [p, at] of Object.entries(row as Record<string, unknown>)) if (isKey(p) && typeof at === 'number' && Number.isFinite(at)) d.seen[t][p] = at
    }
  return d
}
