import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  autoPrompt, autoQuery, autoSearch, label, mergeArgs, normalizeTab, parseAutoAnswer, parseTurn, POLL_MS, reconcile, TRACK_MAX, TYPING_MS,
  type AutoPr, type AutoReviewTab, type AutoReviewView, type AutoTrack,
} from '@shared/autoReview'
import { parsePrUrl } from '@shared/prSummary'
import { safeRef } from '@shared/prWatch'
import { TICKET_TAB } from '@shared/ticketBuilder'
import { pushEvents, type WatchEvent, type WatchInfo } from '@shared/watches'
import type { CliResult } from '@shared/types'
import { ghErrorText, ghHasData, type GhRunner } from './ghc'

/** The review panes, as Automate Review needs them (main/index.ts gives PtyManager and the turn files). */
export interface ReviewPanes {
  /** The tab's running review pane, if any. */
  live(tabId: string): string | null
  /** Its turn is over (the folder's hooks say so) and the user is not typing into it. */
  ready(tabId: string, paneId: string, sentAt: number): boolean
  /** Type one line and Enter. */
  type(paneId: string, text: string): void
  /** Start the tab's review session with `prompt` as its first message: its pane id, or why not. */
  start(tabId: string, tab: AutoReviewTab, prompt: string): { paneId: string } | { error: string }
}

export interface AutoReviewDeps {
  ghFor: (account: string | null) => GhRunner
  paused: (output?: string) => boolean
  /** Where the tab's account's PRs are: its owner (null: unknown, no scope). */
  scope: (account: string | null) => { owner: string | null; ownerType: 'organization' | 'user' }
  panes: ReviewPanes
  /** Automate Review's queue for a tab, for post-review.sh --auto (outside the review folder). */
  writeQueue: (tabId: string, urls: string[]) => void
  notify: (n: { title: string; body: string; url: string }) => void
  onChange: () => void
}

type Saved = { tabs?: Record<string, AutoReviewTab>; tracks?: AutoTrack[] }

/** Automate Review's monitor in the monitors list. */
export const monitorId = (tabId: string): string => `review:${tabId}`

/**
 * Automate Review and Merge automatically (#157): every 2 minutes, for each PR tab with the switch
 * on, one GitHub read as its account (review requests to the user, and the PRs it follows), the
 * steps shared/autoReview.ts decides, one PR at a time typed into the tab's review session once its
 * turn is over, and a merge only through mergeGuard. Kept in `auto-review.json` (atomically).
 */
export class AutoReview {
  private tabs: Record<string, AutoReviewTab> = {}
  private tracks: AutoTrack[] = []
  private checks: Record<string, { at: number | null; error: string | null }> = {}
  private logs: Record<string, WatchEvent[]> = {}
  private counts: Record<string, number> = {}
  /** The last read of each PR (by URL), for the line typed into the session. */
  private prs = new Map<string, AutoPr>()
  /** When a PR was last typed into each tab's session. */
  private sent: Record<string, number> = {}
  private panesSeen: Record<string, string | null> = {}
  private polling = false
  private lastPoll = 0

  constructor(
    private file: string,
    private deps: AutoReviewDeps,
    private now: () => number = Date.now,
  ) {}

  load(): void {
    let raw: Saved = {}
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8')) as Saved
    } catch {
      return
    }
    for (const [id, t] of Object.entries(raw?.tabs ?? {})) if (TICKET_TAB.test(id) && t?.review) this.tabs[id] = normalizeTab(t, t, t.since)
    this.tracks = (Array.isArray(raw?.tracks) ? raw.tracks : [])
      .filter((t) => typeof t?.url === 'string' && parsePrUrl(t.url) && typeof t.key === 'string' && TICKET_TAB.test(t.tabId) && Array.isArray(t.told))
      // MasterDeck stopped during a merge: what happened is not known, so it is not tried again for that commit.
      .map((t) => (t.status === 'merging' ? { ...t, status: 'merge-failed' as const, note: 'MasterDeck stopped during the merge: check the PR' } : t))
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ tabs: this.tabs, tracks: this.tracks }, null, 1))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`auto review: ${String(e)}`)
    }
  }

  private event(tabId: string, text: string, kind?: string): void {
    pushEvents((this.logs[tabId] ??= []), [{ at: this.now(), text, ...(kind ? { kind } : {}) }])
    this.counts[tabId] = (this.counts[tabId] ?? 0) + 1
  }

  /**
   * The switches of a tab (from the panel). `remote`: asked by a browser, which may switch either
   * off and Automate Review on, never Merge automatically on (the Mac's window asks first).
   */
  set(tabId: unknown, raw: unknown, remote = false): CliResult {
    if (typeof tabId !== 'string' || !TICKET_TAB.test(tabId)) return { ok: false, message: 'refusing switches for a bad PR tab' }
    const prev = this.tabs[tabId]
    const next = normalizeTab(raw, prev, this.now())
    if (remote && next.merge && !prev?.merge) return { ok: false, message: 'Merge automatically can be turned on in the Mac’s window only' }
    if (!next.review) {
      if (prev) this.event(tabId, 'Automate Review switched off', 'note')
      delete this.tabs[tabId]
      this.deps.writeQueue(tabId, [])
    } else {
      if (!prev) this.event(tabId, 'Automate Review switched on', 'note')
      if (next.merge !== !!prev?.merge) this.event(tabId, `Merge automatically switched ${next.merge ? 'on' : 'off'}`, 'note')
      // Another account: what the old one followed is not this tab's any more.
      if (prev && (prev.account ?? '') !== (next.account ?? '')) this.tracks = this.tracks.filter((t) => t.tabId !== tabId || t.status === 'merged' || t.status === 'closed')
      this.tabs[tabId] = next
      if (!prev) this.lastPoll = 0
    }
    this.save()
    this.deps.onChange()
    return { ok: true, message: next.review ? 'on' : 'off' }
  }

  /** The tab is gone (closed in the window): its switches go, its PRs are not followed. */
  forget(tabId: string): void {
    if (!this.tabs[tabId] && !this.tracks.some((t) => t.tabId === tabId)) return
    delete this.tabs[tabId]
    this.tracks = this.tracks.filter((t) => t.tabId !== tabId)
    this.deps.writeQueue(tabId, [])
    this.save()
    this.deps.onChange()
  }

  due(): boolean {
    return Object.keys(this.tabs).length > 0 && this.now() - this.lastPoll >= POLL_MS
  }

  async poll(): Promise<void> {
    if (this.polling || !Object.keys(this.tabs).length || this.deps.paused()) return
    this.polling = true
    this.lastPoll = this.now()
    try {
      for (const [tabId, tab] of Object.entries(this.tabs)) await this.pollTab(tabId, tab)
      this.save()
      this.deps.onChange()
    } finally {
      this.polling = false
    }
  }

  private async pollTab(tabId: string, tab: AutoReviewTab): Promise<void> {
    const gh = this.deps.ghFor(tab.account)
    const { owner, ownerType } = this.deps.scope(tab.account)
    const search = autoSearch(owner, ownerType, tab.filters.repo)
    const following = this.tracks.filter((t) => t.tabId === tabId && t.status !== 'merged' && t.status !== 'closed')
    const refs = following.map((t) => ({ t, r: parsePrUrl(t.url) })).filter((x) => x.r && safeRef(x.r))
    const tracked = new Map<string, AutoPr | null>()
    let viewer: string | null = null
    let requested: AutoPr[] | null = null
    let error: string | null = null
    for (let i = 0; i === 0 || i < refs.length; i += TRACK_MAX) {
      const group = refs.slice(i, i + TRACK_MAX)
      const args = ['api', 'graphql', '-f', `query=${autoQuery(group.map((g) => g.r!), i === 0)}`, ...(i === 0 ? ['-f', `q=${search}`] : [])]
      const r = await gh(args, { ttl: 60, timeoutMs: 30_000 })
      if (this.deps.paused(ghErrorText(r))) {
        error = 'GitHub calls are paused'
        break
      }
      if (!ghHasData(r)) {
        error = (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 200) || 'GitHub did not answer'
        break
      }
      const a = parseAutoAnswer(r.stdout, group.length)
      viewer = a.viewer ?? viewer
      if (i === 0) requested = a.requested
      group.forEach((g, k) => tracked.set(g.t.url, a.tracked[k]))
    }
    this.checks[tabId] = { at: error ? (this.checks[tabId]?.at ?? null) : this.now(), error }
    // Nothing is decided without knowing who the account is (its own review is what "sent" means).
    if (error || !viewer) {
      if (!error) this.checks[tabId].error = 'GitHub did not say who this account is'
      return
    }
    for (const p of [...(requested ?? []), ...[...tracked.values()].filter((p): p is AutoPr => !!p)]) this.prs.set(p.url, p)
    const out = reconcile({ tabId, tab, viewer, requested, tracked, tracks: this.tracks, now: this.now() })
    this.tracks = out.tracks
    for (const e of out.events) this.event(tabId, e)
    for (const n of out.notices) this.deps.notify(n)
    for (const m of out.merges) await this.merge(tabId, tab, m.track, m.pr)
  }

  /** The merge itself: mergeGuard passed in reconcile; gh decides with branch protection. */
  private async merge(tabId: string, tab: AutoReviewTab, t: AutoTrack, pr: AutoPr): Promise<void> {
    const r = await this.deps.ghFor(tab.account)(mergeArgs(pr), { timeoutMs: 60_000 })
    const live = this.tracks.find((x) => x.key === t.key)
    if (!live) return
    if (r.code === 0) {
      live.status = 'merged'
      live.note = null
      live.at = this.now()
      this.event(tabId, `merged ${label(live)}`, 'merged')
      this.deps.notify({ title: `Merged ${label(live)}`, body: `Merge automatically merged it (${(pr.method ?? 'merge').toLowerCase()}) · ${live.title.slice(0, 120)}`, url: live.url })
    } else {
      const why = (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) || `gh exited ${r.code}`
      live.status = 'merge-failed'
      live.note = why
      live.at = this.now()
      this.event(tabId, `could not merge ${label(live)}: ${why}`, 'note')
      this.deps.notify({ title: `Could not merge ${label(live)}`, body: why, url: live.url })
    }
  }

  /** Type the next PR into each tab's session whose turn is over; start one where none runs. */
  deliver(): void {
    let changed = false
    for (const [tabId, tab] of Object.entries(this.tabs)) {
      const pane = this.deps.panes.live(tabId)
      if (pane !== (this.panesSeen[tabId] ?? null)) {
        this.panesSeen[tabId] = pane
        changed = true
      }
      const next = this.tracks
        .filter((t) => t.tabId === tabId && t.status === 'queued' && this.prs.has(t.url))
        .sort((a, b) => a.at - b.at)[0]
      if (!next) continue
      const pr = this.prs.get(next.url)!
      const sentAt = this.sent[tabId] ?? 0
      if (pane && !this.deps.panes.ready(tabId, pane, sentAt)) continue
      // The queue first: the session may post as soon as it reads the line.
      this.deps.writeQueue(tabId, this.tracks.filter((t) => t.tabId === tabId && (t.status === 'queued' || t.status === 'reviewing')).map((t) => t.url))
      const line = autoPrompt(pr)
      if (pane) this.deps.panes.type(pane, line)
      else {
        const r = this.deps.panes.start(tabId, tab, line)
        if ('error' in r) {
          this.checks[tabId] = { at: this.checks[tabId]?.at ?? null, error: r.error }
          changed = true
          continue
        }
        this.panesSeen[tabId] = r.paneId
      }
      const now = this.now()
      this.sent[tabId] = now
      next.status = 'reviewing'
      next.sentHead = pr.head
      next.sentAt = now
      next.note = null
      next.at = now
      this.event(tabId, `sent ${label(next)} to the review session`)
      changed = true
    }
    if (changed) {
      this.save()
      this.deps.onChange()
    }
  }

  info(): WatchInfo[] {
    return Object.entries(this.tabs).map(([tabId, tab]) => {
      const log = this.logs[tabId] ?? []
      return {
        id: monitorId(tabId),
        sessionId: '',
        description: `Automate Review · ${tab.name}`,
        command: autoSearch(this.deps.scope(tab.account).owner, this.deps.scope(tab.account).ownerType, tab.filters.repo),
        startedAt: tab.since,
        events: this.counts[tabId] ?? 0,
        lastEventAt: log.length ? log[log.length - 1].at : null,
        queued: this.tracks.filter((t) => t.tabId === tabId && t.status === 'queued').length,
      }
    })
  }

  events(id: string): WatchEvent[] {
    return [...(this.logs[id.replace(/^review:/, '')] ?? [])].reverse()
  }

  /** Stop from a monitors list: the same as switching Automate Review off. */
  stop(id: string): boolean {
    const tabId = id.replace(/^review:/, '')
    if (!this.tabs[tabId]) return false
    return this.set(tabId, { review: false }).ok
  }

  view(): AutoReviewView {
    const tabs: AutoReviewView['tabs'] = {}
    for (const [id, t] of Object.entries(this.tabs))
      tabs[id] = { review: t.review, merge: t.merge, lastCheck: this.checks[id]?.at ?? null, error: this.checks[id]?.error ?? null, pane: this.panesSeen[id] ?? null }
    const prs = [...this.tracks]
      .sort((a, b) => b.at - a.at)
      .slice(0, 100)
      .map(({ url, repo, number, title, author, tabId, status, at, reviewUrl, comments, note }) => ({ url, repo, number, title: title.slice(0, 200), author, tabId, status, at, reviewUrl, comments, note }))
    return { tabs, prs }
  }
}

/** A busy turn this old with no "esc to interrupt" on screen was interrupted (Esc fires no Stop hook). */
export const BUSY_STALE_MS = 15 * 60_000
/** A start this old: its own first prompt, if it had one, would have made it busy by now. */
export const START_SETTLE_MS = 20_000

/**
 * Whether a review pane can take a line now: its hooks wrote "idle" after MasterDeck's last line
 * (or "start" a while ago), and the user has not typed into it for TYPING_MS.
 */
export function paneReady(turn: { value: string | null; at: number } | null, sentAt: number, inputAt: number, screenTail: string, now: number): boolean {
  if (now - inputAt < TYPING_MS) return false
  if (!turn) return false
  const v = parseTurn(turn.value)
  if (v === 'idle') return turn.at > sentAt && now - turn.at >= 1_000
  if (v === 'start') return turn.at > sentAt && now - turn.at >= START_SETTLE_MS
  // ponytail: Esc ends a turn without a Stop hook; after BUSY_STALE_MS the screen decides. A hook
  // on interrupts (if Claude Code adds one) would replace this.
  if (v === 'busy') return now - turn.at > BUSY_STALE_MS && now - sentAt > BUSY_STALE_MS && !/esc to interrupt/i.test(screenTail)
  return false
}

/** The turn file, with its time. */
export function readTurn(file: string): { value: string | null; at: number } | null {
  try {
    return { value: readFileSync(file, 'utf8'), at: statSync(file).mtimeMs }
  } catch {
    return null
  }
}

export type { AutoReviewTab }
