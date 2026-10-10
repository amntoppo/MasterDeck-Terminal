import { NOTE_LINK_NAME_MAX, type NoteLinkInput, type NoteMeta } from './notes'
import type { Ticket } from './ticket'

/** The Notes panel's filter chips. */
export type NoteFilter = 'all' | 'mine' | 'tickets' | 'sessions' | 'meetings'
export const NOTE_FILTERS: [NoteFilter, string][] = [
  ['all', 'All'],
  ['mine', 'Mine'],
  ['tickets', 'Tickets'],
  ['sessions', 'Sessions'],
  ['meetings', 'Meetings'],
]
export const isNoteFilter = (v: unknown): v is NoteFilter => NOTE_FILTERS.some(([f]) => f === v)

/**
 * Mine: a note of the user's own, about nothing (no ticket, no session, no meeting). Tickets: a ticket's note, or a
 * note about a ticket. Sessions: a note about a session. Meetings: a note that came from a meeting.
 * A note can be in several (a meeting note about a session and its ticket is in all three of those).
 */
export function noteIn(m: NoteMeta, f: NoteFilter): boolean {
  switch (f) {
    case 'all':
      return true
    case 'mine':
      return !m.ticket && !m.link && !m.meeting
    case 'tickets':
      return !!m.ticket || !!m.link?.ticket
    case 'sessions':
      return !!m.link?.session
    case 'meetings':
      return !!m.meeting
  }
}

export const filterNotes = (metas: NoteMeta[], f: NoteFilter): NoteMeta[] => (f === 'all' ? metas : metas.filter((m) => noteIn(m, f)))

/** The meeting chip's date: "9 Oct". */
export const meetingDay = (at: number): string => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/**
 * The newest meeting note in a session's list, by its `created` (the Mac's clock, so a browser's clock never decides).
 * 0 when there is none. Kept per session as "seen" when its Notes tab is open.
 */
export const newestMeetingNote = (list: NoteMeta[]): number => list.reduce((t, m) => (m.meeting ? Math.max(t, m.created) : t), 0)

/** A meeting note came since the tab was last open (`seen`: what newestMeetingNote was then; null: never opened). */
export const meetingDot = (list: NoteMeta[], seen: number | null): boolean => newestMeetingNote(list) > (seen ?? 0)

const SESSION_KEY = /^[A-Za-z0-9._:-]{1,200}$/
const CONTROL_LINE = /[\x00-\x1f\x7f-\x9f]/g

/** What a new note from a session's Details is about: the session (when its key is one the store takes) and its ticket. */
export function sessionLink(s: { key: string; name: string }, ticket: Ticket | null): NoteLinkInput | undefined {
  const link: NoteLinkInput = {}
  if (SESSION_KEY.test(s.key)) link.session = { key: s.key, name: s.name.replace(CONTROL_LINE, ' ').slice(0, NOTE_LINK_NAME_MAX) }
  if (ticket) link.ticket = ticket
  return link.session || link.ticket ? link : undefined
}
