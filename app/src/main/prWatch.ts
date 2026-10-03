import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MASTER_NAME } from '@shared/derive'
import { parsePrUrl } from '@shared/prSummary'
import {
  BASELINE_AGE_MS, baselineMessage, fresh, HEAVY_EVERY_MS, HEAVY_MAX, heavyQuery, LIGHT_MAX, lightQuery, parseHeavy, parseLight, parseViewer, prItems, prWatchMessage, safeRef, type LightPr, type PrItem, type PrRef,
} from '@shared/prWatch'
import { canDeliver, type WatchInfo } from '@shared/watches'
import type { AppState, CliResult, Session } from '@shared/types'
import { ghErrorText, ghHasData, type GhRunner } from './ghc'

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
  /** New items not yet delivered (newest ITEM_MAX); one message per PR is built from them at delivery. */
  pending: PrItem[]
  /** Lines that go after the items: the baseline summary, merged/closed, stopped. */
  notes: string[]
  events: number
  lastEventAt: number | null
  ended: boolean
  /** Light reads in a row that came back without this PR (gone, or no access). */
  misses?: number
}

export interface PrWatchDeps {
  gh: GhRunner
  paused: (output?: string) => boolean
  send: (s: Session, text: string) => Promise<CliResult>
  onChange: () => void
}

const DONE_MAX = 500
/** Items kept per PR while the session is busy (the message lists 10 per kind and "and N more"). */
const ITEM_MAX = 30
const TEXT_MAX = 300
/** Light reads in a row without the PR before its watch ends. */
const MISS_MAX = 3
/** Longest paste: PRs past it wait for the next delivery. */
export const PASTE_MAX = 6_000
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
  private loaded = false

  constructor(
    private file: string,
    private deps: PrWatchDeps,
  ) {}

  /** Until it ran, sync and save do nothing (a watch list not read yet must not be overwritten). */
  load(): void {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.loaded = true
      else console.error(`PR watch: cannot read ${this.file}: ${String(e)}`)
      return
    }
    try {
      const raw = JSON.parse(text) as { watches?: PrWatchEntry[]; done?: string[] }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
      this.list = (Array.isArray(raw.watches) ? raw.watches : [])
        .filter((w) => typeof w?.url === 'string' && safeRef(w) && Array.isArray(w.seen) && Array.isArray(w.pending))
        .map((w) => ({ ...w, pending: w.pending.filter((i) => typeof i?.key === 'string'), notes: Array.isArray(w.notes) ? w.notes.filter((n) => typeof n === 'string') : [] }))
      this.done = (Array.isArray(raw.done) ? raw.done : []).filter((u) => typeof u === 'string').slice(-DONE_MAX)
    } catch (e) {
      const aside = `${this.file.replace(/\.json$/, '')}.corrupt.${Date.now()}.json`
      try {
        renameSync(this.file, aside)
      } catch {
        // left in place: overwritten by the next save
      }
      console.error(`PR watch: ${this.file} unreadable (${String(e)}); moved to ${aside}`)
    }
    this.loaded = true
  }

  private save(): void {
    if (!this.loaded) return
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
    if (line) w.notes.push(line)
    if (!this.done.includes(w.url)) this.done.push(w.url)
  }

  sync(state: Pick<AppState, 'sessions' | 'sessionPrs' | 'prLive'>, on: (s: Session) => boolean, now = Date.now()): void {
    if (!this.loaded) return
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
          seen: [], updatedAt: null, mergeable: null, heavyAt: 0, stallAt: null, nudges: 0, pending: [], notes: [], events: 0, lastEventAt: null, ended: false,
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
        if (this.deps.paused(ghErrorText(r))) return
        me = parseViewer(r.stdout) ?? me
        // No answer, or no "me" to tell own replies apart: touch nothing, try again next minute.
        // gh exits 1 on a partial error (one PR it cannot read) and still prints the others.
        if (!ghHasData(r) || !me) continue
        const viewer = me
        parseLight(r.stdout, group.length).forEach((l, i) => {
          const w = group[i]
          if (!l) {
            w.misses = (w.misses ?? 0) + 1
            if (w.misses >= MISS_MAX) this.end(w, `[MasterDeck PR watch] ${w.repo}#${w.number}: MasterDeck can't read this PR any more (${MISS_MAX} tries). The PR watch has ended.`)
            return
          }
          w.misses = 0
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
        if (this.deps.paused(ghErrorText(r))) break
        const viewer = parseViewer(r.stdout) ?? me
        // A failed read (or no "me") leaves `seen` as it was: nothing replays, nothing is baselined away.
        if (!ghHasData(r) || !viewer) continue
        parseHeavy(r.stdout, group.length).forEach((h, i) => {
          const { w, l } = group[i]
          if (!h) return
          const { items, stallAt } = prItems(h, viewer, now)
          const ending = h.state !== 'OPEN'
          // Older PR: counted once in a summary, its items never listed.
          const summary = w.baseline && !ending ? baselineMessage(w, items) : ''
          const news = w.baseline || ending ? [] : fresh(items, w.seen)
          w.baseline = false
          w.seen = items.map((x) => x.key)
          w.updatedAt = l.updatedAt
          w.mergeable = h.mergeable
          w.heavyAt = now
          w.stallAt = stallAt
          if (summary) w.notes.push(summary)
          const keys = new Set(news.map((x) => x.key))
          w.pending = [...w.pending.filter((x) => !keys.has(x.key)), ...news.map((x) => ({ ...x, text: x.text.slice(0, TEXT_MAX) }))].slice(-ITEM_MAX)
          if (news.length || summary || ending) {
            w.events += news.length + (summary || ending ? 1 : 0)
            w.lastEventAt = now
          }
          if (ending) this.end(w, prWatchMessage(w, items, w.nudges).text)
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
      const waiting = ws.filter((w) => w.pending.length || w.notes.length)
      if (!waiting.length) {
        if (ws.some((w) => w.ended)) {
          this.list = this.list.filter((w) => !(w.sessionKey === key && w.ended))
          this.save()
        }
        continue
      }
      // One message per PR, built now from what accumulated; PRs past PASTE_MAX wait for next time.
      const taken: { w: PrWatchEntry; keys: Set<string>; notes: number; nudges: number; text: string }[] = []
      let size = 0
      for (const w of waiting) {
        const m = prWatchMessage(w, w.pending, w.nudges)
        if (!m.text) w.pending = [] // nothing to say about them (a stall past its nudges): dropped
        const text = [m.text, ...w.notes].filter(Boolean).join('\n')
        if (!text) continue
        if (taken.length && size + text.length > PASTE_MAX) break
        taken.push({ w, keys: new Set(w.pending.map((x) => x.key)), notes: w.notes.length, nudges: m.nudges, text })
        size += text.length + 1
      }
      if (!taken.length) {
        this.save()
        continue
      }
      const rest = waiting.filter((w) => w.pending.length || w.notes.length).length - taken.length
      const text = [...taken.map((t) => t.text), ...(rest ? [`(${rest} more PR update${rest === 1 ? '' : 's'} — check MasterDeck)`] : [])].join('\n')
      this.sending.add(key)
      void this.deps
        .send(s, text)
        .then((r) => {
          if (!r.ok) return
          for (const t of taken) {
            t.w.pending = t.w.pending.filter((x) => !t.keys.has(x.key))
            t.w.notes.splice(0, t.notes)
            t.w.nudges = t.nudges
          }
          this.list = this.list.filter((w) => !(w.ended && !w.pending.length && !w.notes.length))
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
        queued: w.pending.length + w.notes.length,
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

  /**
   * PRs being watched. With `reachable`: only those whose session can take a message now (a review
   * offer stays in Needs you for a parked session, one on a prompt, or one master cannot reach).
   */
  watched(sessions?: Session[], reachable?: (s: Session) => boolean): Set<string> {
    return new Set(
      this.list
        .filter((w) => {
          if (w.ended) return false
          if (!sessions || !reachable) return true
          const s = sessions.find((x) => x.key === w.sessionKey)
          return !!s && reachable(s)
        })
        .map((w) => w.url),
    )
  }
}

/** Live state of PRs for the board moves: one light query per 50 PRs, cached five minutes. */
export async function prStates(gh: GhRunner, urls: string[]): Promise<Record<string, { state: string; isDraft: boolean }>> {
  const refs = [...new Set(urls)].map((u) => ({ u, r: parsePrUrl(u) })).filter((x): x is { u: string; r: PrRef } => !!x.r && safeRef(x.r))
  const out: Record<string, { state: string; isDraft: boolean }> = {}
  for (const group of chunks(refs, LIGHT_MAX)) {
    const r = await gh(graphql(lightQuery(group.map((g) => g.r))), { ttl: 300, timeoutMs: 30_000 })
    if (!ghHasData(r)) continue
    parseLight(r.stdout, group.length).forEach((l, i) => l && (out[group[i].u] = { state: l.state, isDraft: l.isDraft }))
  }
  return out
}
