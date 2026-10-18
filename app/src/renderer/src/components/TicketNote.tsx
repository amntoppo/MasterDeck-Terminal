import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { NOTE_BODY_MAX, type Note, type NoteMeta } from '@shared/notes'
import type { NoteTarget } from '@shared/noteEditor'
import {
  TicketNoteDrafts,
  nothingToSave,
  recreateDraft,
  reloadDraft,
  saveTicketNote,
  shownTicketNote,
  startDraft,
  type TicketNoteDraft,
} from '@shared/ticketNoteInline'
import { formatAgo } from '@shared/format'
import type { Ticket } from '@shared/ticket'
import { deck, useNow } from '../deck'
import { noteApplied, useNoteBody } from '../notes'
import { webConfirm } from '../webConfirm'
import { MarkdownView } from './MarkdownView'

/** Text typed and not saved, per ticket, while the window lives: a tab or session switch does not drop it. */
const drafts = new TicketNoteDrafts()

interface Props {
  ticket: Ticket
  /** The ticket's note in the list (ticketNote); null when it has none. */
  meta: NoteMeta | null
  onNote: (t: NoteTarget) => void
}

/**
 * Session details → GitHub → Ticket (#164): the ticket's one note, rendered, and written in place with an explicit
 * Save (see `shared/ticketNoteInline.ts` for why it is not the Notes panel's autosaving editor). Keyed by ticket.
 */
export function TicketNote({ ticket, meta, onNote }: Props) {
  const now = useNow(15_000)
  const { note: read, failed } = useNoteBody(meta?.id ?? null, meta?.updated ?? 0)
  const [saved, setSaved] = useState<Note | null>(null)
  const shown = shownTicketNote(meta, read, saved)
  const [draft, setDraftState] = useState<TicketNoteDraft | null>(() => drafts.get(ticket) ?? null)
  // Deleted elsewhere (note: null) or saved elsewhere since the draft's version.
  const [clash, setClash] = useState<{ note: Note | null } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(false)
  const [long, setLong] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // With no note, the box is there to type in: an empty draft that is never kept.
  const editing = draft ?? (meta ? null : startDraft(ticket, null))

  const setDraft = (d: TicketNoteDraft | null) => {
    setDraftState(d)
    if (d) drafts.set(d)
    else drafts.clear(ticket)
  }
  const close = () => {
    setDraft(null)
    setClash(null)
    setError('')
  }

  const save = async (d: TicketNoteDraft | null = editing, force = false) => {
    if (!d || busy) return
    if (nothingToSave(d)) return close()
    // Unchanged: nothing to write (a version that moved meanwhile is no reason to write it again).
    if (!force && shown && d.base === shown.updated && d.body === shown.body) return close()
    setBusy(true)
    setError('')
    const out = await saveTicketNote((i) => deck().notesSave(i), d, force)
    setBusy(false)
    if (out.kind === 'saved') {
      noteApplied(out.change)
      setSaved(out.note)
      close()
    } else if (out.kind === 'clash') {
      setDraft(d)
      setClash({ note: out.note })
    } else {
      setDraft(d)
      setError(out.kind === 'refused' ? out.message : 'Not saved. Try again.')
    }
  }

  const remove = async () => {
    if (!meta || busy) return
    if (!(await webConfirm('Delete the note for this ticket? This cannot be undone.', { confirmLabel: 'Delete', danger: true }))) return
    setBusy(true)
    // The window asks again with the Mac's own dialog; a browser asked above.
    const r = await deck()
      .notesDelete(meta.id)
      .catch(() => ({ ok: false, message: 'Not deleted' }))
    setBusy(false)
    if (r.ok) {
      noteApplied({ id: meta.id, deleted: true })
      setSaved(null)
      close()
    } else if (r.message !== 'cancelled') setError(r.message || 'Not deleted')
  }

  // A long note is cut to a few lines until Show more.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return setLong(false)
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1)
    if (!more) measure()
    if (typeof ResizeObserver !== 'function' || more) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [shown?.body, more, editing === null])

  const edit = () => {
    if (shown) setDraft(startDraft(ticket, shown))
  }
  const editFromText = (e: MouseEvent) => {
    // A link opens; selecting text to copy it is not a request to edit.
    if ((e.target as Element).closest('a, button')) return
    if (window.getSelection()?.toString()) return
    edit()
  }

  if (editing)
    return (
      <div className="d-note tn">
        <div className="tn-head">
          <span className="eyebrow">Note</span>
          {!meta && <span className="muted">No note for this ticket yet</span>}
          <span style={{ flex: 1 }} />
          <span className="muted" aria-live="polite">
            {busy ? 'Saving…' : ''}
          </span>
          {!meta && (
            <button className="d-link" onClick={() => onNote({ ticket })}>
              Open in Notes
            </button>
          )}
        </div>
        <textarea
          className="tn-input"
          aria-label="Ticket note"
          placeholder={meta ? 'Markdown works' : 'Write a note…'}
          value={editing.body}
          maxLength={NOTE_BODY_MAX}
          rows={Math.min(14, Math.max(meta || editing.body ? 5 : 2, editing.body.split('\n').length + 1))}
          autoFocus={!!draft && !!meta}
          onChange={(e) => {
            setError('')
            setDraft({ ...editing, body: e.target.value })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              close()
            }
          }}
        />
        {clash && (
          <div className="notes-clash" role="alert">
            {clash.note ? 'Changed elsewhere.' : 'Deleted elsewhere.'}
            <span style={{ flex: 1 }} />
            {clash.note ? (
              <button
                className="btn"
                onClick={() => {
                  setDraft(reloadDraft(editing, clash.note!))
                  setClash(null)
                }}
              >
                Reload
              </button>
            ) : (
              <button className="btn" onClick={close}>
                Discard
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => void save(clash.note ? editing : recreateDraft(editing), true)}>
              {clash.note ? 'Keep mine' : 'Keep'}
            </button>
          </div>
        )}
        {error && (
          <div className="tn-error" role="alert">
            {error}
          </div>
        )}
        {(draft || editing.body) && (
          <div className="tn-actions">
            <button className="btn primary" disabled={busy || !!clash} onClick={() => void save()} title="⌘/Ctrl+Enter">
              Save
            </button>
            <button className="btn" disabled={busy} onClick={close} title="Esc">
              Cancel
            </button>
            <span style={{ flex: 1 }} />
            {editing.base !== null && meta && (
              <button className="btn danger" disabled={busy} onClick={() => void remove()}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    )

  return (
    <div className="d-note tn">
      <div className="tn-head">
        <span className="eyebrow">Note</span>
        {meta && (
          <span className="muted" title={new Date(meta.updated).toLocaleString()}>
            · {formatAgo(now - meta.updated)} ago
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="d-link" disabled={!shown} onClick={edit}>
          Edit
        </button>
        <button className="d-link" onClick={() => onNote({ ticket })}>
          Open in Notes
        </button>
      </div>
      {failed && !shown ? (
        <div className="d-text muted">The note could not be read.</div>
      ) : !shown ? (
        <div className="d-text muted">Loading…</div>
      ) : (
        <>
          <div
            ref={bodyRef}
            className={`tn-body${more ? '' : ' clamped'}`}
            title="Click to edit"
            onClick={editFromText}
          >
            {shown.body.trim() ? <MarkdownView text={shown.body} html={false} /> : <span className="muted">Empty</span>}
          </div>
          {(long || more) && (
            <button className="d-link" onClick={() => setMore((m) => !m)}>
              {more ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
      {error && (
        <div className="tn-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
