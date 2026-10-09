import { NOTE_ID, NOTE_TITLE_MAX } from './notes'

/**
 * What a session asks of the notes through `masterdeck-notes/scripts/note.sh` (one JSON file in
 * `<home>/deck/note-requests/`). Sessions only add text: they never read a note, and the answer
 * names the note, never its text.
 */
export type NoteRequest =
  | { op: 'new'; title: string; text: string }
  /** `repo` null: the primary repository (`#12`). */
  | { op: 'ticket'; repo: string | null; number: number; text: string }
  | { op: 'append'; id: string; text: string }

/** A request file larger than this is refused unread (a note is 50,000 characters at most). */
export const NOTE_REQUEST_MAX_BYTES = 256 * 1024

// As GitHub names them (an owner has no dot); a name of only dots is no repository.
const TICKET_ARG = /^(?:([A-Za-z0-9-]{1,39}\/(?!\.{1,2}#)[A-Za-z0-9._-]{1,100}))?#?([1-9][0-9]{0,8})$/

/**
 * A session's text as a note can hold it: terminal colours and other control characters (tool
 * output pasted as is) are taken out rather than refusing the whole note.
 */
export function sessionText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/^\n+|\s+$/g, '')
}

export function parseNoteRequest(raw: unknown): { ok: true; value: NoteRequest } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Not a note request.')
  const o = raw as Record<string, unknown>
  if (typeof o.op !== 'string' || typeof o.arg !== 'string' || typeof o.body !== 'string') return bad('Not a note request.')
  const text = sessionText(o.body)
  if (!text.trim()) return bad('No text: give the note on stdin.')
  const arg = o.arg.trim()
  switch (o.op) {
    case 'new': {
      const title = arg.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
      if (!title) return bad('A new note needs a title: note.sh new "Title".')
      if (title.length > NOTE_TITLE_MAX) return bad(`A title can be ${NOTE_TITLE_MAX} characters at most.`)
      return { ok: true, value: { op: 'new', title, text } }
    }
    case 'ticket': {
      const m = TICKET_ARG.exec(arg)
      if (!m) return bad('Name the ticket as owner/name#12 (or #12 for the primary repository).')
      return { ok: true, value: { op: 'ticket', repo: m[1] ?? null, number: Number(m[2]), text } }
    }
    case 'append':
      if (!NOTE_ID.test(arg) || !arg.startsWith('n-')) return bad("Name a note by the id note.sh new printed (n-…); a ticket's note by its ticket.")
      return { ok: true, value: { op: 'append', id: arg, text } }
    default:
      return bad('Unknown command: use new, ticket or append.')
  }
}

/** A session's text under a note's own, as a paragraph of its own. */
export function appendText(body: string, text: string): string {
  const old = body.replace(/\s+$/, '')
  return old ? `${old}\n\n${text}` : text
}
