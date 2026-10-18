import { useCallback, useEffect, useRef, useState } from 'react'
import { applyChange, sortNotes, type Note, type NoteChange, type NoteMeta } from '@shared/notes'
import { NOTE_REREAD_MS } from '@shared/noteFilter'
import { deck } from './deck'
import { can } from './web'

export interface NotesList {
  metas: NoteMeta[]
  /** False until the first read: an empty list then says nothing about what exists. */
  loaded: boolean
  /** A change this window made itself, applied without waiting for its event. */
  apply(c: NoteChange): void
}

const ownChanges = new Set<(c: NoteChange) => void>()
/** A write this window made outside the Notes panel (Details' ticket note): the list takes it without waiting for its event. */
export function noteApplied(c: NoteChange): void {
  ownChanges.forEach((f) => f(c))
}

/** The notes list (titles and previews; never a body), kept current by the store's change event. */
export function useNotes(ready: boolean): NotesList {
  const [metas, setMetas] = useState<NoteMeta[]>([])
  const [loaded, setLoaded] = useState(false)
  const apply = useCallback((c: NoteChange) => setMetas((m) => applyChange(m, c)), [])
  useEffect(() => {
    ownChanges.add(apply)
    return () => void ownChanges.delete(apply)
  }, [apply])
  useEffect(() => {
    if (!ready || !can('notesList')) return
    let live = true
    // Changes that land while the first read is on its way are applied on top of it.
    let early: NoteChange[] | null = []
    const off = deck().onNotesChanged((c) => {
      if (early) early.push(c)
      else setMetas((m) => applyChange(m, c))
    })
    void deck()
      .notesList()
      .then((list) => {
        if (!live) return
        setMetas((early ?? []).reduce(applyChange, sortNotes(list)))
        early = null
        setLoaded(true)
      })
      .catch(() => {
        early = null
      })
    return () => {
      live = false
      off()
    }
  }, [ready])
  return { metas, loaded, apply }
}

export { ticketNote } from '@shared/notes'

/**
 * A note's full text, read when `id` is set and again when `version` (its `updated`) moves. A change comes with every
 * autosave while the note is edited somewhere, so that re-read waits until the edits pause; the first read does not.
 * `failed`: the note is gone or could not be read.
 */
export function useNoteBody(id: string | null, version: number): { note: Note | null; failed: boolean } {
  const [note, setNote] = useState<Note | null>(null)
  const [failed, setFailed] = useState(false)
  const lastRead = useRef<string | null>(null)
  useEffect(() => {
    if (!id) {
      lastRead.current = null
      return setNote(null)
    }
    let live = true
    const read = () =>
      void deck()
        .notesGet(id)
        .then((n) => {
          if (!live) return
          // null: the note is gone or unreadable; say so rather than load for ever.
          if (!n) return setFailed(true)
          lastRead.current = n.id
          setFailed(false)
          setNote(n)
        })
        .catch(() => live && setFailed(true))
    const again = lastRead.current === id
    if (!again) setFailed(false)
    const timer = again ? setTimeout(read, NOTE_REREAD_MS) : null
    if (!timer) read()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [id, version])
  return { note: note && note.id === id ? note : null, failed }
}

/** How the editor shows a note: the text, the rendered note, or both next to each other. */
export type NoteView = 'write' | 'preview' | 'both'
export const NOTE_VIEWS: NoteView[] = ['write', 'preview', 'both']
/** Side by side needs room for two columns beside the rail. */
export const WIDE_QUERY = '(min-width: 1000px)'

/** The view to show: side by side falls back to the text alone in a narrow window (the choice is kept for when it widens). */
export function noteView(picked: NoteView, wide: boolean): NoteView {
  return picked === 'both' && !wide ? 'write' : picked
}
