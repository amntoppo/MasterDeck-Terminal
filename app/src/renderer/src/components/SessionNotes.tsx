import { useEffect, useState } from 'react'
import type { NoteMeta } from '@shared/notes'
import type { NoteTarget } from '@shared/noteEditor'
import { meetingDay, sessionLink, shownNote } from '@shared/noteFilter'
import { formatAgo } from '@shared/format'
import type { Ticket } from '@shared/ticket'
import type { Session } from '@shared/types'
import { useNow } from '../deck'
import { useNoteBody } from '../notes'
import { MarkdownView } from './MarkdownView'

interface Props {
  session: Session
  ticket: Ticket | null
  /** sessionNotes(…): the ticket's note first, then newest first. */
  list: NoteMeta[]
  onNote: (t: NoteTarget) => void
}

/**
 * Session details → Notes: the session's notes, and the picked one rendered below the list.
 * ponytail: read only here. Edit and New note open the Notes panel, whose one NoteEditor is the only editor in the
 * window, so a note is never open in two editors at once; editing in place would need that editor to serve two views.
 * (The ticket's own note is written in place under GitHub → Ticket, #164: explicit saves with `base`, `TicketNote`.)
 */
export function SessionNotes({ session: s, ticket, list, onNote }: Props) {
  const now = useNow()
  const [picked, setPicked] = useState<string | null>(null)
  const meta = shownNote(list, picked)
  const id = meta?.id ?? null
  const { note: shown, failed } = useNoteBody(id, meta?.updated ?? 0)
  // Once read, a note is the picked one: one that arrives later never takes its place.
  useEffect(() => {
    if (shown) setPicked(shown.id)
  }, [shown])

  const fresh = () => onNote({ fresh: Date.now(), link: sessionLink(s, ticket) })
  return (
    <section className="dsec s-notes">
      <div className="d-row">
        <div className="eyebrow">Notes</div>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={fresh}>
          New note
        </button>
      </div>
      {!list.length ? (
        <div className="d-text muted">No notes for this session yet.</div>
      ) : (
        <div className="s-notes-list" role="listbox" aria-label="This session's notes">
          {list.map((m) => (
            <button key={m.id} role="option" aria-selected={m.id === id} className={`note-row ${m.id === id ? 'on' : ''}`} onClick={() => setPicked(m.id)}>
              <span className="note-row-t">{m.ticket ? 'Ticket note' : m.title.trim() || m.preview || 'Untitled'}</span>
              <span className="note-row-a">{formatAgo(now - m.updated)}</span>
              {m.meeting && (
                <span className="note-chips">
                  <span className="note-chip meeting" title={m.meeting.title}>
                    Meeting · {meetingDay(m.meeting.at)}
                  </span>
                </span>
              )}
              <span className="note-row-p">{m.preview || 'Empty'}</span>
            </button>
          ))}
        </div>
      )}
      {meta && (
        <div className="s-note">
          <div className="d-row">
            <strong className="s-note-t">{meta.ticket ? 'Ticket note' : meta.title.trim() || 'Untitled'}</strong>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => onNote({ id: meta.id })}>
              Edit
            </button>
          </div>
          {meta.meeting && <div className="d-text muted">From {meta.meeting.title} · {meetingDay(meta.meeting.at)}</div>}
          <div className="s-note-body">
            {failed ? (
              <span className="muted">The note could not be read.</span>
            ) : !shown ? (
              <span className="muted">Loading…</span>
            ) : shown.body.trim() ? (
              <MarkdownView text={shown.body} html={false} />
            ) : (
              <span className="muted">Empty</span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
