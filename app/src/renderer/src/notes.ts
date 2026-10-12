import { useCallback, useEffect, useState } from 'react'
import { applyChange, sortNotes, type NoteChange, type NoteMeta } from '@shared/notes'
import { fullRepo } from '@shared/ticket'
import { deck } from './deck'
import { can } from './web'

export interface NotesList {
  metas: NoteMeta[]
  /** False until the first read: an empty list then says nothing about what exists. */
  loaded: boolean
  /** A change this window made itself, applied without waiting for its event. */
  apply(c: NoteChange): void
}

/** The notes list (titles and previews; never a body), kept current by the store's change event. */
export function useNotes(ready: boolean): NotesList {
  const [metas, setMetas] = useState<NoteMeta[]>([])
  const [loaded, setLoaded] = useState(false)
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
  const apply = useCallback((c: NoteChange) => setMetas((m) => applyChange(m, c)), [])
  return { metas, loaded, apply }
}

export function ticketNote(metas: NoteMeta[], repo: string | null | undefined, number: number): NoteMeta | null {
  const full = fullRepo(repo).toLowerCase()
  return metas.find((m) => m.ticket && m.ticket.number === number && m.ticket.repo.toLowerCase() === full) ?? null
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
