import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { NOTE_BODY_MAX, NOTE_QUERY_MAX, NOTE_TITLE_MAX, ticketTitle, type NoteMeta } from '@shared/notes'
import { NoteEditor, blankDraft, draftOf, noteTargetKey, type NoteDraft, type NoteTarget } from '@shared/noteEditor'
import { ticketLabel } from '@shared/ticket'
import { formatAgo } from '@shared/format'
import type { AppState } from '@shared/types'
import { deck, load, save, useNow } from '../deck'
import { webConfirm } from '../webConfirm'
import { NOTE_VIEWS, WIDE_QUERY, noteView, ticketNote, type NoteView, type NotesList } from '../notes'
import { MarkdownView } from './MarkdownView'

/** {}: the list only. `fresh` is a timestamp, so asking twice for a new note is two requests. */
export type NotesTarget = NoteTarget

/**
 * One editor for the window, kept outside the panel: text whose save is still on its way (or failed) when the panel
 * closes goes on being saved, and is in the editor again when the panel opens.
 */
const editor = new NoteEditor({ save: (i) => deck().notesSave(i), get: (id) => deck().notesGet(id) })

const VIEW_KEY = 'masterdeck.notesView'
const VIEW_LABEL: Record<NoteView, [string, string]> = {
  write: ['Write', 'The Markdown text, as it is saved'],
  preview: ['Preview', 'The note rendered'],
  both: ['Side by side', 'Text and preview next to each other'],
}

/** A window wide enough for text and preview side by side (never the phone). */
function useWide(): boolean {
  const q = () => typeof matchMedia === 'function' && matchMedia(WIDE_QUERY).matches
  const [wide, setWide] = useState(q)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(WIDE_QUERY)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

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
  const wide = useWide() && !phone
  // Per viewer: the window and each browser remember their own.
  const [picked, setPicked] = useState<NoteView>(() => {
    const v = load<NoteView>(VIEW_KEY, 'write')
    return NOTE_VIEWS.includes(v) ? v : 'write'
  })
  const view = noteView(picked, wide)
  const pick = (v: NoteView) => {
    // Leaving the text for the preview is a pause in typing: it is saved now, not 2 s later.
    if (v === 'preview') void editor.saveNow()
    setPicked(v)
    save(VIEW_KEY, v)
  }

  useEffect(() => {
    open.current = true
    editor.onChange = redraw
    // Its own writes reach the list also while the panel is closed (`apply` is the app's, and stays).
    editor.onApplied = apply
    redraw()
    // Leaving (the panel closes, the window goes away): what is typed is sent.
    const send = () => void editor.leave()
    // A phone that puts the tab away often says only this, and then stops its timers.
    const hidden = () => document.visibilityState === 'hidden' && send()
    window.addEventListener('pagehide', send)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      open.current = false
      editor.onChange = () => {}
      window.removeEventListener('pagehide', send)
      document.removeEventListener('visibilitychange', hidden)
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
  // A ticket known only as a board card (or in the repository view) has no entry in state.issues.
  const issueTitle = (t: { repo: string | null; number: number }) =>
    ticketTitle(t, state.issues, state.board?.cards, state.repoView?.cards)
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
      className={`notes-panel ${phone ? 'phone' : ''} ${editing ? 'editing' : ''} ${editing && view === 'both' ? 'wide' : ''}`}
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
          <div className={`notes-pane ${view}`}>
            {view !== 'preview' && (
              <textarea
                className="notes-body"
                placeholder={draft.ticket ? 'What is this ticket waiting for? (Markdown works)' : 'Write here (Markdown works)'}
                aria-label="Note"
                value={draft.body}
                maxLength={NOTE_BODY_MAX}
                autoFocus={!phone}
                onChange={(e) => editor.edit({ body: e.target.value })}
                onBlur={() => editor.saveNow()}
              />
            )}
            {view !== 'write' && (
              <div className="notes-preview" tabIndex={0} aria-label="Note, rendered">
                {draft.body.trim() ? <MarkdownView text={draft.body} html={false} /> : <span className="muted">Nothing to preview yet.</span>}
              </div>
            )}
          </div>
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
            <div className="seg" role="group" aria-label="Note view">
              {NOTE_VIEWS.filter((v) => v !== 'both' || wide).map((v) => (
                <button key={v} type="button" className={view === v ? 'on' : undefined} aria-pressed={view === v} title={VIEW_LABEL[v][1]} onClick={() => pick(v)}>
                  {VIEW_LABEL[v][0]}
                </button>
              ))}
            </div>
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
