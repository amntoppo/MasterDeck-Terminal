import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { NOTE_BODY_MAX, NOTE_QUERY_MAX, NOTE_TITLE_MAX, type NoteMeta } from '@shared/notes'
import { NoteEditor, blankDraft, draftOf, noteTargetKey, type NoteDraft, type NoteTarget } from '@shared/noteEditor'
import { sameTicket, ticketLabel } from '@shared/ticket'
import { formatAgo } from '@shared/format'
import type { AppState } from '@shared/types'
import { deck, useNow } from '../deck'
import { webConfirm } from '../webConfirm'
import { ticketNote, type NotesList } from '../notes'

/** {}: the list only. `fresh` is a timestamp, so asking twice for a new note is two requests. */
export type NotesTarget = NoteTarget

/**
 * One editor for the window, kept outside the panel: text whose save is still on its way (or failed) when the panel
 * closes goes on being saved, and is in the editor again when the panel opens.
 */
const editor = new NoteEditor({ save: (i) => deck().notesSave(i), get: (id) => deck().notesGet(id) })

interface Props {
  notes: NotesList
  state: AppState
  target: NotesTarget
  onTarget: (t: NotesTarget) => void
  onClose: () => void
  phone: boolean
}

/** Notes: a side panel beside the rail (a full-screen sheet on the phone). Never modal: the app behind stays usable. */
export function NotesPanel({ notes, state, target, onTarget, onClose, phone }: Props) {
  const { metas, loaded, apply } = notes
  const now = useNow()
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Set<string> | null>(null)
  // An answer that comes after the panel closed must not open it again.
  const open = useRef(true)
  const { draft, clash, status, refused, stayed } = editor

  useEffect(() => {
    open.current = true
    editor.onChange = redraw
    // Its own writes reach the list also while the panel is closed (`apply` is the app's, and stays).
    editor.onApplied = apply
    redraw()
    // Leaving (the panel closes, the window goes away): what is typed is sent.
    const send = () => void editor.leave()
    window.addEventListener('pagehide', send)
    return () => {
      open.current = false
      editor.onChange = () => {}
      window.removeEventListener('pagehide', send)
      send()
    }
  }, [apply])

  // Open what was asked for; what was open is saved first. Nothing is opened before the list was read: a ticket's
  // note is found in it, and a blank draft for a ticket that has a note would start from the wrong version.
  const key = noteTargetKey(target)
  useEffect(() => {
    if (!loaded) return
    let live = true
    const load = async (): Promise<NoteDraft | null> => {
      const meta = target.id
        ? metas.find((m) => m.id === target.id)
        : target.ticket
          ? (ticketNote(metas, target.ticket.repo, target.ticket.number) ?? undefined)
          : undefined
      // A note that cannot be read is not opened as an empty one: `show` gives up on a throw.
      const n = meta ? await deck().notesGet(meta.id) : null
      if (n) return draftOf(n)
      if (target.ticket) return blankDraft(target.ticket)
      return target.fresh ? blankDraft(null) : null
    }
    void editor.show(target, load).then((shown) => {
      // The open text could not be saved: the panel stays on it rather than lose it (the editor says why).
      if (!shown && live) onTarget(editor.target)
    })
    return () => {
      live = false
      editor.cancelShow()
    }
    // The list is read once per request on purpose: a later change to it is the next effect's business.
    // Asking again for what is open (this effect re-running) changes nothing: `show` keeps the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded])

  // The open note changed somewhere else (another window, a browser).
  const rev = editor.rev
  useEffect(() => {
    const id = editor.draft?.id
    editor.seen(id ? metas.find((m) => m.id === id) : undefined, loaded)
  }, [metas, loaded, rev, clash])

  // Search runs in main, where the texts are; the list here has titles and previews only.
  useEffect(() => {
    const q = query.trim()
    if (!q) return setFound(null)
    let live = true
    const t = setTimeout(() => {
      void deck()
        .notesSearch(q)
        .then((ids) => live && setFound(new Set(ids)))
        .catch(() => {})
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query, metas])

  const discard = () => {
    editor.drop()
    onTarget({})
  }
  /** Text the store will not take is dropped: back to the stored note, or to the list when there is none. */
  const discardUnsaved = async () => {
    await editor.discardUnsaved()
    if (!editor.draft && open.current) onTarget({})
  }
  const remove = async () => {
    const gone = await editor.remove(
      (id) => deck().notesDelete(id),
      () => webConfirm('Delete this note? This cannot be undone.', { confirmLabel: 'Delete', danger: true }),
    )
    if (gone && open.current) onTarget({})
  }

  const shown = useMemo(() => (found ? metas.filter((m) => found.has(m.id)) : metas), [metas, found])
  const globals = shown.filter((m) => !m.ticket)
  const tickets = shown.filter((m) => m.ticket)
  const issueTitle = (t: { repo: string | null; number: number }) => state.issues.find((i) => sameTicket(i, t))?.title ?? ''
  const row = (m: NoteMeta) => (
    <button key={m.id} className={`note-row ${draft?.id === m.id ? 'on' : ''}`} onClick={() => onTarget({ id: m.id })}>
      <span className="note-row-t">
        {m.ticket ? (
          <>
            <span className="mono">{ticketLabel(m.ticket.repo, m.ticket.number)}</span> {issueTitle(m.ticket)}
          </>
        ) : (
          m.title.trim() || 'Untitled'
        )}
      </span>
      <span className="note-row-a">{formatAgo(now - m.updated)}</span>
      <span className="note-row-p">{m.preview || 'Empty'}</span>
    </button>
  )

  const editing = !!draft
  return (
    <aside
      className={`notes-panel ${phone ? 'phone' : ''} ${editing ? 'editing' : ''}`}
      aria-label="Notes"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onClose()
      }}
    >
      <header className="notes-head">
        {phone && editing ? (
          <button className="btn" onClick={() => onTarget({})}>
            ‹ Notes
          </button>
        ) : (
          <strong>Notes</strong>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => onTarget({ fresh: Date.now() })}>
          New note
        </button>
        <button className="notes-x" aria-label="Close notes" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="notes-list">
        <input
          className="notes-search"
          type="search"
          placeholder="Search notes"
          aria-label="Search notes"
          value={query}
          maxLength={NOTE_QUERY_MAX}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!loaded ? (
          <div className="notes-empty muted">Loading notes…</div>
        ) : !metas.length ? (
          <div className="notes-empty muted">No notes yet. Write the first one with New note.</div>
        ) : !shown.length ? (
          <div className="notes-empty muted">No notes match.</div>
        ) : (
          <>
            {globals.length > 0 && <div className="eyebrow">Notes</div>}
            {globals.map(row)}
            {tickets.length > 0 && <div className="eyebrow">Tickets</div>}
            {tickets.map(row)}
          </>
        )}
      </div>
      {draft && (
        // Keyed by what is open: another note starts with its own cursor and scroll.
        <div className="notes-editor" key={editor.key}>
          {draft.ticket ? (
            <div className="notes-ticket">
              Note for <span className="mono">{ticketLabel(draft.ticket.repo, draft.ticket.number)}</span>{' '}
              {issueTitle(draft.ticket)}
            </div>
          ) : (
            <input
              className="notes-title"
              placeholder="Title"
              aria-label="Title"
              value={draft.title}
              maxLength={NOTE_TITLE_MAX}
              onChange={(e) => editor.edit({ title: e.target.value })}
              onBlur={() => editor.saveNow()}
            />
          )}
          <textarea
            className="notes-body"
            placeholder={draft.ticket ? 'What is this ticket waiting for?' : 'Write here'}
            aria-label="Note"
            value={draft.body}
            maxLength={NOTE_BODY_MAX}
            autoFocus={!phone}
            onChange={(e) => editor.edit({ body: e.target.value })}
            onBlur={() => editor.saveNow()}
          />
          {clash && (
            <div className="notes-clash" role="alert">
              {clash.kind === 'changed' ? 'Changed elsewhere.' : 'Deleted elsewhere.'}
              <span style={{ flex: 1 }} />
              {clash.kind === 'changed' ? (
                <button className="btn" onClick={() => editor.reload()}>
                  Reload
                </button>
              ) : (
                <button className="btn" onClick={discard}>
                  Discard
                </button>
              )}
              <button className="btn" onClick={() => void editor.keepMine()}>
                {clash.kind === 'changed' ? 'Keep mine' : 'Keep'}
              </button>
            </div>
          )}
          {!clash && refused !== null && (
            <div className="notes-clash" role="alert">
              {stayed ? 'Not saved, so this note stays open.' : 'This text cannot be saved.'}
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => void discardUnsaved()}>
                Discard
              </button>
            </div>
          )}
          <footer className="notes-foot">
            <span className="muted" aria-live="polite">
              {status}
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn danger" onClick={() => void remove()}>
              Delete
            </button>
          </footer>
        </div>
      )}
    </aside>
  )
}
