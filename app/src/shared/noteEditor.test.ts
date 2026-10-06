import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteEditor, SAVE_AFTER_MS, SAVE_RETRY_MS, afterSave, blankDraft, draftOf, noteTargetKey, type NoteDraft } from './noteEditor'
import { noteMeta, ticketNoteId, type Note, type NoteChange, type NoteInput, type NoteMeta, type SaveResult } from './notes'

const ID = (n: number) => 'n-' + String(n).padStart(32, '0')

/** A store like the real one where it matters here (versions, conflicts, force), whose answers wait for `answer()`. */
class FakeStore {
  notes = new Map<string, Note>()
  clock = 100
  made = 0
  /** Calls not answered yet, oldest first. */
  waiting: (() => void)[] = []
  saves: NoteInput[] = []
  /** The line is down: a save gets no answer. */
  down = false
  /** The store's reason for taking nothing (the limit, a character). */
  refusing = ''
  /** The store's change event, as the list hears it. */
  onEvent: (c: NoteChange) => void = () => {}

  erase(id: string): void {
    this.notes.delete(id)
    this.onEvent({ id, deleted: true })
  }
  write(id: string, title: string, body: string, ticket: Note['ticket'] = null): Note {
    const old = this.notes.get(id)
    const n: Note = { id, title, body, ticket, created: old?.created ?? this.clock, updated: ++this.clock }
    this.notes.set(id, n)
    this.onEvent({ id, meta: noteMeta(n) })
    return n
  }
  private apply(i: NoteInput): SaveResult {
    if (this.refusing) return { ok: false, message: this.refusing }
    // A ticket's note is named by its ticket, as in the real store.
    const id = i.ticket ? ticketNoteId(i.ticket.repo ?? 'acme/tracker', i.ticket.number)! : i.id
    const old = id ? (this.notes.get(id) ?? null) : null
    if (!i.force && (old?.updated ?? null) !== i.base) return { ok: false, conflict: true, note: old }
    if (i.ticket && id && !i.body.trim()) {
      if (old) this.erase(id)
      return { ok: true, deleted: true, id }
    }
    return { ok: true, meta: noteMeta(this.write(id ?? ID(++this.made), i.ticket ? '' : i.title, i.body, i.ticket ? { repo: i.ticket.repo ?? 'acme/tracker', number: i.ticket.number } : null)) }
  }
  save = (i: NoteInput): Promise<SaveResult> => {
    this.saves.push(i)
    return new Promise((done, fail) => this.waiting.push(() => (this.down ? fail(new Error('offline')) : done(this.apply(i)))))
  }
  get = async (id: string): Promise<Note | null> => this.notes.get(id) ?? null
  /** The oldest waiting call reaches the store and its answer comes back. */
  async answer(): Promise<void> {
    this.waiting.shift()!()
    await settle()
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

let store: FakeStore
let ed: NoteEditor
let metas: Map<string, NoteMeta>
const row = () => (ed.draft?.id ? metas.get(ed.draft.id) : undefined)
const open = (n: Note) => ed.show({ id: n.id }, async () => draftOf((await store.get(n.id))!))

beforeEach(() => {
  vi.useFakeTimers()
  store = new FakeStore()
  ed = new NoteEditor({ save: store.save, get: store.get })
  metas = new Map()
  const apply = (c: NoteChange) => ('meta' in c ? metas.set(c.id, c.meta) : metas.delete(c.id))
  store.onEvent = apply
  ed.onApplied = apply
})
afterEach(() => vi.useRealTimers())

describe('afterSave', () => {
  const sent: NoteDraft = { id: null, ticket: null, title: 'a', body: 'one', base: null, dirty: true }
  const meta = noteMeta({ id: ID(1), title: 'a', body: 'one', ticket: null, created: 1, updated: 7 })
  it('takes the id and the version, and is clean when nothing was typed since', () => {
    expect(afterSave(sent, sent, { ok: true, meta })).toEqual({ ...sent, id: ID(1), base: 7, dirty: false })
  })
  it('keeps what was typed while the save was out, still to be saved', () => {
    const now = { ...sent, body: 'one two' }
    expect(afterSave(sent, now, { ok: true, meta })).toEqual({ ...now, id: ID(1), base: 7, dirty: true })
  })
  it('a save that was not taken changes nothing', () => {
    expect(afterSave(sent, sent, { ok: false, message: 'no' })).toBe(sent)
    expect(afterSave(sent, sent, { ok: false, conflict: true, note: null })).toBe(sent)
  })
  it('a ticket note removed for being empty starts over', () => {
    const t = { ...sent, id: 't-acme~tracker~5', ticket: { repo: 'acme/tracker', number: 5 }, body: '', base: 3 }
    expect(afterSave(t, t, { ok: true, deleted: true, id: t.id })).toEqual({ ...t, id: null, base: null, dirty: false })
  })
})

describe('noteTargetKey', () => {
  it('names a note, a ticket, a new draft, or the list', () => {
    expect(noteTargetKey({})).toBe('')
    expect(noteTargetKey({ id: ID(1) })).toBe(`i:${ID(1)}`)
    expect(noteTargetKey({ ticket: { repo: 'Acme/Web', number: 5 } })).toBe('t:acme/web#5')
    expect(noteTargetKey({ fresh: 1 })).not.toBe(noteTargetKey({ fresh: 2 }))
  })
})

describe('typing and saving', () => {
  it('saves half a second after the last key, once', async () => {
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    ed.edit({ title: 'To' })
    vi.advanceTimersByTime(SAVE_AFTER_MS - 1)
    ed.edit({ title: 'Tomorrow' })
    vi.advanceTimersByTime(SAVE_AFTER_MS - 1)
    expect(store.saves).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(ed.status).toBe('Saving…')
    await store.answer()
    expect(store.saves).toEqual([{ id: undefined, title: 'Tomorrow', body: '', ticket: null, base: null, force: false }])
    expect(ed.draft).toMatchObject({ id: ID(1), dirty: false, base: store.notes.get(ID(1))!.updated })
    expect(ed.status).toBe('Saved')
  })

  it('text typed while a save is out stays, and is saved next with the new version as its base', async () => {
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    ed.edit({ body: 'one' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    ed.edit({ body: 'one two' })
    // The timer for the second key fires while the first save is out: no second save beside it.
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    expect(store.saves).toHaveLength(1)
    await store.answer()
    expect(ed.draft).toMatchObject({ id: ID(1), body: 'one two', dirty: true })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(store.saves[1]).toMatchObject({ id: ID(1), body: 'one two', base: 101 })
    expect(store.notes.size).toBe(1)
    expect(store.notes.get(ID(1))!.body).toBe('one two')
    expect(ed.draft!.dirty).toBe(false)
    expect(ed.clash).toBeNull()
  })

  it('the change event of its own save, heard before the answer, is not taken for someone else', async () => {
    const n = store.write(ID(1), 'a', 'one')
    await open(n)
    ed.edit({ body: 'one two' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    // The store wrote and told the list; the answer is still on its way.
    store.onEvent({ id: n.id, meta: { ...noteMeta(n), updated: 999 } })
    ed.seen(row(), true)
    await settle()
    expect(ed.clash).toBeNull()
    expect(ed.draft!.body).toBe('one two')
    await store.answer()
    ed.seen(row(), true)
    await settle()
    expect(ed.clash).toBeNull()
    expect(ed.draft).toMatchObject({ body: 'one two', dirty: false })
  })

  it('a save that got no answer keeps the text and tries again', async () => {
    const n = store.write(ID(1), 'a', 'one')
    await open(n)
    store.down = true
    ed.edit({ body: 'one two' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(ed.status).toBe('Not saved')
    expect(ed.draft).toMatchObject({ body: 'one two', dirty: true })
    store.down = false
    vi.advanceTimersByTime(SAVE_RETRY_MS)
    await store.answer()
    expect(store.notes.get(n.id)!.body).toBe('one two')
    expect(ed.draft!.dirty).toBe(false)
  })

  it('a save that throws (the line dropped) is a failed save', async () => {
    const bad = new NoteEditor({ save: () => Promise.reject(new Error('gone')), get: store.get })
    await bad.show({ fresh: 1 }, async () => blankDraft(null))
    bad.edit({ body: 'x' })
    expect(await bad.flush()).toBe(false)
    expect(bad.draft).toMatchObject({ body: 'x', dirty: true })
    expect(bad.status).toBe('Not saved')
  })
})

describe('another note is asked for', () => {
  it('what is typed is saved first, also when a save was already out and more was typed', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'other')
    await open(a)
    ed.edit({ body: 'one two' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    ed.edit({ body: 'one two three' })
    const shown = open(b)
    await settle()
    expect(ed.draft!.id).toBe(a.id)
    await store.answer()
    // Still on the first note: the rest has to go too.
    expect(ed.draft!.id).toBe(a.id)
    await store.answer()
    expect(await shown).toBe(true)
    expect(store.notes.get(a.id)!.body).toBe('one two three')
    expect(ed.draft).toMatchObject({ id: b.id, body: 'other', dirty: false })
    expect(ed.key).toBe(`i:${b.id}`)
  })

  it('text typed while the other note is being read is saved too', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'other')
    await open(a)
    let read!: () => void
    const shown = ed.show({ id: b.id }, () => new Promise((done) => (read = () => done(draftOf(b)))))
    await settle()
    ed.edit({ body: 'typed late' })
    read()
    await settle()
    expect(ed.draft!.id).toBe(a.id)
    await store.answer()
    expect(await shown).toBe(true)
    expect(store.notes.get(a.id)!.body).toBe('typed late')
    expect(ed.draft!.id).toBe(b.id)
  })

  it('stays on the open note when its text cannot be saved', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'other')
    await open(a)
    store.down = true
    ed.edit({ body: 'one two' })
    const shown = open(b)
    await settle()
    await store.answer()
    expect(await shown).toBe(false)
    expect(ed.draft).toMatchObject({ id: a.id, body: 'one two', dirty: true })
    expect(ed.key).toBe(`i:${a.id}`)
    // Where the panel goes back to.
    expect(ed.target).toEqual({ id: a.id })
  })

  it('stays on the open note while the user has not chosen between two versions', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'other')
    await open(a)
    ed.edit({ body: 'mine' })
    store.write(a.id, 'a', 'theirs')
    const shown = open(b)
    await settle()
    await store.answer()
    expect(await shown).toBe(false)
    expect(ed.clash).toMatchObject({ kind: 'changed', note: { body: 'theirs' } })
    expect(ed.draft).toMatchObject({ id: a.id, body: 'mine', dirty: true })
    expect(store.notes.get(a.id)!.body).toBe('theirs')
  })

  it('a new draft does not inherit the id of the note whose save was still out', async () => {
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    ed.edit({ body: 'first' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    const shown = ed.show({ fresh: 2 }, async () => blankDraft(null))
    await settle()
    await store.answer()
    await shown
    expect(ed.draft).toEqual(blankDraft(null))
    ed.edit({ body: 'second' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect([...store.notes.values()].map((n) => n.body).sort()).toEqual(['first', 'second'])
  })

  it('asking again for what is open keeps the text being typed', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    ed.edit({ body: 'one two' })
    expect(await open(a)).toBe(true)
    expect(ed.draft).toMatchObject({ body: 'one two', dirty: true })
    expect(store.saves).toHaveLength(0)
  })

  it('the newest request wins', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'two')
    let read!: () => void
    const first = ed.show({ id: a.id }, () => new Promise((done) => (read = () => done(draftOf(a)))))
    await settle()
    await open(b)
    read()
    await first
    expect(ed.draft!.id).toBe(b.id)
  })

  it('a note that cannot be read leaves things as they are', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    expect(await ed.show({ id: 'x' }, () => Promise.reject(new Error('no')))).toBe(false)
    expect(ed.draft!.id).toBe(a.id)
  })
})

describe('the panel closes', () => {
  it('what is typed is sent, and what was typed while a save was out goes after it', async () => {
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    ed.edit({ body: 'one' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    ed.edit({ body: 'one two' })
    const done = ed.flush()
    await store.answer()
    await store.answer()
    expect(await done).toBe(true)
    expect([...store.notes.values()].map((n) => n.body)).toEqual(['one two'])
  })

  it('text that could not be saved is still in the editor when the panel opens again', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    store.down = true
    ed.edit({ body: 'one two' })
    const closed = ed.flush()
    await store.answer()
    expect(await closed).toBe(false)
    // Opened again on the list: the editor will not leave the text.
    const shown = ed.show({}, async () => null)
    await settle()
    await store.answer()
    expect(await shown).toBe(false)
    expect(ed.draft).toMatchObject({ id: a.id, body: 'one two', dirty: true })
    store.down = false
    vi.advanceTimersByTime(SAVE_RETRY_MS)
    await store.answer()
    expect(store.notes.get(a.id)!.body).toBe('one two')
    expect(await ed.show({}, async () => null)).toBe(true)
    expect(ed.draft).toBeNull()
  })
})

describe('the note changed somewhere else', () => {
  it('a clean editor takes the new text', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    store.write(a.id, 'a2', 'from elsewhere')
    ed.seen(row(), true)
    await settle()
    expect(ed.clash).toBeNull()
    expect(ed.draft).toMatchObject({ title: 'a2', body: 'from elsewhere', dirty: false, base: store.notes.get(a.id)!.updated })
  })

  it('an editor with unsaved text asks, and writes nothing until the user chose', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    ed.edit({ body: 'mine' })
    store.write(a.id, 'a', 'theirs')
    ed.seen(row(), true)
    await settle()
    expect(ed.clash).toMatchObject({ kind: 'changed', note: { body: 'theirs' } })
    vi.advanceTimersByTime(SAVE_RETRY_MS * 3)
    expect(store.saves).toHaveLength(0)
    expect(ed.draft!.body).toBe('mine')
  })

  it('text typed while the changed note is being read is not replaced', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    store.write(a.id, 'a', 'theirs')
    ed.seen(row(), true)
    ed.edit({ body: 'typed late' })
    await settle()
    expect(ed.draft!.body).toBe('typed late')
    expect(ed.clash).toMatchObject({ kind: 'changed' })
  })

  it('Reload takes their version', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    ed.edit({ body: 'mine' })
    store.write(a.id, 'a', 'theirs')
    ed.seen(row(), true)
    await settle()
    ed.reload()
    expect(ed.draft).toMatchObject({ body: 'theirs', dirty: false, base: store.notes.get(a.id)!.updated })
    expect(ed.clash).toBeNull()
    vi.advanceTimersByTime(SAVE_RETRY_MS)
    expect(store.saves).toHaveLength(0)
  })

  it('Keep mine writes the typed text over it', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    ed.edit({ body: 'mine' })
    store.write(a.id, 'a', 'theirs')
    ed.seen(row(), true)
    await settle()
    const kept = ed.keepMine()
    await settle()
    await store.answer()
    await kept
    expect(store.saves.at(-1)).toMatchObject({ id: a.id, body: 'mine', force: true })
    expect(store.notes.get(a.id)!.body).toBe('mine')
    expect(ed.clash).toBeNull()
    expect(ed.draft!.dirty).toBe(false)
  })

  it('a note deleted elsewhere: Keep writes it again, Discard drops it', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    store.notes.delete(a.id)
    store.onEvent({ id: a.id, deleted: true })
    ed.seen(row(), true)
    expect(ed.clash).toEqual({ kind: 'gone' })
    const kept = ed.keepMine()
    await settle()
    await store.answer()
    await kept
    expect(store.notes.get(a.id)!.body).toBe('one')
    expect(ed.clash).toBeNull()

    store.notes.delete(a.id)
    store.onEvent({ id: a.id, deleted: true })
    ed.seen(row(), true)
    ed.drop()
    expect(ed.draft).toBeNull()
    expect(ed.key).toBe('')
  })

  it('says nothing before the list was read, or for a draft never saved', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    ed.seen(undefined, false)
    expect(ed.clash).toBeNull()
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    ed.seen(undefined, true)
    expect(ed.clash).toBeNull()
  })
})

describe('delete', () => {
  const del = (id: string) => {
    store.notes.delete(id)
    store.onEvent({ id, deleted: true })
    return Promise.resolve({ ok: true })
  }
  it('removes the note and closes the editor', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    expect(await ed.remove(del)).toBe(true)
    expect(store.notes.size).toBe(0)
    expect(ed.draft).toBeNull()
    expect(metas.size).toBe(0)
  })

  it('waits for a first save on its way, so the note is not stored after it was deleted', async () => {
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    ed.edit({ body: 'one' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    const gone = ed.remove(del)
    await settle()
    await store.answer()
    expect(await gone).toBe(true)
    expect(store.notes.size).toBe(0)
    expect(ed.draft).toBeNull()
  })

  it('a draft never saved is dropped without asking the store', async () => {
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    const asked = vi.fn(del)
    expect(await ed.remove(asked)).toBe(true)
    expect(asked).not.toHaveBeenCalled()
  })

  it('cancelled: the note and its unsaved text stay, and the text is saved', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    ed.edit({ body: 'one two' })
    expect(await ed.remove(async () => ({ ok: false, message: 'cancelled' }))).toBe(false)
    expect(ed.status).toBe('')
    expect(ed.draft).toMatchObject({ body: 'one two', dirty: true })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(store.notes.get(a.id)!.body).toBe('one two')
  })
})

describe('a save the store refuses', () => {
  const LIMIT = '1000 notes is the limit. Delete some first.'
  const refuse = async (n: Note) => {
    await open(n)
    store.refusing = LIMIT
    ed.edit({ body: 'more' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
  }

  it('is not tried again by a timer, and says why', async () => {
    await refuse(store.write(ID(1), 'a', 'one'))
    expect(ed.refused).toBe(LIMIT)
    expect(ed.status).toBe(LIMIT)
    expect(ed.stayed).toBe(false)
    expect(ed.draft).toMatchObject({ body: 'more', dirty: true })
    vi.advanceTimersByTime(SAVE_RETRY_MS * 10)
    // Leaving the field with the same text asks nothing either.
    ed.saveNow()
    expect(store.saves).toHaveLength(1)
  })

  it('a later key tries again', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await refuse(a)
    ed.edit({ body: 'more text' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    expect(store.saves).toHaveLength(2)
    await store.answer()
    expect(ed.refused).toBe(LIMIT)
    store.refusing = ''
    ed.edit({ body: 'fits now' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(store.notes.get(a.id)!.body).toBe('fits now')
    expect(ed.refused).toBeNull()
    expect(ed.draft!.dirty).toBe(false)
  })

  it('text typed while the refused save was out gets its own try', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    store.refusing = LIMIT
    ed.edit({ body: 'more' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    ed.edit({ body: 'more and more' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    expect(store.saves).toHaveLength(2)
    expect(store.saves[1].body).toBe('more and more')
  })

  it('a switch away is tried, refused, and reported in the editor', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'other')
    await refuse(a)
    const shown = open(b)
    await settle()
    // Leaving is a reason to ask the store again.
    expect(store.saves).toHaveLength(2)
    await store.answer()
    expect(await shown).toBe(false)
    expect(ed.stayed).toBe(true)
    expect(ed.target).toEqual({ id: a.id })
    expect(ed.draft).toMatchObject({ id: a.id, body: 'more', dirty: true })
    // The next key takes the remark away; the refusal stands until the store says otherwise.
    ed.edit({ body: 'more!' })
    expect(ed.stayed).toBe(false)
    expect(ed.refused).toBe(LIMIT)
  })

  it('closing the panel is reported the same way', async () => {
    await refuse(store.write(ID(1), 'a', 'one'))
    const left = ed.leave()
    await settle()
    await store.answer()
    expect(await left).toBe(false)
    expect(ed.stayed).toBe(true)
  })

  it('Discard on a stored note brings its stored text back', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await refuse(a)
    await ed.discardUnsaved()
    expect(ed.draft).toEqual(draftOf(store.notes.get(a.id)!))
    expect(ed.refused).toBeNull()
    expect(ed.status).toBe('')
    expect(ed.key).toBe(`i:${a.id}`)
    vi.advanceTimersByTime(SAVE_RETRY_MS)
    expect(store.saves).toHaveLength(1)
    // And the editor can be left again.
    expect(await ed.show({}, async () => null)).toBe(true)
  })

  it('Discard on a draft never saved closes it', async () => {
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    store.refusing = LIMIT
    ed.edit({ body: 'one too many' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(ed.refused).toBe(LIMIT)
    await ed.discardUnsaved()
    expect(ed.draft).toBeNull()
    expect(ed.target).toEqual({})
    expect(ed.refused).toBeNull()
    expect(store.notes.size).toBe(0)
  })

  it('Discard does nothing when nothing was refused', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    ed.edit({ body: 'mine' })
    await ed.discardUnsaved()
    expect(ed.draft).toMatchObject({ body: 'mine', dirty: true })
  })

  it('no answer at all is still tried again every few seconds', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    store.down = true
    ed.edit({ body: 'more' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(ed.refused).toBeNull()
    vi.advanceTimersByTime(SAVE_RETRY_MS)
    expect(store.saves).toHaveLength(2)
  })
})

describe("a ticket's note", () => {
  const T = { repo: 'acme/tracker', number: 5 }
  const TID = 't-acme~tracker~5'
  const openTicket = () => ed.show({ ticket: T }, async () => blankDraft(T))

  it('is saved with its ticket and takes its id from the answer', async () => {
    await openTicket()
    expect(ed.key).toBe('t:acme/tracker#5')
    ed.edit({ body: 'waiting for the API' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(store.saves[0]).toEqual({ id: undefined, title: '', body: 'waiting for the API', ticket: T, base: null, force: false })
    expect(ed.draft).toMatchObject({ id: TID, base: store.notes.get(TID)!.updated, dirty: false })
  })

  it('emptied, it is removed, and the next text starts a new one', async () => {
    await openTicket()
    ed.edit({ body: 'x' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    ed.edit({ body: '' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(store.notes.size).toBe(0)
    expect(metas.size).toBe(0)
    expect(ed.draft).toMatchObject({ id: null, base: null, dirty: false, ticket: T })
    expect(ed.status).toBe('')
    ed.seen(row(), true)
    expect(ed.clash).toBeNull()
    ed.edit({ body: 'again' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(store.notes.get(TID)!.body).toBe('again')
  })

  it('met by a note made elsewhere: Reload makes the draft that note, so Delete deletes it and changes are seen', async () => {
    await openTicket()
    ed.edit({ body: 'mine' })
    store.write(TID, '', 'theirs', T)
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(ed.clash).toMatchObject({ kind: 'changed', note: { body: 'theirs' } })
    ed.reload()
    expect(ed.draft).toEqual(draftOf(store.notes.get(TID)!))
    // Watched like any stored note.
    store.write(TID, '', 'theirs, again', T)
    ed.seen(row(), true)
    await settle()
    expect(ed.draft!.body).toBe('theirs, again')
    // And Delete asks, then deletes the stored note.
    const ask = vi.fn(async () => true)
    const del = vi.fn(async (id: string) => (store.erase(id), { ok: true }))
    expect(await ed.remove(del, ask)).toBe(true)
    expect(ask).toHaveBeenCalledOnce()
    expect(del).toHaveBeenCalledWith(TID)
    expect(store.notes.size).toBe(0)
  })

  it('met by a note made elsewhere: Keep mine writes over it', async () => {
    await openTicket()
    ed.edit({ body: 'mine' })
    store.write(TID, '', 'theirs', T)
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    const kept = ed.keepMine()
    await settle()
    await store.answer()
    await kept
    expect(store.notes.get(TID)!.body).toBe('mine')
    expect(ed.draft).toMatchObject({ id: TID, dirty: false })
  })
})

describe('more than one thing at a time', () => {
  it('a second request while the first waits for a save: the second is shown', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'two')
    const c = store.write(ID(3), 'c', 'three')
    await open(a)
    ed.edit({ body: 'one more' })
    const first = open(b)
    await settle()
    const second = open(c)
    await settle()
    await store.answer()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(store.notes.get(a.id)!.body).toBe('one more')
    expect(ed.draft!.id).toBe(c.id)
    expect(ed.target).toEqual({ id: c.id })
  })

  it('cancelShow: a request still waiting changes nothing, and the text is saved all the same', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'two')
    await open(a)
    ed.edit({ body: 'one more' })
    const shown = open(b)
    await settle()
    ed.cancelShow()
    await store.answer()
    expect(await shown).toBe(true)
    expect(ed.draft).toMatchObject({ id: a.id, body: 'one more', dirty: false })
    expect(ed.key).toBe(`i:${a.id}`)
  })

  it('the row of the open draft: the same note under another name keeps the newest text', async () => {
    await ed.show({ fresh: 1 }, async () => blankDraft(null))
    ed.edit({ body: 'one' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    const id = ed.draft!.id!
    ed.edit({ body: 'one two' })
    // Its row is clicked while that text is unsaved; more is typed while the note is read.
    let read!: () => void
    const shown = ed.show({ id }, async () => {
      const n = draftOf((await store.get(id))!)
      await new Promise<void>((done) => (read = done))
      return n
    })
    await settle()
    await store.answer()
    expect(store.notes.get(id)!.body).toBe('one two')
    ed.edit({ body: 'one two three' })
    read()
    await settle()
    await store.answer()
    expect(await shown).toBe(true)
    expect(ed.draft).toMatchObject({ id, body: 'one two three', dirty: false })
    expect(ed.target).toEqual({ id })
    ed.seen(row(), true)
    await settle()
    expect(ed.clash).toBeNull()
  })

  it('unsaved text in a note deleted elsewhere is kept until the user chooses', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'two')
    await open(a)
    ed.edit({ body: 'mine' })
    store.erase(a.id)
    ed.seen(row(), true)
    expect(ed.clash).toEqual({ kind: 'gone' })
    vi.advanceTimersByTime(SAVE_RETRY_MS)
    expect(store.saves).toHaveLength(0)
    expect(await open(b)).toBe(false)
    expect(ed.draft).toMatchObject({ id: a.id, body: 'mine', dirty: true })
    const kept = ed.keepMine()
    await settle()
    await store.answer()
    await kept
    expect(store.notes.get(a.id)!.body).toBe('mine')
  })

  it('Delete: when another note was opened while the question was on screen, nothing is deleted', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'two')
    await open(a)
    let answer!: (yes: boolean) => void
    const del = vi.fn(async () => ({ ok: true }))
    const gone = ed.remove(del, () => new Promise((done) => (answer = done)))
    await settle()
    await open(b)
    answer(true)
    expect(await gone).toBe(false)
    expect(del).not.toHaveBeenCalled()
    expect(ed.draft!.id).toBe(b.id)
  })

  it('Delete: the question answered no leaves everything', async () => {
    const a = store.write(ID(1), 'a', 'one')
    await open(a)
    const del = vi.fn(async () => ({ ok: true }))
    expect(await ed.remove(del, async () => false)).toBe(false)
    expect(del).not.toHaveBeenCalled()
    expect(ed.draft!.id).toBe(a.id)
  })

  it('only Keep mine and Keep ever force a save', async () => {
    const a = store.write(ID(1), 'a', 'one')
    const b = store.write(ID(2), 'b', 'two')
    await open(a)
    ed.edit({ body: 'timer' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    ed.edit({ body: 'blur' })
    ed.saveNow()
    await store.answer()
    ed.edit({ body: 'switch' })
    const shown = open(b)
    await settle()
    await store.answer()
    await shown
    ed.edit({ body: 'close' })
    const left = ed.leave()
    await settle()
    await store.answer()
    await left
    store.down = true
    ed.edit({ body: 'retry' })
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    store.down = false
    vi.advanceTimersByTime(SAVE_RETRY_MS)
    await store.answer()
    // A conflict, met by a plain save.
    ed.edit({ body: 'mine' })
    store.write(b.id, 'b', 'theirs')
    vi.advanceTimersByTime(SAVE_AFTER_MS)
    await store.answer()
    expect(ed.clash).not.toBeNull()
    expect(store.saves.length).toBeGreaterThanOrEqual(7)
    expect(store.saves.every((i) => i.force === false)).toBe(true)
    const kept = ed.keepMine()
    await settle()
    await store.answer()
    await kept
    expect(store.saves.filter((i) => i.force)).toHaveLength(1)
    expect(store.saves.at(-1)).toMatchObject({ body: 'mine', force: true })
  })
})
