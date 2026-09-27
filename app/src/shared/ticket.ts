import { getConfig, primaryRepo } from './appConfig'

/**
 * Tickets across repositories: an issue is its repo (owner/name) and number. `repo` null means the
 * primary issue repo: what older records (a bare number) always meant, and what records for it
 * still keep, so the master CLI, babysit-ticket and older app versions read them the same way.
 */
export interface Ticket {
  repo: string | null
  number: number
}

/** null for the primary repo (or nothing), else owner/name as given. */
export function storedRepo(repo: string | null | undefined): string | null {
  if (!repo) return null
  return repo.toLowerCase() === primaryRepo().toLowerCase() ? null : repo
}

/** owner/name; null means the primary repo. */
export function fullRepo(repo: string | null | undefined): string {
  return repo || primaryRepo()
}

/** One string per ticket, for maps and comparisons: "owner/name#12", repo lowercased. */
export function ticketKey(repo: string | null | undefined, n: number): string {
  return `${fullRepo(repo).toLowerCase()}#${n}`
}

export function sameTicket(a: { repo?: string | null; number: number } | null | undefined, b: { repo?: string | null; number: number } | null | undefined): boolean {
  return !!a && !!b && a.number === b.number && ticketKey(a.repo, a.number) === ticketKey(b.repo, b.number)
}

/** How the UI names it: #12 in the primary repo, name#12 in another. */
export function ticketLabel(repo: string | null | undefined, n: number): string {
  const r = storedRepo(repo)
  return r ? `${r.split('/')[1] ?? r}#${n}` : `#${n}`
}

/** owner/name#12, for prompts and commands. */
export function ticketRef(repo: string | null | undefined, n: number): string {
  return `${fullRepo(repo)}#${n}`
}

export function ticketUrl(repo: string | null | undefined, n: number): string {
  return `https://github.com/${fullRepo(repo)}/issues/${n}`
}

/** Back from a key (or 12, name#12, owner/name#12). Null when it isn't one. */
export function parseTicket(text: string): Ticket | null {
  const m = /^\s*(?:(?:([A-Za-z0-9-]{1,39})\/)?([A-Za-z0-9._-]{1,100})#|#)?(\d+)\s*$/.exec(text)
  if (!m) return null
  const number = Number(m[3])
  if (!m[2]) return { repo: null, number }
  if (m[1]) return { repo: storedRepo(`${m[1]}/${m[2]}`), number }
  const hit = getConfig().repos.find((r) => r.split('/')[1]?.toLowerCase() === m[2].toLowerCase())
  return { repo: storedRepo(hit ?? `${getConfig().owner}/${m[2]}`), number }
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/** A ticket from IPC or a file: a bare number (primary repo) or {repo, number}. Null if malformed. */
export function asTicket(v: unknown): Ticket | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? { repo: null, number: v } : null
  if (!v || typeof v !== 'object') return null
  const o = v as { repo?: unknown; number?: unknown }
  if (typeof o.number !== 'number' || !Number.isInteger(o.number) || o.number <= 0) return null
  if (o.repo === null || o.repo === undefined) return { repo: null, number: o.number }
  if (typeof o.repo !== 'string' || !REPO.test(o.repo)) return null
  return { repo: storedRepo(o.repo), number: o.number }
}

/** The ticket of anything with a number and an optional repo (Issue, BoardCard). */
export function ticketOf(x: { repo?: string | null; number: number }): Ticket {
  return { repo: x.repo ?? null, number: x.number }
}
