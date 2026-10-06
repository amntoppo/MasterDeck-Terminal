import type { CliResult, Session } from '@shared/types'
import { peerDelta, type PeerFact } from '@shared/deckHooks'
import { canDeliver } from '@shared/watches'
import type { PeerStore } from './peers'

/** A linked session is summarized again on Stop at most this often. */
export const PEER_SYNC_MIN_MS = 120_000

export interface PeerSyncDeps {
  store: PeerStore
  /** The latest live sessions. */
  sessions: () => Session[]
  /** How each of `key`'s peers looks to `key` (Sources.peerFacts). */
  facts: (key: string) => PeerFact[]
  /** Same rule as CH.summaryGet: the transcript grew past the summary (or there is none). */
  summaryStale: (key: string) => boolean
  makeSummary: (key: string) => Promise<{ ok: true; summary: { at: number } } | { ok: false; message: string }>
  setDelta: (sessionId: string, json: object) => void
  clearDelta: (sessionId: string) => void
  /** Rewrite every session's context file (Sources.rewriteSessionContext). */
  rewriteContext: () => void
  /** False on win32 or when the deck hooks are not installed: no per-prompt delta reaches a session. */
  hooksLive: () => boolean
  /** Sender fallback: type the text into the session. */
  deliver: (s: Session, text: string) => Promise<CliResult>
  now?: () => number
  /** Config peerSync.auto, default true. */
  auto?: () => boolean
}

const deltaText = (fact: PeerFact, now: number): string =>
  (peerDelta(fact, now) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext

/** Keeps linked sessions' summaries fresh and tells each session when a peer's summary changed. */
export class PeerSync {
  private lastMake = new Map<string, number>()
  private inFlight = new Set<string>()
  private again = new Set<string>()

  constructor(private readonly deps: PeerSyncDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
  private byId(sessionId: string): Session | undefined {
    return this.deps.sessions().find((s) => s.sessionId === sessionId)
  }
  private byKey(key: string): Session | undefined {
    return this.deps.sessions().find((s) => s.key === key)
  }
  /** `key` as its peer `peerKey` sees it, when it has a summary `peerKey` has not seen yet. */
  private unseen(peerKey: string, key: string): PeerFact | null {
    const fact = this.deps.facts(peerKey).find((f) => f.key === key)
    if (!fact?.summary) return null
    return this.deps.store.seen(peerKey, key) >= fact.summary.at ? null : fact
  }

  /** A Stop event: summarize a linked session again (debounced, only when its transcript grew). */
  onStop(sessionId: string): void {
    if (this.deps.auto && !this.deps.auto()) return
    const s = this.byId(sessionId)
    if (!s || s.state === 'done' || !this.deps.store.of(s.key).length) return
    if (this.now() - (this.lastMake.get(s.key) ?? 0) < PEER_SYNC_MIN_MS) return
    if (!this.deps.summaryStale(s.key)) return
    void this.make(s.key)
  }

  private async make(key: string): Promise<CliResult> {
    if (this.inFlight.has(key)) {
      this.again.add(key)
      return { ok: true, message: 'already summarizing' }
    }
    this.inFlight.add(key)
    this.lastMake.set(key, this.now())
    try {
      const r = await this.deps.makeSummary(key)
      if (!r.ok) return r
      this.refreshAll([key])
      return { ok: true, message: 'synced' }
    } catch (e) {
      return { ok: false, message: String(e) }
    } finally {
      this.inFlight.delete(key)
      if (this.again.delete(key)) void this.make(key)
    }
  }

  /**
   * After a summary or link change for `keys`: rewrite every context file, then (hooks live) a
   * delta for each peer that has not seen the newest summary, marked seen. Without hooks nothing is
   * marked: syncNow delivers through the Sender and marks what it delivered.
   */
  refreshAll(keys: string[]): void {
    this.deps.rewriteContext()
    if (!this.deps.hooksLive()) return
    for (const key of keys) {
      if (!this.byKey(key)) continue
      for (const peerKey of this.deps.store.of(key)) {
        const peer = this.byKey(peerKey)
        if (!peer || peer.state === 'done') continue
        const fact = this.unseen(peerKey, key)
        if (!fact?.summary) continue
        this.deps.setDelta(peer.sessionId, peerDelta(fact, this.now()))
        this.deps.store.markSeen(peerKey, key, fact.summary.at)
      }
    }
  }

  /** After an unlink: a session left with no peers drops any delta still waiting for its next prompt. */
  unlinked(keys: string[]): void {
    for (const key of keys) {
      if (this.deps.store.of(key).length) continue
      const s = this.byKey(key)
      if (s) this.deps.clearDelta(s.sessionId)
    }
  }

  /** "Sync now": summarize regardless of the debounce, refresh, and type it into peers when hooks are not live. */
  async syncNow(key: string): Promise<CliResult> {
    if (!this.byKey(key)) return { ok: false, message: 'session not found' }
    const peers = this.deps.store.of(key)
    if (!peers.length) return { ok: false, message: 'no linked sessions' }
    this.lastMake.delete(key)
    const r = await this.make(key)
    if (!r.ok) return r
    if (!this.deps.hooksLive())
      for (const pk of peers) {
        const peer = this.byKey(pk)
        const fact = this.unseen(pk, key)
        if (!peer || peer.state === 'done' || !fact?.summary || !canDeliver(peer)) continue
        const sent = await this.deps.deliver(peer, deltaText(fact, this.now()))
        if (sent.ok) this.deps.store.markSeen(pk, key, fact.summary.at)
      }
    return { ok: true, message: 'synced' }
  }
}
