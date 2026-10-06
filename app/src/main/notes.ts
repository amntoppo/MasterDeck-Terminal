import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  NOTES_MAX, NOTE_ID, NOTE_QUERY_MAX, cleanNote, matches, noteMeta, sortNotes, storedNote, ticketNoteId,
  type Note, type NoteChange, type NoteMeta, type NoteTicket, type SaveResult,
} from '@shared/notes'

interface Deps {
  /** Every write and delete, for the window and the web tabs. */
  onChange?: (c: NoteChange) => void
  /** A ticket's repository in full (null: the primary). "" when none is configured. */
  repoOf?: (repo: string | null) => string
  now?: () => number
}

/**
 * The user's notes: one JSON file per note under MASTERDECK_HOME/notes, all of them in memory.
 * Private text: read by the notes IPC handlers only, never part of AppState, a snapshot, a prompt or a GitHub call.
 */
export class NotesStore {
  private notes = new Map<string, Note>()
  private onChange: (c: NoteChange) => void
  private repoOf: (repo: string | null) => string
  private now: () => number

  constructor(private dir: string, deps: Deps = {}) {
    this.onChange = deps.onChange ?? (() => {})
    this.repoOf = deps.repoOf ?? ((r) => r ?? '')
    this.now = deps.now ?? Date.now
    this.load()
  }

  /** A file that is not a note MasterDeck wrote is skipped and left as it is: it may be the user's. */
  private load(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      return
    }
    let skipped = 0
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      let note: Note | null = null
      try {
        if (NOTE_ID.test(id)) note = storedNote(JSON.parse(readFileSync(join(this.dir, f), 'utf8')), id)
      } catch {
        note = null
      }
      if (note) this.notes.set(id, note)
      else skipped++
    }
    if (skipped) console.error(`notes: ${skipped} file(s) in ${this.dir} are not notes; left untouched`)
  }

  list(): NoteMeta[] {
    return sortNotes([...this.notes.values()].map(noteMeta))
  }

  get(id: unknown): Note | null {
    return typeof id === 'string' ? (this.notes.get(id) ?? null) : null
  }

  search(query: unknown): string[] {
    if (typeof query !== 'string' || query.length > NOTE_QUERY_MAX) return []
    return sortNotes([...this.notes.values()].filter((n) => matches(n, query)).map(noteMeta)).map((m) => m.id)
  }

  save(raw: unknown): SaveResult {
    const c = cleanNote(raw)
    if (!c.ok) return c
    const v = c.value
    let id = v.id
    let ticket: NoteTicket | null = null
    if (v.ticket) {
      const repo = this.repoOf(v.ticket.repo)
      const tid = ticketNoteId(repo, v.ticket.number)
      if (!tid) return { ok: false, message: 'This ticket has no repository yet. Finish Setup first.' }
      if (id && id !== tid) return { ok: false, message: 'Not a note.' }
      id = tid
      ticket = { repo, number: v.ticket.number }
    }
    const old = id ? (this.notes.get(id) ?? null) : null
    // A ticket note named by id alone keeps the ticket it has.
    if (!ticket) ticket = old?.ticket ?? null
    if (id?.startsWith('t-') && !ticket) return { ok: false, conflict: true, note: null }
    if (!v.force && (old?.updated ?? null) !== v.base) return { ok: false, conflict: true, note: old }
    if (ticket && id && !v.body.trim()) {
      if (old) {
        const gone = this.remove(id)
        if (!gone.ok) return { ok: false, message: gone.message ?? 'Could not delete the note.' }
      }
      return { ok: true, deleted: true, id }
    }
    if (!old && this.notes.size >= NOTES_MAX)
      return { ok: false, message: `${NOTES_MAX} notes is the limit. Delete some first.` }
    id ??= `n-${randomUUID().replace(/-/g, '')}`
    const t = this.now()
    const note: Note = {
      id,
      title: ticket ? '' : v.title,
      body: v.body,
      ticket,
      created: old?.created ?? t,
      updated: Math.max(t, (old?.updated ?? 0) + 1),
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = join(this.dir, `${id}.json`)
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(note, null, 2))
      renameSync(tmp, file)
    } catch (e) {
      return { ok: false, message: `Could not save the note: ${e instanceof Error ? e.message : String(e)}` }
    }
    this.notes.set(id, note)
    const meta = noteMeta(note)
    this.onChange({ id, meta })
    return { ok: true, meta }
  }

  delete(id: unknown): { ok: boolean; message?: string } {
    if (typeof id !== 'string' || !NOTE_ID.test(id)) return { ok: false, message: 'Not a note.' }
    return this.notes.has(id) ? this.remove(id) : { ok: true }
  }

  private remove(id: string): { ok: boolean; message?: string } {
    try {
      rmSync(join(this.dir, `${id}.json`), { force: true })
    } catch (e) {
      return { ok: false, message: `Could not delete the note: ${e instanceof Error ? e.message : String(e)}` }
    }
    this.notes.delete(id)
    this.onChange({ id, deleted: true })
    return { ok: true }
  }
}
