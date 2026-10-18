import type { Note, NoteChange, NoteInput, SaveResult } from './notes'
import { ticketKey, type Ticket } from './ticket'

/**
 * Session details → GitHub → Ticket (#164): the ticket's one note, written in place. Not the Notes panel's
 * `NoteEditor` (that one autosaves and is the window's only one): here each Save is one `notes:save` with the
 * version the text started from, so a note saved elsewhere meanwhile comes back as a conflict, never overwritten.
 */
export interface TicketNoteDraft {
  ticket: Ticket
  /** The stored version the text started from; null when the ticket had no note. */
  base: number | null
  body: string
}

export type TicketNoteOutcome =
  /** Stored (or, saved empty, removed): `change` goes to the list at once, `note` is what is stored now. */
  | { kind: 'saved'; change: NoteChange; note: Note | null }
  /** Saved or deleted (note: null) elsewhere since `base`; nothing was written. */
  | { kind: 'clash'; note: Note | null }
  /** The store will not take this text (its reason). */
  | { kind: 'refused'; message: string }
  /** No answer, or the disk failed: the same Save may work in a moment. */
  | { kind: 'failed' }

export const startDraft = (ticket: Ticket, stored: Note | null): TicketNoteDraft => ({
  ticket,
  base: stored?.updated ?? null,
  body: stored?.body ?? '',
})

/** One Save. `force` writes over the other version (the user's Keep mine / Keep). */
export async function saveTicketNote(
  save: (i: NoteInput) => Promise<SaveResult>,
  d: TicketNoteDraft,
  force = false,
): Promise<TicketNoteOutcome> {
  // A ticket's note is named by its ticket: the store finds its id from it.
  const input: NoteInput = { ticket: d.ticket, title: '', body: d.body, base: d.base, ...(force ? { force: true } : {}) }
  let r: SaveResult
  try {
    r = await save(input)
  } catch {
    return { kind: 'failed' }
  }
  if (r.ok) {
    if ('meta' in r) {
      const { preview: _preview, ...rest } = r.meta
      return { kind: 'saved', change: { id: r.meta.id, meta: r.meta }, note: { ...rest, body: d.body } }
    }
    return { kind: 'saved', change: { id: r.id, deleted: true }, note: null }
  }
  if ('conflict' in r) return { kind: 'clash', note: r.note }
  if (r.retry) return { kind: 'failed' }
  return { kind: 'refused', message: r.message || 'Not saved' }
}

/**
 * The text to draw for the list's row: the newest of the last read and this panel's own last save that the row
 * already counts (a re-read waits for edits elsewhere to pause, and its own save is known at once).
 */
export function shownTicketNote(meta: { id: string; updated: number } | null, read: Note | null, saved: Note | null): Note | null {
  if (!meta) return null
  const fits = [read, saved].filter((n): n is Note => !!n && n.id === meta.id && n.updated <= meta.updated)
  return fits.reduce<Note | null>((a, n) => (!a || n.updated > a.updated ? n : a), null)
}

/** Reload after a clash: the stored text and version, to go on editing from. */
export const reloadDraft = (d: TicketNoteDraft, n: Note): TicketNoteDraft => ({ ...d, base: n.updated, body: n.body })

/** Keep after the note was deleted elsewhere: the text is written as a new note. */
export const recreateDraft = (d: TicketNoteDraft): TicketNoteDraft => ({ ...d, base: null })

/** Nothing to write: a ticket without a note, saved empty. */
export const nothingToSave = (d: TicketNoteDraft): boolean => d.base === null && !d.body.trim()

/**
 * What Save does with the draft: nothing (no text for a ticket without a note, or the stored text unchanged), a
 * delete (a stored note emptied: asked first, as Delete is, and only of the version the text started from), or a save.
 */
export function saveStep(d: TicketNoteDraft, shown: { updated: number; body: string } | null): 'close' | 'delete' | 'send' {
  if (nothingToSave(d)) return 'close'
  if (d.base !== null && !d.body.trim()) return 'delete'
  if (shown && d.base === shown.updated && d.body === shown.body) return 'close'
  return 'send'
}

/**
 * Drafts kept while the window lives, per ticket, so switching Details tabs or sessions does not drop typed text.
 * Save and Cancel clear them.
 */
export class TicketNoteDrafts {
  private map = new Map<string, TicketNoteDraft>()
  get(t: Ticket): TicketNoteDraft | undefined {
    return this.map.get(ticketKey(t.repo, t.number))
  }
  set(d: TicketNoteDraft): void {
    this.map.set(ticketKey(d.ticket.repo, d.ticket.number), d)
  }
  clear(t: Ticket): void {
    this.map.delete(ticketKey(t.repo, t.number))
  }
}
