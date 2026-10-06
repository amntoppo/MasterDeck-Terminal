import { asTicket, type Ticket } from './ticket'

export const NOTE_TITLE_MAX = 200
export const NOTE_BODY_MAX = 50_000
export const NOTES_MAX = 1000
export const NOTE_PREVIEW = 120
export const NOTE_QUERY_MAX = 200

/** A note's ticket always names its repository in full: a bare number would follow the primary repository when that changes. */
export interface NoteTicket {
  repo: string
  number: number
}
export interface Note {
  id: string
  /** "" for a ticket note. */
  title: string
  /** As typed. Plain text today; nothing here may assume more (Markdown is a later step). */
  body: string
  ticket: NoteTicket | null
  created: number
  /** Grows with every save, so it names one version. */
  updated: number
}
export type NoteMeta = Omit<Note, 'body'> & { preview: string }

/** What an editor sends. `base` is the `updated` of the version it loaded (null: it believes the note is new). */
export interface NoteInput {
  id?: string
  title: string
  body: string
  ticket?: Ticket | null
  base: number | null
  force?: boolean
}
export type SaveResult =
  | { ok: true; meta: NoteMeta }
  /** A ticket note saved empty is removed. */
  | { ok: true; deleted: true; id: string }
  /** Someone saved or deleted (note: null) it meanwhile; nothing was written. */
  | { ok: false; conflict: true; note: Note | null }
  | { ok: false; message: string }
export type NoteChange = { id: string; meta: NoteMeta } | { id: string; deleted: true }

/** The two id shapes, and so the only file names the store ever builds. `~` is in no GitHub owner or repository name. */
export const NOTE_ID = /^(?:n-[0-9a-f]{32}|t-[a-z0-9-]{1,39}~[a-z0-9._-]{1,100}~[1-9][0-9]{0,8})$/

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/** A ticket's note id, from its full repository (owner/name). Null when there is none to name. */
export function ticketNoteId(repo: string, number: number): string | null {
  const [owner, name, more] = repo.toLowerCase().split('/')
  if (!owner || !name || more !== undefined) return null
  const id = `t-${owner}~${name}~${number}`
  return NOTE_ID.test(id) ? id : null
}

export type Cleaned = { id: string | undefined; title: string; body: string; ticket: Ticket | null; base: number | null; force: boolean }

/** The one check of what an editor sent (the window or a browser): limits, characters, ids. Never cuts text. */
export function cleanNote(raw: unknown): { ok: true; value: Cleaned } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Not a note.')
  const o = raw as Record<string, unknown>
  if (typeof o.title !== 'string' || typeof o.body !== 'string') return bad('Not a note.')
  if (o.id !== undefined && (typeof o.id !== 'string' || !NOTE_ID.test(o.id))) return bad('Not a note.')
  if (o.base !== null && !(typeof o.base === 'number' && Number.isFinite(o.base))) return bad('Not a note.')
  const body = o.body.replace(/\r\n?/g, '\n')
  const title = o.title.replace(/\r\n?/g, '\n').replace(/[\n\t]/g, ' ')
  if (title.length > NOTE_TITLE_MAX) return bad(`A title can be ${NOTE_TITLE_MAX} characters at most.`)
  if (body.length > NOTE_BODY_MAX) return bad(`A note can be ${NOTE_BODY_MAX.toLocaleString('en-US')} characters at most.`)
  if (CONTROL.test(title) || CONTROL.test(body)) return bad('The note has characters that cannot be saved.')
  let ticket: Ticket | null = null
  if (o.ticket !== undefined && o.ticket !== null) {
    ticket = asTicket(o.ticket)
    if (!ticket) return bad('Not a ticket.')
  }
  return { ok: true, value: { id: o.id as string | undefined, title, body, ticket, base: o.base as number | null, force: o.force === true } }
}

/** A note read from disk, or null when the file is not one MasterDeck wrote (`id` is the file's name without .json). */
export function storedNote(raw: unknown, id: string): Note | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.id !== id || !NOTE_ID.test(id)) return null
  if (typeof o.title !== 'string' || typeof o.body !== 'string') return null
  if (o.title.length > NOTE_TITLE_MAX || o.body.length > NOTE_BODY_MAX) return null
  if (CONTROL.test(o.title) || CONTROL.test(o.body) || /[\n\t]/.test(o.title)) return null
  if (![o.created, o.updated].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  let ticket: NoteTicket | null = null
  if (o.ticket !== null && o.ticket !== undefined) {
    const t = o.ticket as Record<string, unknown>
    if (typeof t !== 'object' || typeof t.repo !== 'string' || typeof t.number !== 'number') return null
    ticket = { repo: t.repo, number: t.number }
  }
  // A ticket note's file name is its ticket, and a global note has none.
  if (id.startsWith('t-') !== !!ticket) return null
  if (ticket && ticketNoteId(ticket.repo, ticket.number) !== id) return null
  return { id, title: o.title, body: o.body, ticket, created: o.created as number, updated: o.updated as number }
}

export function noteMeta(n: Note): NoteMeta {
  const { body, ...rest } = n
  return { ...rest, preview: body.replace(/\s+/g, ' ').trim().slice(0, NOTE_PREVIEW) }
}

export const sortNotes = (metas: NoteMeta[]): NoteMeta[] =>
  [...metas].sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1))

/** Every word of the query is in the title, the text or the ticket (owner/name#12). */
export function matches(n: Note, query: string): boolean {
  const hay = `${n.title}\n${n.body}\n${n.ticket ? `${n.ticket.repo}#${n.ticket.number}` : ''}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

export function applyChange(metas: NoteMeta[], c: NoteChange): NoteMeta[] {
  const rest = metas.filter((m) => m.id !== c.id)
  return sortNotes('meta' in c ? [...rest, c.meta] : rest)
}

export interface EditorAt {
  /** The open note; null for a draft never saved. */
  id: string | null
  /** The version the editor holds; null before the first save. */
  base: number | null
  /** Text typed and not saved yet. */
  dirty: boolean
  /** A save or delete of its own is in flight. */
  saving: boolean
  /** The list has been read at least once. */
  loaded: boolean
}
/**
 * What an editor does about the list's row for its note (undefined: no row).
 * hold: its own save is in flight, and that save's event can arrive before its answer; look again after.
 */
export function incoming(e: EditorAt, meta: NoteMeta | undefined): 'ignore' | 'hold' | 'reload' | 'ask' | 'gone' {
  if (!e.loaded || e.id === null || e.base === null) return 'ignore'
  if (e.saving) return 'hold'
  if (!meta) return 'gone'
  if (meta.updated === e.base) return 'ignore'
  return e.dirty ? 'ask' : 'reload'
}
