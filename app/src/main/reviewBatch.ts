import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  activeEntries, addToBatch, applyLine, batchLabel, batchPrompt, batchTabView, cancelBatch, isRunning, parseLogLines, retryItem,
  type BatchItem, type BatchTab, type BatchView,
} from '@shared/reviewBatch'
import { prLabel } from '@shared/prReview'
import type { TeamPr } from '@shared/teamPrs'
import { TICKET_TAB } from '@shared/ticketBuilder'

export interface ReviewBatchDeps {
  /** The post script's log of a tab (prReviewBatchLog). */
  logFile: (tabId: string) => string
  /** The batch file the post script trusts (writePrReviewBatch). */
  writeBatch: (tabId: string, entries: { url: string; id: string }[]) => void
  /** context.json's `batch` (writePrReviewContextBatch). */
  writeContext: (tabId: string, items: BatchItem[]) => void
  onChange: () => void
}

type Saved = { tabs?: Record<string, BatchTab>; offsets?: Record<string, number> }

export type BatchResult = { ok: boolean; message: string; prompt?: string }

const newId = (): string => randomBytes(6).toString('hex')

/** Bytes of a log read at most per tick (a log never holds more than a few lines per PR). */
const READ_MAX = 1 << 20

/**
 * Review selected (#176): a batch per PR tab, the PRs the user ticked (their facts from MasterDeck's
 * own list). Every change rewrites the batch file beside the guard (what the post script may post to)
 * and context.json's `batch`; every 2 s the post script's log is read from where it was left and
 * folded in (shared/reviewBatch.ts). Kept in `review-batch.json` (atomically), with the log offsets.
 */
export class ReviewBatch {
  private tabs: Record<string, BatchTab> = {}
  private offsets: Record<string, number> = {}

  constructor(
    private file: string,
    private deps: ReviewBatchDeps,
    private now: () => number = Date.now,
    private id: () => string = newId,
  ) {}

  load(): void {
    let raw: Saved = {}
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8')) as Saved
    } catch {
      return
    }
    for (const [tabId, t] of Object.entries(raw?.tabs ?? {}))
      if (TICKET_TAB.test(tabId) && Array.isArray(t?.items)) this.tabs[tabId] = { items: t.items.filter((i) => typeof i?.id === 'string' && typeof i.url === 'string'), startedAt: Number(t.startedAt) || 0 }
    for (const [tabId, n] of Object.entries(raw?.offsets ?? {})) if (this.tabs[tabId] && typeof n === 'number' && n >= 0) this.offsets[tabId] = n
    // The batch files are main's: written again from what was kept (a file left from before agrees with it).
    for (const tabId of Object.keys(this.tabs)) this.write(tabId, false)
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ tabs: this.tabs, offsets: this.offsets }, null, 1))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`review batch: ${String(e)}`)
    }
  }

  /** The batch file and the context follow the tab's batch; `context`: context.json too. */
  private write(tabId: string, context = true): void {
    const t = this.tabs[tabId]
    try {
      this.deps.writeBatch(tabId, activeEntries(t))
      if (context) this.deps.writeContext(tabId, t?.items ?? [])
    } catch (e) {
      console.error(`review batch: ${String(e)}`)
    }
  }

  private changed(tabId: string): void {
    this.write(tabId)
    this.save()
    this.deps.onChange()
  }

  /** The tab's items (for a context written from scratch). */
  items(tabId: string): BatchItem[] {
    return this.tabs[tabId]?.items ?? []
  }

  /**
   * Review selected: the URLs, looked up in `prs` (MasterDeck's own list). Answers the line to type
   * into the tab's session, naming the PRs queued now; nothing queued: no line.
   */
  add(tabId: unknown, urls: unknown, prs: TeamPr[]): BatchResult {
    if (typeof tabId !== 'string' || !TICKET_TAB.test(tabId)) return { ok: false, message: 'refusing a batch for a bad PR tab' }
    if (!Array.isArray(urls) || !urls.length || urls.length > 200 || !urls.every((u) => typeof u === 'string' && u.length <= 300))
      return { ok: false, message: 'no PRs to review' }
    const prev = this.tabs[tabId]
    const fresh = !isRunning(prev)
    const r = addToBatch(prev, urls as string[], prs, this.now(), this.id)
    if (r.added.length) {
      // A new batch: what the old log still holds is read first (a post after Cancel), then it goes.
      if (fresh) {
        this.read(tabId)
        this.resetLog(tabId)
      }
      this.tabs[tabId] = r.tab
      this.changed(tabId)
    }
    const parts = [
      r.added.length ? `Queued ${r.added.length} PR${r.added.length === 1 ? '' : 's'}` : null,
      r.kept.length ? `${r.kept.length} already in the batch` : null,
      ...r.refused.slice(0, 3).map((x) => `${prLabel(x.url).slice(0, 80)}: ${x.why}`),
      r.refused.length > 3 ? `${r.refused.length - 3} more not taken` : null,
    ].filter(Boolean)
    return {
      ok: r.added.length > 0 || r.kept.length > 0,
      message: parts.join(' · ') || 'nothing to review',
      ...(r.added.length ? { prompt: batchPrompt(r.added) } : {}),
    }
  }

  /** Cancel batch: no more posts for what is not posted yet. `forget`: the tab is gone (closed in the window). */
  cancel(tabId: unknown, forget = false): BatchResult {
    if (typeof tabId !== 'string' || !TICKET_TAB.test(tabId) || !Object.hasOwn(this.tabs, tabId)) return { ok: true, message: 'no batch' }
    const n = cancelBatch(this.tabs[tabId], this.now())
    if (forget) {
      this.write(tabId)
      delete this.tabs[tabId]
      delete this.offsets[tabId]
      this.save()
      this.deps.onChange()
      return { ok: true, message: 'forgotten' }
    }
    if (n) this.changed(tabId)
    return { ok: true, message: n ? `Cancelled ${n} PR${n === 1 ? '' : 's'}` : 'nothing to cancel' }
  }

  /** Retry one PR (failed, skipped or cancelled): queued again, and its line to type. */
  retry(tabId: unknown, url: unknown): BatchResult {
    if (typeof tabId !== 'string' || !TICKET_TAB.test(tabId) || !Object.hasOwn(this.tabs, tabId) || typeof url !== 'string') return { ok: false, message: 'no such PR in the batch' }
    const i = retryItem(this.tabs[tabId], url, this.now(), this.id)
    if (!i) return { ok: false, message: 'that PR is being reviewed or was posted' }
    this.changed(tabId)
    return { ok: true, message: `Queued ${batchLabel(i)} again`, prompt: batchPrompt([i]) }
  }

  private resetLog(tabId: string): void {
    this.offsets[tabId] = 0
    const log = this.deps.logFile(tabId)
    try {
      truncateSync(log, 0)
    } catch {
      /* none yet */
    }
    // The post script's claims (one folder per posted id): the old ids are gone with the log.
    rmSync(`${log}.d`, { recursive: true, force: true })
  }

  /**
   * What a tab's post script logged since the last read, folded in; whether anything was read. Every
   * tab is read, also one whose PRs all ended: a post that lands after Cancel batch must show.
   */
  private read(tabId: string): boolean {
    const t = this.tabs[tabId]
    const file = this.deps.logFile(tabId)
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return false
    }
    let from = this.offsets[tabId] ?? 0
    // Shorter than read: a new log (truncated); read it from the start.
    if (size < from) from = 0
    if (size === from) return false
    const len = Math.min(size - from, READ_MAX)
    const buf = Buffer.alloc(len)
    let fd: number | null = null
    try {
      fd = openSync(file, 'r')
      readSync(fd, buf, 0, len, from)
    } catch {
      return false
    } finally {
      if (fd !== null) closeSync(fd)
    }
    // Only whole lines: one being written is read on the next tick.
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) {
      if (len === READ_MAX) this.offsets[tabId] = from + len
      return false
    }
    this.offsets[tabId] = from + end + 1
    let moved = false
    for (const line of parseLogLines(buf.subarray(0, end + 1).toString('utf8'))) moved = applyLine(t, line, this.now()) || moved
    if (moved) this.write(tabId)
    return true
  }

  /** Reads what each tab's post script logged since the last tick (a stat per tab when nothing changed). */
  tick(): void {
    let any = false
    for (const tabId of Object.keys(this.tabs)) any = this.read(tabId) || any
    if (any) {
      this.save()
      this.deps.onChange()
    }
  }

  view(): BatchView {
    const out: BatchView = {}
    for (const [tabId, t] of Object.entries(this.tabs)) if (t.items.length) out[tabId] = batchTabView(t)
    return out
  }
}
