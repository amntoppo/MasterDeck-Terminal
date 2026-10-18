import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MASTER_NAME } from '@shared/derive'
import { groupByAccount } from '@shared/accounts'
import type { AppConfig } from '@shared/appConfig'
import { parsePrUrl } from '@shared/prSummary'
import {
  BASELINE_AGE_MS, baselineMessage, fresh, HEAVY_EVERY_MS, HEAVY_MAX, heavyQuery, LIGHT_MAX, lightQuery, parseHeavy, parseLight, parseViewer, prItems, prWatchMessage, safeRef, type LightPr, type OwnCheck, type PrItem, type PrRef,
} from '@shared/prWatch'
import { canDeliver, pushEvents, type WatchEvent, type WatchInfo } from '@shared/watches'
import { MANUAL_MAX, reviewWatchLine, watchReady, type PrWatchRow } from '@shared/watchPr'
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
  /** Added in the first run: its first full read is recorded as seen and says nothing. */
  quiet?: boolean
  /** The watched session's GitHub account (two or more connected); its runner reads this PR. */
  account?: string
  /** What it found, for Session details (memory only: never saved). */
  log?: WatchEvent[]
  /** Keys of items by the watch's account that the session posted itself: never news, also after a restart. */
  own?: string[]
  /** Items by the watch's account held back because the session's transcript could not be read. */
  unchecked?: number
  /** The last read that failed (cleared by the next good one), and the last good one. */
  error?: string
  errorAt?: number
  okAt?: number
  /** Started by the user (the eye, the Add field; #182), not by a session's own PR. Never ends because its author is not the account. */
  manual?: true
  /** The PR tab it was started from: its Review with Claude session takes the news while no session owns the PR. */
  tabId?: string
  tabName?: string
  title?: string
  /** The head commit last read (manual watches): a new one is new commits. */
  head?: string
  /** The head a "ready to merge" was told for. */
  readyHead?: string
}

/** What a watch no session owns hands the PR tab's Review with Claude session (#182; main/autoReview.ts). */
export interface WatchReview {
  /** Type `text` into the tab's review session now (or start it with it); not ok: busy, try again later. */
  say: (w: PrWatchEntry, text: string) => CliResult
  /** New commits: the PR is reviewed for the tab, by Automate Review's rules. */
  rereview: (w: PrWatchEntry) => void
  /** Ready to merge (at `head`), merged, closed, or no longer readable: Needs you. */
  notify: (w: PrWatchEntry, kind: 'ready' | 'merged' | 'closed' | 'gone', head?: string) => void
  /** The watch ended: what Automate Review followed for it goes. */
  stopped: (w: PrWatchEntry) => void
}

/** A manual watch no session owns: its news goes to its PR tab's review session. */
const toReview = (w: PrWatchEntry): boolean => !!w.manual && !w.sessionKey && !!w.tabId

export interface PrWatchDeps {
  gh: GhRunner
  /** One runner per account (two or more); absent: deps.gh for all. */
  ghFor?: (account: string | undefined) => GhRunner
  paused: (output?: string) => boolean
  send: (s: Session, text: string) => Promise<CliResult>
  onChange: () => void
  /** A watched PR was seen merged or closed (the session's lane follows it). */
  ended?: (url: string) => void
  /**
   * Whether the session wrote this text itself (its transcript's tool calls, read up to now); null
   * when its transcript is not known. Absent: everything by the watch's account is the session's.
   */
  ownPost?: (sessionKey: string) => ((body: string) => boolean) | null
  /** Where a watch no session owns sends its news (absent: nowhere, it is only shown). */
  review?: WatchReview
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
/**
 * The first run (no pr-watch.json: a new install, or the upgrade from the babysit-pr skill): PRs
 * that sessions already have show up over the first polls, and their history is not news.
 * ponytail: a fixed window; a PR opened inside it is baselined silently too.
 */
const FIRST_RUN_MS = 10 * 60_000
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))
const graphql = (q: string) => ['api', 'graphql', '-f', `query=${q}`]
const ERROR_MAX = 300
/** Why a read gave nothing to go on, in one line for Details. */
function readError(r: CliLike, viewer: string | null): string {
  const text = ghErrorText(r).trim().replace(/\s+/g, ' ')
  if (text) return text.slice(0, ERROR_MAX)
  if (!ghHasData(r)) return `gh exited ${r.code} without an answer`
  return viewer ? 'GitHub answered without this PR' : 'GitHub did not say which account is signed in (no viewer)'
}
type CliLike = { code: number; stdout: string; stderr: string }
const pauseError = (r: CliLike): string => ghErrorText(r).trim().replace(/\s+/g, ' ').slice(0, ERROR_MAX) || 'GitHub calls are paused (rate limit)'

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
  private quietUntil = 0

  constructor(
    private file: string,
    private deps: PrWatchDeps,
  ) {}

  /** Until it ran, sync and save do nothing (a watch list not read yet must not be overwritten). */
  load(now = Date.now()): void {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        this.quietUntil = now + FIRST_RUN_MS
      } else console.error(`PR watch: cannot read ${this.file}: ${String(e)}`)
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
      const watches = this.list.map(({ log: _log, ...w }) => w)
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ watches, done: this.done.slice(-DONE_MAX) }, null, 1))
      renameSync(`${this.file}.tmp`, this.file)
    } catch {
      // next change
    }
  }

  private failed(ws: PrWatchEntry[], error: string, now: number): void {
    for (const w of ws) {
      w.error = error
      w.errorAt = now
    }
  }

  private ok(w: PrWatchEntry, now: number): void {
    delete w.error
    delete w.errorAt
    w.okAt = now
  }

  /**
   * Which items by the watch's account are the session's own posts: the ones recorded before, and
   * those whose text is in its transcript. Rebuilds `own` and `unchecked` for this read.
   */
  private ownCheck(w: PrWatchEntry): OwnCheck | undefined {
    // The review session posts as the account and has no transcript here: all of the account's is its own.
    if (!this.deps.ownPost || toReview(w)) return undefined
    // A watch from before #158 never had items by its account in `seen` (they were all dropped):
    // what is on the PR now is taken for the session's own, as a baseline, and only later ones count.
    const legacy = w.own === undefined
    const wrote = legacy ? null : this.deps.ownPost(w.sessionKey)
    const had = new Set(w.own ?? [])
    w.own = []
    w.unchecked = 0
    return (key, body) => {
      if (legacy || had.has(key) || (wrote && wrote(body))) {
        w.own!.push(key)
        return true
      }
      // No transcript to tell them apart: held back as before #158, and counted so Details can say so.
      if (!wrote) {
        w.unchecked!++
        return true
      }
      return false
    }
  }

  private end(w: PrWatchEntry, line?: string, kind?: 'merged' | 'closed' | 'gone'): void {
    w.ended = true
    if (line) {
      // No session to tell: Needs you says it (a stop from MasterDeck says nothing).
      if (!toReview(w)) w.notes.push(line)
      else if (kind) this.deps.review?.notify(w, kind)
      pushEvents((w.log ??= []), [{ at: Date.now(), kind: 'note', text: line }])
    }
    if (!this.done.includes(w.url)) this.done.push(w.url)
    if (w.manual) this.deps.review?.stopped(w)
  }

  /**
   * A watch the user asked for (#182): `owner`, the session that owns the PR, if one does. One
   * watch per PR: one already watching it is kept (reused). It starts quiet: what is on the PR now
   * is not news.
   */
  start(
    x: { url: string; owner: string; repo: string; number: number; tabId: string; tabName: string; account: string | null; title: string; head: string },
    owner: Session | null,
    now = Date.now(),
  ): CliResult & { reused?: boolean } {
    if (!this.loaded) return { ok: false, message: 'MasterDeck is still reading its PR watches: try again in a moment' }
    if (!safeRef(x)) return { ok: false, message: 'Not a PR' }
    if (this.list.some((w) => w.url === x.url && !w.ended)) return { ok: true, reused: true, message: 'Already watched' }
    if (this.list.filter((w) => w.manual && !w.ended).length >= MANUAL_MAX) return { ok: false, message: `At most ${MANUAL_MAX} PRs can be watched by hand` }
    // An ended watch still holding its last lines is replaced; a stop is undone.
    this.list = this.list.filter((w) => w.url !== x.url)
    this.done = this.done.filter((u) => u !== x.url)
    this.list.push({
      url: x.url, owner: x.owner, repo: x.repo, number: x.number, sessionKey: owner?.key ?? '', ...(x.account ? { account: x.account } : {}),
      manual: true, tabId: x.tabId, tabName: x.tabName.slice(0, 100), title: x.title.slice(0, 300), ...(x.head ? { head: x.head } : {}),
      startedAt: now, baseline: false, quiet: true, log: [{ at: now, kind: 'note', text: 'watch started from MasterDeck' }],
      seen: [], own: [], updatedAt: null, mergeable: null, heavyAt: 0, stallAt: null, nudges: 0, pending: [], notes: [], events: 0, lastEventAt: null, ended: false,
    })
    this.save()
    this.deps.onChange()
    return { ok: true, message: 'Watching' }
  }

  /**
   * A PR tab was closed: the manual watches it sent to its review session end (nowhere is left to
   * send them); those a session owns go on, with no tab to fall back to.
   */
  forgetTab(tabId: string): void {
    let changed = false
    for (const w of this.list) {
      if (!w.manual || w.tabId !== tabId || w.ended) continue
      if (!w.sessionKey) this.end(w)
      delete w.tabId
      changed = true
    }
    if (!changed) return
    this.list = this.list.filter((w) => !(w.ended && !w.pending.length && !w.notes.length))
    this.save()
    this.deps.onChange()
  }

  /** New commits and "ready to merge" for a manual watch, from the light read (told only when no session owns it). */
  private lightNews(w: PrWatchEntry, l: LightPr, now: number): void {
    const was = w.head
    if (l.title) w.title = l.title.slice(0, 300)
    if (l.head) w.head = l.head
    if (!toReview(w) || l.state !== 'OPEN') return
    const log = (text: string) => {
      pushEvents((w.log ??= []), [{ at: now, kind: 'note', text }])
      w.events += 1
      w.lastEventAt = now
    }
    if (was && l.head && l.head !== was) {
      log(`new commits (${l.head.slice(0, 7)}): sent for review`)
      this.deps.review?.rereview(w)
    }
    if (watchReady(l) && w.readyHead !== l.head) {
      w.readyHead = l.head
      log('ready to merge')
      this.deps.review?.notify(w, 'ready', l.head)
    }
  }

  /** `owner`: the session that owns a PR now (a manual watch's news goes there while one does). */
  sync(state: Pick<AppState, 'sessions' | 'sessionPrs' | 'prLive'>, on: (s: Session) => boolean, now = Date.now(), owner?: (url: string) => Session | null): void {
    if (!this.loaded) return
    let changed = false
    for (const w of this.list) {
      if (!w.manual || w.ended || w.sessionKey) continue
      const s = owner?.(w.url)
      if (s && s.state !== 'done' && s.name !== MASTER_NAME) {
        w.sessionKey = s.key
        // The review session's posts were its own; the session's are told apart from now on, so what
        // the account has on the PR now is taken for its own once (the baseline path of ownCheck).
        delete w.own
        // The session works on the PR now: the tab's review session stops reviewing its pushes.
        this.deps.review?.stopped(w)
        changed = true
      }
    }
    for (const s of state.sessions) {
      if (s.state === 'done' || s.name === MASTER_NAME) continue
      if (!on(s)) {
        // Turned off (setting or workflow): its watches go without a word (the user's own stay).
        const before = this.list.length
        this.list = this.list.filter((w) => w.sessionKey !== s.key || w.manual)
        changed ||= this.list.length !== before
        continue
      }
      for (const url of state.sessionPrs[s.sessionId] ?? []) {
        const pr = state.prLive[url]
        const ref = parsePrUrl(url)
        if (pr?.state !== 'OPEN' || !ref || !safeRef(ref) || this.done.includes(url)) continue
        const have = this.list.find((w) => w.url === url)
        if (have) {
          // The session gained (or changed) its account after the watch began: read it as that account.
          if (s.account && have.sessionKey === s.key && have.account !== s.account && !have.manual) {
            have.account = s.account
            changed = true
          }
          continue
        }
        this.list.push({
          url, ...ref, sessionKey: s.key, ...(s.account ? { account: s.account } : {}), startedAt: now,
          baseline: pr.createdAt === null || now - pr.createdAt > BASELINE_AGE_MS,
          seen: [], own: [], updatedAt: null, mergeable: null, heavyAt: 0, stallAt: null, nudges: 0, pending: [], notes: [], events: 0, lastEventAt: null, ended: false,
          ...(now < this.quietUntil ? { quiet: true } : {}),
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
      // One pass per account: its own runner, so `viewer` (who "me" is) is that account.
      const byAccount = new Map<string, PrWatchEntry[]>()
      for (const w of this.list.filter((x) => !x.ended)) byAccount.set(w.account ?? '', [...(byAccount.get(w.account ?? '') ?? []), w])
      // A limited answer skips only that account (its queued full reads too); the others still run and save.
      accounts: for (const [account, ws] of byAccount) {
        const gh = this.deps.ghFor?.(account || undefined) ?? this.deps.gh
        const heavy: { w: PrWatchEntry; l: LightPr }[] = []
        let me: string | null = null
        for (const group of chunks(ws, LIGHT_MAX)) {
          const r = await gh(graphql(lightQuery(group)), { ttl: POLL_TTL, timeoutMs: 30_000 })
          if (this.deps.paused(ghErrorText(r))) {
            this.failed(ws, pauseError(r), now)
            continue accounts
          }
          me = parseViewer(r.stdout) ?? me
          // No answer, or no "me" to tell own replies apart: touch nothing, try again next minute.
          // gh exits 1 on a partial error (one PR it cannot read) and still prints the others.
          if (!ghHasData(r) || !me) {
            this.failed(group, readError(r, me), now)
            continue
          }
          const viewer = me
          parseLight(r.stdout, group.length).forEach((l, i) => {
            const w = group[i]
            if (!l) {
              this.failed([w], readError(r, viewer), now)
              w.misses = (w.misses ?? 0) + 1
              if (w.misses >= MISS_MAX) this.end(w, `[MasterDeck PR watch] ${w.repo}#${w.number}: MasterDeck can't read this PR any more (${MISS_MAX} tries). The PR watch has ended.`, 'gone')
              return
            }
            w.misses = 0
            // A session's watch is for its own PRs; one the user asked for watches anyone's.
            if (!w.manual && l.author && l.author.toLowerCase() !== viewer.toLowerCase()) return this.end(w)
            if (w.manual) this.lightNews(w, l, now)
            const conflictKnown = w.seen.some((k) => k.startsWith('X:'))
            const due =
              w.heavyAt === 0 || l.updatedAt !== w.updatedAt || now - w.heavyAt >= HEAVY_EVERY_MS || (w.stallAt !== null && now >= w.stallAt) ||
              l.state !== 'OPEN' || (l.mergeable === 'CONFLICTING') !== conflictKnown
            // A due PR keeps its old updatedAt until its full read lands: a failed read is retried.
            if (due) heavy.push({ w, l })
            else {
              w.mergeable = l.mergeable
              this.ok(w, now)
            }
          })
        }
        for (const group of chunks(heavy, HEAVY_MAX)) {
          const r = await gh(graphql(heavyQuery(group.map((g) => g.w))), { ttl: POLL_TTL, timeoutMs: 30_000 })
          if (this.deps.paused(ghErrorText(r))) {
            this.failed(heavy.map((h) => h.w), pauseError(r), now)
            continue accounts
          }
          const viewer = parseViewer(r.stdout) ?? me
          // A failed read (or no "me") leaves `seen` as it was: nothing replays, nothing is baselined away.
          if (!ghHasData(r) || !viewer) {
            this.failed(group.map((g) => g.w), readError(r, viewer), now)
            continue
          }
          parseHeavy(r.stdout, group.length).forEach((h, i) => {
            const { w, l } = group[i]
            if (!h) return this.failed([w], readError(r, viewer), now)
            this.ok(w, now)
            const { items, stallAt } = prItems(h, viewer, now, this.ownCheck(w))
            const ending = h.state !== 'OPEN'
            const quiet = !!w.quiet
            // Older PR: counted once in a summary, its items never listed. First run: not even that.
            const summary = w.baseline && !ending && !quiet ? baselineMessage(w, items) : ''
            const news = w.baseline || ending || quiet ? [] : fresh(items, w.seen)
            w.baseline = false
            delete w.quiet
            w.seen = items.map((x) => x.key)
            w.updatedAt = l.updatedAt
            w.mergeable = h.mergeable
            w.heavyAt = now
            w.stallAt = stallAt
            if (summary) w.notes.push(summary)
            pushEvents((w.log ??= []), [
              ...(summary ? [{ at: now, kind: 'note', text: summary }] : []),
              ...news.map((x) => ({ at: now, kind: x.kind, ...(x.by ? { by: x.by } : {}), text: x.text || (x.kind === 'conflict' ? `merge conflict with ${x.base}` : '') })),
            ])
            const keys = new Set(news.map((x) => x.key))
            w.pending = [...w.pending.filter((x) => !keys.has(x.key)), ...news.map((x) => ({ ...x, text: x.text.slice(0, TEXT_MAX) }))].slice(-ITEM_MAX)
            if (news.length || summary || ending) {
              w.events += news.length + (summary || ending ? 1 : 0)
              w.lastEventAt = now
            }
            if (ending) {
              this.end(w, quiet ? undefined : prWatchMessage(w, items, w.nudges).text, h.state === 'MERGED' ? 'merged' : 'closed')
              this.deps.ended?.(w.url)
            }
          })
        }
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
      if (!key) {
        this.deliverReview(ws)
        continue
      }
      const s = sessions.find((x) => x.key === key)
      if (s) this.missingSince.delete(key)
      else if (!this.missingSince.has(key)) this.missingSince.set(key, now)
      const gone = s ? s.state === 'done' : now - (this.missingSince.get(key) ?? now) > 120_000
      if (gone) {
        // A manual watch outlives its session: from now on its news goes to its tab's review session.
        for (const w of ws) if (w.manual && w.tabId && !w.ended) w.sessionKey = ''
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

  /**
   * A tab's review session takes the news of the watches no session owns: one line per PR,
   * once its turn is over (`review.say` says when). Session-worded lines (ends, a stop) are not
   * typed there: the ends went to Needs you.
   */
  private deliverReview(ws: PrWatchEntry[]): void {
    let changed = false
    for (const w of ws) {
      if (w.notes.length) {
        w.notes = []
        changed = true
      }
      if (w.ended || !w.tabId) {
        this.list = this.list.filter((x) => x !== w)
        changed = true
        continue
      }
      if (!w.pending.length || !this.deps.review) continue
      const text = reviewWatchLine(w, w.title ?? '', w.pending)
      if (text && !this.deps.review.say(w, text).ok) continue
      w.pending = []
      changed = true
    }
    if (changed) {
      this.save()
      this.deps.onChange()
    }
  }

  /** Every watch, as the window shows it (the eye, the Watched PRs list). */
  rows(sessions: Session[]): PrWatchRow[] {
    return this.list
      .filter((w) => !w.ended)
      .map((w) => {
        const s = w.sessionKey ? sessions.find((x) => x.key === w.sessionKey) : undefined
        const last = w.log?.length ? w.log[w.log.length - 1] : null
        return {
          url: w.url,
          repo: `${w.owner}/${w.repo}`,
          number: w.number,
          title: (w.title ?? '').slice(0, 200),
          manual: !!w.manual,
          tabId: w.tabId ?? null,
          tabName: w.tabName ?? null,
          account: w.account ?? null,
          target: s ? { session: { key: s.key, name: s.name } } : toReview(w) ? { review: w.tabId! } : null,
          lastEvent: last ? { at: last.at, text: last.text.slice(0, 200) } : w.lastEventAt ? { at: w.lastEventAt, text: '' } : null,
          startedAt: w.startedAt,
          error: w.error ?? null,
        }
      })
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
        ...(w.error ? { error: w.error, errorAt: w.errorAt ?? null } : {}),
        ...(w.okAt ? { okAt: w.okAt } : {}),
        ...(w.unchecked ? { unchecked: w.unchecked } : {}),
      }))
  }

  /** A watch's last finds, newest first (`pr:<url>`, as in info()). */
  events(id: string): WatchEvent[] {
    return [...(this.list.find((x) => `pr:${x.url}` === id)?.log ?? [])].reverse()
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

/** prStates per account: one batched light read per account, with that account's runner. */
export async function prStatesFor(ghFor: (login: string) => GhRunner, cfg: AppConfig, urls: string[]): Promise<Record<string, { state: string; isDraft: boolean }>> {
  // In parallel; an account whose read fails (or throws) gives nothing, the others still answer.
  const parts = await Promise.all([...groupByAccount(urls, cfg)].map(([login, us]) => prStates(ghFor(login), us).catch(() => ({}))))
  return Object.assign({}, ...parts)
}
