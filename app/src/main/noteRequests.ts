import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NOTE_REQUEST_MAX_BYTES, parseNoteRequest } from '@shared/noteRequest'
import type { SaveResult } from '@shared/notes'
import type { NotesStore } from './notes'

/** What note.sh prints: the note's id on success, never its text. */
export type NoteAnswer = { ok: true; id: string; message: string } | { ok: false; error: string }

const ID = /^[0-9]+-[0-9]+-[0-9]+$/
/** Requests per tick: a session in a loop cannot hold the pump up. The rest wait for the next second. */
const PER_TICK = 20
/** note.sh gives up after 15 s; anything older was left behind. */
const STALE_MS = 60_000

type Store = Pick<NotesStore, 'save' | 'append'>

/** One request, answered. Exported for tests. */
export function answerNoteRequest(store: Store, raw: unknown): NoteAnswer {
  const r = parseNoteRequest(raw)
  if (!r.ok) return r
  const v = r.value
  let res: SaveResult
  if (v.op === 'new') res = store.save({ title: v.title, body: v.text, base: null })
  else if (v.op === 'ticket') res = store.append({ ticket: { repo: v.repo, number: v.number } }, v.text)
  else res = store.append({ id: v.id }, v.text)
  if (!res.ok) return { ok: false, error: 'message' in res ? res.message : 'The note changed meanwhile; try again.' }
  if (!('meta' in res)) return { ok: false, error: 'Nothing was saved.' }
  const id = res.meta.id
  const message =
    v.op === 'new' ? `Saved a new note "${v.title}" (id ${id}).` : v.op === 'ticket' ? `Added to the note of ${res.meta.ticket?.repo}#${v.number}.` : `Added to note ${id}.`
  return { ok: true, id, message }
}

/**
 * The sessions' note requests in `<deckDir>/note-requests`: claim each (rename to `.taken`, so a
 * note.sh that gave up and took it back by its own rename is never answered too), save, answer in
 * `note-answers/<id>.json`. Old leftovers of either side are removed.
 */
export function pumpNoteRequests(deckDir: string, store: Store, now = Date.now()): number {
  const req = join(deckDir, 'note-requests')
  const ans = join(deckDir, 'note-answers')
  let names: string[]
  try {
    names = readdirSync(req)
  } catch {
    return 0
  }
  sweep(ans, now)
  let done = 0
  for (const n of names.sort()) {
    const path = join(req, n)
    if (!n.endsWith('.json')) {
      if (stale(path, now)) rmSync(path, { force: true })
      continue
    }
    const id = n.slice(0, -5)
    if (!ID.test(id)) {
      // Not a name note.sh makes: never read, removed once old so it is not listed every second.
      if (stale(path, now)) rmSync(path, { force: true })
      continue
    }
    if (done >= PER_TICK) break
    const taken = join(req, `${id}.taken`)
    try {
      renameSync(path, taken)
    } catch {
      continue
    }
    done++
    let answer: NoteAnswer
    try {
      if (statSync(taken).size > NOTE_REQUEST_MAX_BYTES) answer = { ok: false, error: 'The text is too long for a note.' }
      else answer = answerNoteRequest(store, JSON.parse(readFileSync(taken, 'utf8')))
    } catch {
      answer = { ok: false, error: 'Not a note request.' }
    }
    try {
      mkdirSync(ans, { recursive: true })
      writeFileSync(join(ans, `${id}.tmp`), JSON.stringify(answer))
      renameSync(join(ans, `${id}.tmp`), join(ans, `${id}.json`))
    } catch (e) {
      console.error('notes: could not answer a session', e)
    }
    rmSync(taken, { force: true })
  }
  return done
}

function stale(path: string, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > STALE_MS
  } catch {
    return false
  }
}

function sweep(dir: string, now: number): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) if (stale(join(dir, n), now)) rmSync(join(dir, n), { force: true })
}
