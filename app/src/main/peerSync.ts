import type { CliResult, Session } from '@shared/types'
import { peerDeltas, type PeerFact } from '@shared/deckHooks'
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
  /** The session has a delta its next prompt has not read yet (DeckHooks.hasDelta). */
  deltaPending: (sessionId: string) => boolean
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

const deltaText = (facts: PeerFact[], now: number): string =>
  (peerDeltas(facts, now) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext

/** Keeps linked sessions' summaries fresh and tells each session when a peer's summary changed. */
export class PeerSync {
  private lastMake = new Map<string, number>()
  private inFlight = new Map<string, Promise<CliResult>>()
  /** Per target: the peers in the delta last written for it (one file each, overwritten, read once). */
  private queued = new Map<string, Set<string>>()

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
  /** Every peer of `target` with a summary `target` has not seen yet. */
  private unseen(target: string): (PeerFact & { summary: { at: number; text: string } })[] {
    return this.deps
      .facts(target)
      .filter((f): f is PeerFact & { summary: { at: number; text: string } } => !!f.summary && this.deps.store.seen(target, f.key) < f.summary.at)
  }
  /** The live sessions linked to any of `keys`: the ones a change to `keys` must reach. */
  private targets(keys: string[]): Session[] {
    const out = new Map<string, Session>()
    for (const key of keys)
      for (const pk of this.deps.store.of(key)) {
        const peer = this.byKey(pk)
        if (peer && peer.state !== 'done') out.set(pk, peer)
      }
    return [...out.values()]
  }

  /** A Stop event: summarize a linked session again (debounced, only when its transcript grew). */
  onStop(sessionId: string): void {
    if (this.deps.auto && !this.deps.auto()) return
    const s = this.byId(sessionId)
    if (!s || s.state === 'done' || !this.deps.store.of(s.key).length) return
    if (this.inFlight.has(s.key)) return
    if (this.now() - (this.lastMake.get(s.key) ?? 0) < PEER_SYNC_MIN_MS) return
    if (!this.deps.summaryStale(s.key)) return
    void this.make(s.key)
  }

  /**
   * Summarize `key` after any make already running for it: the chained promise is registered before
   * anything awaits, so concurrent callers queue instead of running side by side.
   */
  private make(key: string): Promise<CliResult> {
    const prev = this.inFlight.get(key) ?? Promise.resolve()
    const p = prev.then(
      () => this.run(key),
      () => this.run(key),
    )
    this.inFlight.set(key, p)
    void p.finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key)
    })
    return p
  }

  private async run(key: string): Promise<CliResult> {
    // Set before the call, so a failed auto make still holds the debounce (no retry storm on every Stop).
    this.lastMake.set(key, this.now())
    try {
      const r = await this.deps.makeSummary(key)
      if (!r.ok) return r
      this.refreshAll([key])
      return { ok: true, message: 'synced' }
    } catch (e) {
      return { ok: false, message: String(e) }
    }
  }

  /**
   * After a summary or link change for `keys`: rewrite every context file, then (hooks live) one
   * delta per peer of `keys` listing every linked session it has not seen, marked seen. Without
   * hooks nothing is marked: syncNow delivers through the Sender and marks what it delivered.
   */
  refreshAll(keys: string[]): void {
    this.deps.rewriteContext()
    if (!this.deps.hooksLive()) return
    for (const target of this.targets(keys)) {
      const fresh = this.unseen(target.key)
      if (!fresh.length) continue
      // The delta file is overwritten: keep the peers of one not read yet, or they are lost (already marked seen).
      const kept = this.deps.deltaPending(target.sessionId) ? (this.queued.get(target.key) ?? new Set<string>()) : new Set<string>()
      const facts = this.deps
        .facts(target.key)
        .filter((f): f is PeerFact & { summary: { at: number; text: string } } => !!f.summary && (kept.has(f.key) || fresh.some((x) => x.key === f.key)))
      this.deps.setDelta(target.sessionId, peerDeltas(facts, this.now()))
      this.queued.set(target.key, new Set(facts.map((f) => f.key)))
      for (const f of fresh) this.deps.store.markSeen(target.key, f.key, f.summary.at)
    }
  }

  /**
   * After the link a–b is removed: a side left with no peers drops any delta still waiting for its
   * next prompt; a side with other peers has the removed one taken out of a pending delta (the
   * delta is rewritten from the peers still in it, or cleared when none remain).
   */
  unlinked(a: string, b: string): void {
    for (const [key, gone] of [
      [a, b],
      [b, a],
    ] as const) {
      const s = this.byKey(key)
      if (!this.deps.store.of(key).length) {
        this.queued.delete(key)
        if (s) this.deps.clearDelta(s.sessionId)
        continue
      }
      const q = this.queued.get(key)
      if (!q?.has(gone)) continue
      q.delete(gone)
      if (!s || !this.deps.deltaPending(s.sessionId)) continue
      const facts = this.deps
        .facts(key)
        .filter((f): f is PeerFact & { summary: { at: number; text: string } } => !!f.summary && q.has(f.key))
      if (facts.length) {
        this.deps.setDelta(s.sessionId, peerDeltas(facts, this.now()))
        this.queued.set(key, new Set(facts.map((f) => f.key)))
      } else {
        this.queued.delete(key)
        this.deps.clearDelta(s.sessionId)
      }
    }
  }

  /**
   * "Sync now": a fresh summary regardless of the debounce (queued after one already being made),
   * refresh, and type it into each peer when hooks are not live.
   */
  async syncNow(key: string): Promise<CliResult> {
    if (!this.byKey(key)) return { ok: false, message: 'session not found' }
    if (!this.deps.store.of(key).length) return { ok: false, message: 'no linked sessions' }
    const r = await this.make(key)
    if (!r.ok) return r
    if (!this.deps.hooksLive())
      for (const target of this.targets([key])) {
        const facts = this.unseen(target.key)
        if (!facts.length || !canDeliver(target)) continue
        try {
          const sent = await this.deps.deliver(target, deltaText(facts, this.now()))
          if (sent.ok) for (const f of facts) this.deps.store.markSeen(target.key, f.key, f.summary.at)
        } catch (e) {
          console.error(`peer sync: deliver to ${target.key}: ${String(e)}`)
        }
      }
    return { ok: true, message: 'synced' }
  }
}
