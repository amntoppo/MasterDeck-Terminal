import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MASTER_NAME } from '@shared/derive'
import { parsePrUrl } from '@shared/prSummary'
import {
  BASELINE_AGE_MS, fresh, HEAVY_EVERY_MS, HEAVY_MAX, heavyQuery, LIGHT_MAX, lightQuery, parseHeavy, parseLight, parseViewer, prItems, prWatchMessage, safeRef, type LightPr, type PrRef,
} from '@shared/prWatch'
import { canDeliver, type WatchInfo } from '@shared/watches'
import type { AppState, CliResult, Session } from '@shared/types'
import type { GhRunner } from './ghc'

export interface PrWatchEntry {
  url: string
  owner: string
  repo: string
  number: number
  sessionKey: string
  startedAt: number
  baseline: boolean
  seen: string[]
  updatedAt: string | null
  mergeable: string | null
  heavyAt: number
  stallAt: number | null
  nudges: number
  pending: string[]
  events: number
  lastEventAt: number | null
  ended: boolean
}

export interface PrWatchDeps {
  gh: GhRunner
  paused: (output?: string) => boolean
  send: (s: Session, text: string) => Promise<CliResult>
  onChange: () => void
}

const DONE_MAX = 500
/** Below the 60 s poll: ghc only dedups concurrent asks; heavy answers (MBs) do not linger in its cache. */
const POLL_TTL = 50
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))
const graphql = (q: string) => ['api', 'graphql', '-f', `query=${q}`]

/**
 * MasterDeck watches each open PR a session made (Settings → Sessions → Watch new PRs; the
 * session's workflow keeps `pr-watch`): every minute a light batched query for all of them, a full
 * one only for PRs that changed (or every 10 minutes, or when a stalled review is due). New items go
 * to the session as one message once its turn is over. Kept in `pr-watch.json` across launches.
 * Who "me" is comes from each response's `viewer`; without it nothing is read into `seen`.
 */
export class PrWatch {
  private list: PrWatchEntry[] = []
  private done: string[] = []
  private sending = new Set<string>()
  private missingSince = new Map<string, number>()
  private polling = false

  constructor(
    private file: string,
    private deps: PrWatchDeps,
  ) {}

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { watches?: PrWatchEntry[]; done?: string[] }
      this.list = (raw.watches ?? []).filter((w) => typeof w?.url === 'string' && safeRef(w) && Array.isArray(w.seen) && Array.isArray(w.pending))
      this.done = (raw.done ?? []).filter((u) => typeof u === 'string').slice(-DONE_MAX)
    } catch {
      // first launch
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ watches: this.list, done: this.done.slice(-DONE_MAX) }, null, 1))
      renameSync(`${this.file}.tmp`, this.file)
    } catch {
      // next change
    }
  }

  private end(w: PrWatchEntry, line?: string): void {
    w.ended = true
    if (line) w.pending.push(line)
    if (!this.done.includes(w.url)) this.done.push(w.url)
  }

  sync(state: Pick<AppState, 'sessions' | 'sessionPrs' | 'prLive'>, on: (s: Session) => boolean, now = Date.now()): void {
    let changed = false
    for (const s of state.sessions) {
      if (s.state === 'done' || s.name === MASTER_NAME) continue
      if (!on(s)) {
        // Turned off (setting or workflow): its watches go without a word.
        const before = this.list.length
        this.list = this.list.filter((w) => w.sessionKey !== s.key)
        changed ||= this.list.length !== before
        continue
      }
      for (const url of state.sessionPrs[s.sessionId] ?? []) {
        const pr = state.prLive[url]
        const ref = parsePrUrl(url)
        if (pr?.state !== 'OPEN' || !ref || !safeRef(ref) || this.done.includes(url) || this.list.some((w) => w.url === url)) continue
        this.list.push({
          url, ...ref, sessionKey: s.key, startedAt: now,
          baseline: pr.createdAt === null || now - pr.createdAt > BASELINE_AGE_MS,
          seen: [], updatedAt: null, mergeable: null, heavyAt: 0, stallAt: null, nudges: 0, pending: [], events: 0, lastEventAt: null, ended: false,
        })
        changed = true
      }
    }
    if (changed) {
      this.save()
      this.deps.onChange()
    }
  }

  async poll(now = Date.now()): Promise<void> {
    if (this.polling || this.deps.paused()) return
    this.polling = true
    try {
      const heavy: { w: PrWatchEntry; l: LightPr }[] = []
      let me: string | null = null
      for (const group of chunks(this.list.filter((w) => !w.ended), LIGHT_MAX)) {
        const r = await this.deps.gh(graphql(lightQuery(group)), { ttl: POLL_TTL, timeoutMs: 30_000 })
        if (this.deps.paused(r.stderr + r.stdout)) return
        me = parseViewer(r.stdout) ?? me
        // No answer, or no "me" to tell own replies apart: touch nothing, try again next minute.
        if (r.code !== 0 || !me) continue
        const viewer = me
        parseLight(r.stdout, group.length).forEach((l, i) => {
          const w = group[i]
          if (!l) return
          if (l.author && l.author.toLowerCase() !== viewer.toLowerCase()) return this.end(w)
          const conflictKnown = w.seen.some((k) => k.startsWith('X:'))
          const due =
            w.heavyAt === 0 || l.updatedAt !== w.updatedAt || now - w.heavyAt >= HEAVY_EVERY_MS || (w.stallAt !== null && now >= w.stallAt) ||
            l.state !== 'OPEN' || (l.mergeable === 'CONFLICTING') !== conflictKnown
          // A due PR keeps its old updatedAt until its full read lands: a failed read is retried.
          if (due) heavy.push({ w, l })
          else w.mergeable = l.mergeable
        })
      }
      for (const group of chunks(heavy, HEAVY_MAX)) {
        const r = await this.deps.gh(graphql(heavyQuery(group.map((g) => g.w))), { ttl: POLL_TTL, timeoutMs: 30_000 })
        if (this.deps.paused(r.stderr + r.stdout)) break
        const viewer = parseViewer(r.stdout) ?? me
        // A failed read (or no "me") leaves `seen` as it was: nothing replays, nothing is baselined away.
        if (r.code !== 0 || !viewer) continue
        parseHeavy(r.stdout, group.length).forEach((h, i) => {
          const { w, l } = group[i]
          if (!h) return
          const { items, stallAt } = prItems(h, viewer, now)
          const news = w.baseline ? [] : fresh(items, w.seen)
          w.baseline = false
          w.seen = items.map((x) => x.key)
          w.updatedAt = l.updatedAt
          w.mergeable = h.mergeable
          w.heavyAt = now
          w.stallAt = stallAt
          const msg = prWatchMessage(w, news, w.nudges)
          w.nudges = msg.nudges
          if (msg.text) {
            w.pending.push(msg.text)
            w.events += news.length
            w.lastEventAt = now
          }
          // The merge/close line goes once: as the news, or (baselined) here.
          if (h.state !== 'OPEN') this.end(w, msg.text ? undefined : prWatchMessage(w, items, w.nudges).text)
        })
      }
      this.save()
      this.deps.onChange()
    } finally {
      this.polling = false
    }
  }

  /** What waits goes to each session once its turn is over; watches of ended sessions go. */
  deliver(sessions: Session[], now = Date.now()): void {
    const byKey = new Map<string, PrWatchEntry[]>()
    for (const w of this.list) (byKey.get(w.sessionKey) ?? byKey.set(w.sessionKey, []).get(w.sessionKey)!).push(w)
    for (const [key, ws] of byKey) {
      const s = sessions.find((x) => x.key === key)
      if (s) this.missingSince.delete(key)
      else if (!this.missingSince.has(key)) this.missingSince.set(key, now)
      const gone = s ? s.state === 'done' : now - (this.missingSince.get(key) ?? now) > 120_000
      if (gone) {
        this.list = this.list.filter((w) => w.sessionKey !== key)
        this.missingSince.delete(key)
        this.save()
        this.deps.onChange()
        continue
      }
      if (!s || this.sending.has(key) || !canDeliver(s)) continue
      const taken = ws.filter((w) => w.pending.length).map((w) => ({ w, n: w.pending.length }))
      if (!taken.length) {
        if (ws.some((w) => w.ended)) {
          this.list = this.list.filter((w) => !(w.sessionKey === key && w.ended))
          this.save()
        }
        continue
      }
      const text = taken.flatMap(({ w, n }) => w.pending.slice(0, n)).join('\n')
      this.sending.add(key)
      void this.deps
        .send(s, text)
        .then((r) => {
          if (!r.ok) return
          for (const { w, n } of taken) w.pending.splice(0, n)
          this.list = this.list.filter((w) => !(w.ended && !w.pending.length))
          this.save()
          this.deps.onChange()
        })
        .catch(() => {})
        .finally(() => this.sending.delete(key))
    }
  }

  info(sessions: Session[]): WatchInfo[] {
    return this.list
      .filter((w) => !w.ended)
      .map((w) => ({
        id: `pr:${w.url}`,
        sessionId: sessions.find((s) => s.key === w.sessionKey)?.sessionId ?? '',
        description: `PR watch · ${w.repo}#${w.number}`,
        command: w.url,
        startedAt: w.startedAt,
        events: w.events,
        lastEventAt: w.lastEventAt,
        queued: w.pending.length,
      }))
  }

  stop(id: string): boolean {
    const w = this.list.find((x) => `pr:${x.url}` === id && !x.ended)
    if (!w) return false
    this.end(w, `[MasterDeck PR watch] ${w.repo}#${w.number}: stopped from MasterDeck.`)
    this.save()
    this.deps.onChange()
    return true
  }

  watched(): Set<string> {
    return new Set(this.list.filter((w) => !w.ended).map((w) => w.url))
  }
}

/** Live state of PRs for the board moves: one light query per 50 PRs, cached five minutes. */
export async function prStates(gh: GhRunner, urls: string[]): Promise<Record<string, { state: string; isDraft: boolean }>> {
  const refs = [...new Set(urls)].map((u) => ({ u, r: parsePrUrl(u) })).filter((x): x is { u: string; r: PrRef } => !!x.r && safeRef(x.r))
  const out: Record<string, { state: string; isDraft: boolean }> = {}
  for (const group of chunks(refs, LIGHT_MAX)) {
    const r = await gh(graphql(lightQuery(group.map((g) => g.r))), { ttl: 300, timeoutMs: 30_000 })
    if (r.code !== 0) continue
    parseLight(r.stdout, group.length).forEach((l, i) => l && (out[group[i].u] = { state: l.state, isDraft: l.isDraft }))
  }
  return out
}
