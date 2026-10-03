/**
 * Session ↔ ticket links, MasterDeck's own (`<home>/ticket-links.json`). The shape is tt.sh's
 * `state.json` (babysit-ticket), so the master CLI reads both the same way: per session the issue
 * (bare number in the primary repo, `repo` for others), title, branch key, when, and its PRs; per
 * feature branch the ticket. Imported once from tt.sh's file (importLinks); after that MasterDeck
 * never reads tt.sh's file again. Pure: main/ticketLinks.ts does the files.
 */
import type { LinkInfo } from './carry'
import { storedRepo, ticketKey, type Ticket } from './ticket'

export interface LinkEntry {
  issue: number
  repo?: string
  title: string
  branch: string
  linked_at: string
  prs: string[]
  adopted?: boolean
}

export interface LinkFile {
  importedAt?: number
  sessions: Record<string, LinkEntry>
  branches: Record<string, number | string>
}

export const emptyLinks = (): LinkFile => ({ sessions: {}, branches: {} })

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/

export function parseLinkFile(raw: unknown): LinkFile {
  const o = obj(raw)
  const out = emptyLinks()
  if (typeof o.importedAt === 'number') out.importedAt = o.importedAt
  for (const [sid, v] of Object.entries(obj(o.sessions))) {
    const e = obj(v)
    if (typeof e.issue !== 'number' || !Number.isInteger(e.issue) || e.issue <= 0) continue
    out.sessions[sid] = {
      issue: e.issue,
      ...(str(e.repo) ? { repo: str(e.repo) } : {}),
      title: str(e.title),
      branch: str(e.branch),
      linked_at: str(e.linked_at),
      prs: Array.isArray(e.prs) ? e.prs.filter((u): u is string => typeof u === 'string' && PR.test(u)) : [],
      ...(e.adopted === true ? { adopted: true } : {}),
    }
  }
  for (const [k, v] of Object.entries(obj(o.branches))) if (typeof v === 'number' || typeof v === 'string') out.branches[k] = v
  return out
}

/** The one-time import: tt.sh's links fill what MasterDeck does not have yet; ours always win. */
export function importLinks(own: LinkFile, legacy: LinkFile): LinkFile {
  return { ...own, sessions: { ...legacy.sessions, ...own.sessions }, branches: { ...legacy.branches, ...own.branches } }
}

export function linkInfoMap(f: LinkFile): Map<string, LinkInfo> {
  const m = new Map<string, LinkInfo>()
  for (const [sid, e] of Object.entries(f.sessions)) {
    if (e.adopted) continue
    const at = Date.parse(e.linked_at)
    m.set(sid, { issue: e.issue, repo: storedRepo(e.repo ?? null), linkedAt: Number.isFinite(at) ? at : null })
  }
  return m
}

export function withLink(f: LinkFile, sessionId: string, t: Ticket, title: string, branch: string, at: Date): LinkFile {
  const repo = storedRepo(t.repo)
  const prev = f.sessions[sessionId]
  const entry: LinkEntry = { issue: t.number, ...(repo ? { repo } : {}), title, branch, linked_at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'), prs: prev?.prs ?? [] }
  const branches = branch ? { ...f.branches, [branch]: repo ? `${repo}#${t.number}` : t.number } : f.branches
  return { ...f, sessions: { ...f.sessions, [sessionId]: entry }, branches }
}

export function withPr(f: LinkFile, sessionId: string, url: string): LinkFile {
  const e = f.sessions[sessionId]
  if (!e || e.prs.includes(url) || !PR.test(url)) return f
  return { ...f, sessions: { ...f.sessions, [sessionId]: { ...e, prs: [...e.prs, url] } } }
}

const isTicket = (e: LinkEntry, t: Ticket) => ticketKey(e.repo ?? null, e.issue) === ticketKey(t.repo, t.number)

export function ticketSessions(f: LinkFile, t: Ticket): string[] {
  return Object.entries(f.sessions).filter(([, e]) => !e.adopted && isTicket(e, t)).map(([sid]) => sid)
}

export function ticketPrs(f: LinkFile, t: Ticket): string[] {
  return [...new Set(ticketSessions(f, t).flatMap((sid) => f.sessions[sid].prs))]
}
