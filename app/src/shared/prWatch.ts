/**
 * MasterDeck's PR watch (replaces babysit-pr's Monitor phase): which PR events reach a session and
 * what it is told. main/prWatch.ts polls GitHub; this file builds the queries, reads the answers,
 * turns a PR into items (each with a stable key; the seen set is a list of keys) and writes the
 * messages. Others' activity only: comments by `me` (the session posts as the user) never count.
 */

export interface PrRef {
  owner: string
  repo: string
  number: number
}

export const LIGHT_MAX = 50
export const HEAVY_MAX = 10
/** A full read at least this often: a bot editing its comment may not bump the PR's updatedAt. */
export const HEAVY_EVERY_MS = 10 * 60_000
/** A Claude review status comment untouched this long has stalled (babysit-pr's rule). */
export const STALL_MS = 10 * 60_000
/** A PR older than this when its watch starts: what is on it already is not news. */
export const BASELINE_AGE_MS = 10 * 60_000
export const NUDGE_MAX = 2

const OWNER = /^[A-Za-z0-9-]{1,39}$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/
export const safeRef = (r: PrRef): boolean => OWNER.test(r.owner) && NAME.test(r.repo) && Number.isInteger(r.number) && r.number > 0

const LIGHT = 'state isDraft mergeable baseRefName updatedAt createdAt author{login}'
const NOTE = 'databaseId updatedAt author{login} body'
const HEAVY = `${LIGHT} reviewThreads(first:50){nodes{isResolved comments(last:1){nodes{${NOTE}}}}} reviews(last:20){nodes{databaseId state submittedAt author{login} body}} comments(last:30){nodes{${NOTE}}}`

function batch(prs: PrRef[], fields: string): string {
  if (!prs.every(safeRef)) throw new Error('unsafe PR reference')
  return `query{${prs.map((p, i) => `p${i}: repository(owner:"${p.owner}",name:"${p.repo}"){pullRequest(number:${p.number}){${fields}}}`).join(' ')}}`
}
export const lightQuery = (prs: PrRef[]): string => batch(prs, LIGHT)
export const heavyQuery = (prs: PrRef[]): string => batch(prs, HEAVY)

export interface LightPr {
  state: string
  isDraft: boolean
  mergeable: string
  baseRefName: string
  updatedAt: string
  createdAt: string
  author: string | null
}
export interface Note {
  id: number
  updatedAt: string
  author: string
  body: string
}
export interface HeavyPr extends LightPr {
  threads: { isResolved: boolean; last: Note | null }[]
  reviews: (Note & { state: string })[]
  comments: Note[]
}

type J = Record<string, unknown>
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const nodes = (v: unknown): J[] => (Array.isArray(o(v).nodes) ? (o(v).nodes as unknown[]).map(o) : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const login = (v: unknown): string => s(o(v).login) || 'ghost'

function pulls(text: string, n: number): (J | null)[] {
  let data: J = {}
  try {
    data = o(o(JSON.parse(text)).data)
  } catch {
    // no JSON: every PR unknown
  }
  return Array.from({ length: n }, (_, i) => {
    const pr = o(data[`p${i}`]).pullRequest
    return pr && typeof pr === 'object' ? (pr as J) : null
  })
}

function light(p: J): LightPr {
  return { state: s(p.state), isDraft: p.isDraft === true, mergeable: s(p.mergeable), baseRefName: s(p.baseRefName), updatedAt: s(p.updatedAt), createdAt: s(p.createdAt), author: s(o(p.author).login) || null }
}
const note = (c: J, at = 'updatedAt'): Note => ({ id: typeof c.databaseId === 'number' ? c.databaseId : 0, updatedAt: s(c[at]), author: login(c.author), body: s(c.body) })

export const parseLight = (text: string, n: number): (LightPr | null)[] => pulls(text, n).map((p) => (p ? light(p) : null))

export const parseHeavy = (text: string, n: number): (HeavyPr | null)[] =>
  pulls(text, n).map((p) =>
    p
      ? {
          ...light(p),
          threads: nodes(p.reviewThreads).map((t) => ({ isResolved: t.isResolved === true, last: nodes(t.comments)[0] ? note(nodes(t.comments)[0]) : null })),
          reviews: nodes(p.reviews).map((r) => ({ ...note(r, 'submittedAt'), state: s(r.state) })),
          comments: nodes(p.comments).map((c) => note(c)),
        }
      : null,
  )

export type ItemKind = 'thread' | 'comment' | 'review' | 'conflict' | 'stall' | 'merged' | 'closed'
export interface PrItem {
  key: string
  kind: ItemKind
  text: string
  by?: string
  state?: string
  base?: string
}

const BOT = /^claude(\[bot\])?$/i
/** The Claude reviewer's status comment while it works (it edits the same comment until "finished"). */
const inProgress = (body: string): boolean => !/claude finished|finished the review/i.test(body) && (/(^|\n)\s*- \[ \]/.test(body) || /is reviewing/i.test(body))

export function prItems(pr: HeavyPr, me: string | null, now: number): { items: PrItem[]; stallAt: number | null } {
  if (pr.state === 'MERGED') return { items: [{ key: 'merged', kind: 'merged', text: '' }], stallAt: null }
  if (pr.state === 'CLOSED') return { items: [{ key: 'closed', kind: 'closed', text: '' }], stallAt: null }
  const mine = (who: string) => !!me && who.toLowerCase() === me.toLowerCase()
  const items: PrItem[] = []
  let stallAt: number | null = null
  for (const t of pr.threads)
    if (!t.isResolved && t.last && !mine(t.last.author)) items.push({ key: `T:${t.last.id}:${t.last.updatedAt}`, kind: 'thread', text: t.last.body, by: t.last.author })
  for (const c of pr.comments) {
    if (mine(c.author)) continue
    if (BOT.test(c.author) && inProgress(c.body)) {
      const due = Date.parse(c.updatedAt) + STALL_MS
      if (Number.isFinite(due) && now >= due) items.push({ key: `S:${c.id}`, kind: 'stall', text: c.body, by: c.author })
      else if (Number.isFinite(due)) stallAt = Math.min(stallAt ?? due, due)
      continue
    }
    items.push({ key: `C:${c.id}:${c.updatedAt}`, kind: 'comment', text: c.body, by: c.author })
  }
  for (const r of pr.reviews)
    if (!mine(r.author) && (r.state === 'CHANGES_REQUESTED' || r.body.trim())) items.push({ key: `R:${r.id}`, kind: 'review', text: r.body, by: r.author, state: r.state })
  // Only CONFLICTING counts: UNKNOWN means GitHub has not computed it yet.
  if (pr.mergeable === 'CONFLICTING') items.push({ key: `X:${pr.baseRefName}`, kind: 'conflict', text: '', base: pr.baseRefName })
  return { items, stallAt }
}

export const fresh = (items: PrItem[], seen: string[]): PrItem[] => items.filter((i) => !seen.includes(i.key))

const clip = (t: string): string => {
  const flat = t.replace(/\s+/g, ' ').trim()
  return flat.length > 180 ? `${flat.slice(0, 179)}…` : flat
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function prWatchMessage(ref: PrRef, items: PrItem[], nudges: number): { text: string; nudges: number } {
  const head = `[MasterDeck PR watch] ${ref.repo}#${ref.number}:`
  const full = `${ref.owner}/${ref.repo}`
  const lines: string[] = []
  const of = (k: ItemKind) => items.filter((i) => i.kind === k)
  if (of('merged').length) return { text: `${head} merged. The PR watch has ended.`, nudges }
  if (of('closed').length) return { text: `${head} closed without merging. The PR watch has ended.`, nudges }
  const threads = of('thread')
  if (threads.length)
    lines.push(`${head} ${plural(threads.length, 'new review thread')}: ${threads.map((t) => `"${clip(t.text)}"`).join(', ')}. Fix valid ones, reply on each thread, resolve only threads you addressed. Never force-push. Do not merge.`)
  const talk = [...of('comment'), ...of('review')]
  if (talk.length)
    lines.push(
      `${head} ${plural(talk.length, 'new PR comment')}: ${talk.map((t) => `${t.by}${t.kind === 'review' && t.state === 'CHANGES_REQUESTED' ? ' (changes requested)' : ''}: "${clip(t.text) || '(no text)'}"`).join(', ')}. ` +
        `Read them (gh pr view ${ref.number} --repo ${full} --comments), fix what is valid and reply on the PR. Never force-push. Do not merge.`,
    )
  for (const c of of('conflict'))
    lines.push(`${head} merge conflict with ${c.base}. Merge origin/${c.base}, never rebase; stop and tell me if lockfiles or migrations conflict.`)
  if (of('stall').length) {
    if (nudges < NUDGE_MAX) {
      lines.push(`${head} the automated Claude review stalled. Comment \`@claude review\` on the PR once (gh pr comment ${ref.number} --repo ${full} --body "@claude review").`)
      nudges++
    } else if (nudges === NUDGE_MAX) {
      lines.push(`${head} the automated Claude review is stuck again. Do not nudge it again; tell me it is not completing.`)
      nudges++
    }
  }
  return { text: lines.join('\n'), nudges }
}
