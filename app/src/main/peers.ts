import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CliResult, Session } from '@shared/types'
import { addEdge, carryKey, emptyPeers, parsePeers, peersOf, pruneEdges, removeEdge, type PeerData } from '@shared/peers'

const EXPECT_MS = 10 * 60_000
const SEEN_FLUSH_MS = 500

/** session-peers.json: which sessions are linked to which (Session.key), and what each has seen of its peers. */
export class PeerStore {
  private d: PeerData = emptyPeers()
  private pending = new Map<string, { peers: string[]; at: number }>()
  private listeners: (() => void)[] = []
  private seenTimer: NodeJS.Timeout | null = null

  constructor(readonly file: string, private readonly now: () => number = Date.now) {}

  load(): void {
    if (!existsSync(this.file)) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      raw = null
    }
    const d = parsePeers(raw)
    if (d) {
      this.d = d
      return
    }
    try {
      renameSync(this.file, `${this.file}.corrupt-${this.now()}`)
    } catch {
      // leave it; the next save overwrites
    }
    this.d = emptyPeers()
  }

  data(): PeerData {
    return this.d
  }
  of(key: string): string[] {
    return peersOf(this.d, key)
  }
  seen(t: string, p: string): number {
    return this.d.seen[t]?.[p] ?? 0
  }

  set(a: string, b: string, on: boolean): CliResult {
    if (on) {
      const r = addEdge(this.d, a, b)
      if (!r.ok) return r
      this.save()
      return { ok: true, message: 'linked' }
    }
    removeEdge(this.d, a, b)
    this.save()
    return { ok: true, message: 'unlinked' }
  }

  prune(live: Set<string>): string[] {
    const dead = pruneEdges(this.d, live)
    if (dead.length) this.save()
    return dead
  }

  carry(oldKey: string, newKey: string): void {
    if (carryKey(this.d, oldKey, newKey)) this.save()
  }

  markSeen(t: string, p: string, at: number): void {
    ;(this.d.seen[t] ??= {})[p] = at
    if (!this.seenTimer) this.seenTimer = setTimeout(() => this.flush(), SEEN_FLUSH_MS)
  }

  expect(name: string, peers: string[]): void {
    if (peers.length) this.pending.set(name, { peers, at: this.now() })
  }

  /** Link each expected session that has appeared; returns the keys of the sessions that gained a peer. */
  claim(sessions: Pick<Session, 'key' | 'name' | 'state'>[]): string[] {
    const claimed: string[] = []
    const now = this.now()
    for (const [name, p] of this.pending) {
      if (now - p.at > EXPECT_MS) {
        this.pending.delete(name)
        continue
      }
      const s = sessions.find((x) => x.name === name && x.state !== 'done')
      if (s) {
        this.pending.delete(name)
        let added = false
        for (const k of p.peers) if (addEdge(this.d, s.key, k).ok) added = true
        if (added) claimed.push(s.key)
      }
    }
    if (claimed.length) this.save()
    return claimed
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb)
  }

  flush(): void {
    if (this.seenTimer) {
      clearTimeout(this.seenTimer)
      this.seenTimer = null
    }
    this.write()
  }

  private save(): void {
    this.write()
    for (const cb of this.listeners) cb()
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`session peers: ${String(e)}`)
    }
  }
}
