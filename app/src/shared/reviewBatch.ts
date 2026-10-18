/**
 * Review selected (#176), the pure half: the Pull requests view's Review with Claude session reviews
 * several PRs at once. Main keeps a batch per PR tab (main/reviewBatch.ts): the PRs the user ticked,
 * taken from MasterDeck's own list, each with an id and a status. The tab's post script may post to
 * the active ones only (the batch file beside the guard) and logs what happened to each
 * (`tab-<id>.batch-log.jsonl`); main folds those lines in here.
 */
import { prRef } from './prReview'
import type { TeamPr } from './teamPrs'

export type BatchStatus = 'queued' | 'reviewing' | 'posted' | 'skipped' | 'failed' | 'cancelled'

export interface BatchItem {
  /** New each time the PR is queued: the post script posts once per id. */
  id: string
  url: string
  /** owner/name. */
  repo: string
  number: number
  title: string
  status: BatchStatus
  /** Why skipped, failed or cancelled. */
  note: string | null
  /** The posted review. */
  reviewUrl: string | null
  comments: number
  /** Its last change. */
  at: number
}

export interface BatchTab {
  items: BatchItem[]
  startedAt: number
}

/** One line the post script logs. */
export interface BatchLine {
  id: string
  url: string
  status: 'reviewing' | 'posted' | 'skipped' | 'failed'
  note?: string
  review?: string
  comments?: number
}

/** What the post script may still post to: queued, reviewing, or failed (GitHub may answer the next time). */
const ACTIVE = new Set<BatchStatus>(['queued', 'reviewing', 'failed'])
/** Still to be done by the session: the batch runs while one is. */
const RUNNING = new Set<BatchStatus>(['queued', 'reviewing'])

export const BATCH_MAX = 30
export const NOTE_MAX = 300

export const batchLabel = (i: { repo: string; number: number }): string => `${i.repo}#${i.number}`

const clean = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v : '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

export const isRunning = (t: BatchTab | undefined): boolean => !!t?.items.some((i) => RUNNING.has(i.status))

/** The batch file's entries: what the post script accepts. */
export const activeEntries = (t: BatchTab | undefined): { url: string; id: string }[] =>
  (t?.items ?? []).filter((i) => ACTIVE.has(i.status)).map(({ url, id }) => ({ url, id }))

export interface AddResult {
  tab: BatchTab
  /** Queued now (new, or queued again). */
  added: BatchItem[]
  /** Already queued or being reviewed: left as they are. */
  kept: string[]
  /** Not taken, and why. */
  refused: { url: string; why: string }[]
}

/**
 * The user's Review selected: each URL looked up in MasterDeck's own list (`prs`), never taken on
 * the caller's word. One already queued or reviewing stays; one that ended is queued again with a
 * new id. When nothing runs, the ended ones go and a new batch starts.
 */
export function addToBatch(prev: BatchTab | undefined, urls: string[], prs: TeamPr[], now: number, newId: () => string): AddResult {
  const fresh = !isRunning(prev)
  const items = fresh ? [] : (prev?.items ?? []).map((i) => ({ ...i }))
  const added: BatchItem[] = []
  const kept: string[] = []
  const refused: AddResult['refused'] = []
  for (const url of [...new Set(urls)]) {
    const p = prs.find((x) => x.url === url)
    const ref = prRef(url)
    if (!p || !ref) {
      refused.push({ url, why: 'not in MasterDeck’s PR list' })
      continue
    }
    if (p.state !== 'open') {
      refused.push({ url, why: `it is ${p.state}` })
      continue
    }
    const have = items.find((i) => i.url === url)
    if (have && RUNNING.has(have.status)) {
      kept.push(url)
      continue
    }
    if (!(have && ACTIVE.has(have.status)) && activeEntries({ items, startedAt: 0 }).length >= BATCH_MAX) {
      refused.push({ url, why: `a batch holds at most ${BATCH_MAX} PRs` })
      continue
    }
    const item: BatchItem = { id: newId(), url, repo: `${ref.owner}/${ref.repo}`, number: p.number, title: clean(p.title, 200), status: 'queued', note: null, reviewUrl: null, comments: 0, at: now }
    if (have) items.splice(items.indexOf(have), 1, item)
    else items.push(item)
    added.push(item)
  }
  // Nothing new while nothing ran: the ended batch (and its summary) stays on screen.
  if (fresh && !added.length) return { tab: prev ?? { items: [], startedAt: now }, added, kept, refused }
  return { tab: { items, startedAt: fresh || !prev ? now : prev.startedAt }, added, kept, refused }
}

/**
 * One log line folded in. A line for an id that is not the PR's current one, or for a PR no longer
 * active (cancelled, done), changes nothing; `posted` is always taken (it happened on GitHub).
 */
export function applyLine(t: BatchTab, line: BatchLine, now: number): boolean {
  const i = t.items.find((x) => x.id === line.id && x.url === line.url)
  if (!i) return false
  if (line.status === 'posted') {
    if (i.status === 'posted') return false
    Object.assign(i, { status: 'posted', note: null, reviewUrl: clean(line.review, 500) || null, comments: typeof line.comments === 'number' && line.comments >= 0 ? Math.floor(line.comments) : 0, at: now })
    return true
  }
  if (!ACTIVE.has(i.status)) return false
  if (line.status === 'reviewing' && i.status === 'reviewing') return false
  i.status = line.status
  i.note = line.status === 'reviewing' ? null : clean(line.note, NOTE_MAX) || (line.status === 'failed' ? 'failed' : null)
  i.at = now
  return true
}

/** Cancel batch: whatever is not posted or skipped yet is cancelled, and leaves the batch file. */
export function cancelBatch(t: BatchTab, now: number): number {
  let n = 0
  for (const i of t.items)
    if (ACTIVE.has(i.status)) {
      i.status = 'cancelled'
      i.note = 'cancelled'
      i.at = now
      n++
    }
  return n
}

/** Retry one PR that failed, was skipped or cancelled: queued again with a new id. */
export function retryItem(t: BatchTab, url: string, now: number, newId: () => string): BatchItem | null {
  const i = t.items.find((x) => x.url === url)
  if (!i || RUNNING.has(i.status) || i.status === 'posted') return null
  Object.assign(i, { id: newId(), status: 'queued', note: null, reviewUrl: null, comments: 0, at: now })
  return i
}

/** "Reviewed 4: 3 posted, 1 skipped (no changes)"; null while one is still queued or reviewing. */
export function batchSummary(items: BatchItem[]): string | null {
  if (!items.length || items.some((i) => RUNNING.has(i.status))) return null
  const count = (s: BatchStatus) => items.filter((i) => i.status === s)
  const skipped = count('skipped')
  const reasons = [...new Set(skipped.map((i) => i.note).filter((n): n is string => !!n))]
  const parts = [
    count('posted').length ? `${count('posted').length} posted` : null,
    skipped.length ? `${skipped.length} skipped${reasons.length === 1 ? ` (${reasons[0]})` : ''}` : null,
    count('failed').length ? `${count('failed').length} failed` : null,
    count('cancelled').length ? `${count('cancelled').length} cancelled` : null,
  ].filter(Boolean)
  return `Reviewed ${items.length}: ${parts.join(', ')}`
}

/** The post script's log, a JSON object per line; anything else is skipped. */
export function parseLogLines(text: string): BatchLine[] {
  const out: BatchLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(raw)
    } catch {
      continue
    }
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || typeof o.url !== 'string') continue
    if (!['reviewing', 'posted', 'skipped', 'failed'].includes(o.status as string)) continue
    out.push({
      id: o.id,
      url: o.url,
      status: o.status as BatchLine['status'],
      ...(typeof o.note === 'string' ? { note: o.note } : {}),
      ...(typeof o.review === 'string' ? { review: o.review } : {}),
      ...(typeof o.comments === 'number' ? { comments: o.comments } : {}),
    })
  }
  return out
}

/** The line typed into the tab's review session (never starts with / or !). */
export const batchPrompt = (items: { repo: string; number: number }[]): string =>
  clean(`[MasterDeck batch-review] Review these PRs as "Batch reviews" in CLAUDE.md says: ${items.map(batchLabel).join(', ')}.`, 2000)

/** What the window shows per tab (AppState.reviewBatch). */
export interface BatchTabView {
  items: BatchItem[]
  running: boolean
  summary: string | null
  startedAt: number
}

export type BatchView = Record<string, BatchTabView>

export const batchTabView = (t: BatchTab): BatchTabView => ({ items: t.items, running: isRunning(t), summary: batchSummary(t.items), startedAt: t.startedAt })

/** Words for a status in the panel and the rows. */
export const BATCH_STATUS_TEXT: Record<BatchStatus, string> = {
  queued: 'queued',
  reviewing: 'reviewing',
  posted: 'posted',
  skipped: 'skipped',
  failed: 'failed',
  cancelled: 'cancelled',
}
