import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setConfig, DEFAULT_CONFIG } from './appConfig'
import { applyOwnChange, noteMeta, ticketNote, type Note, type NoteInput, type SaveResult } from './notes'
import { TicketNoteDrafts, nothingToSave, recreateDraft, reloadDraft, saveStep, saveTicketNote, shownTicketNote, startDraft } from './ticketNoteInline'

const ticket = { repo: 'acme/web', number: 7 }
const stored = (over: Partial<Note> = {}): Note => ({
  id: 't-acme~web~7', title: '', body: 'waiting on review', ticket, created: 1, updated: 10, ...over,
})

beforeEach(() => setConfig({ ...DEFAULT_CONFIG, owner: 'acme', issueRepo: 'web' }))

describe('ticketNote', () => {
  const N = (n: number) => 'n-' + String(n).padStart(32, '0')
  const own = noteMeta(stored())
  const linked = noteMeta({ id: N(1), title: 'idea', body: 'x', ticket: null, link: { ticket }, created: 1, updated: 99 })
  const otherRepo = noteMeta(stored({ id: 't-acme~api~7', ticket: { repo: 'acme/api', number: 7 } }))
  const otherNumber = noteMeta(stored({ id: 't-acme~web~8', ticket: { repo: 'acme/web', number: 8 } }))
  const all = [linked, otherRepo, otherNumber, own]
  it("finds the ticket's own note, by the primary repository's null too", () => {
    expect(ticketNote(all, 'acme/web', 7)?.id).toBe(own.id)
    expect(ticketNote(all, null, 7)?.id).toBe(own.id)
    expect(ticketNote(all, 'Acme/Web', 7)?.id).toBe(own.id)
  })
  it('a note only linked to the ticket is not its note', () => {
    expect(ticketNote([linked, otherRepo, otherNumber], 'acme/web', 7)).toBeNull()
  })
})

describe('saveTicketNote', () => {
  const saver = (r: SaveResult | Error) => {
    const sent: NoteInput[] = []
    const save = vi.fn(async (i: NoteInput) => {
      sent.push(i)
      if (r instanceof Error) throw r
      return r
    })
    return { save, sent }
  }

  it('a new note is sent by its ticket, without a title, from no version', async () => {
    const meta = noteMeta(stored({ body: 'first', updated: 11 }))
    const { save, sent } = saver({ ok: true, meta })
    const out = await saveTicketNote(save, { ...startDraft(ticket, null), body: 'first' })
    expect(sent).toEqual([{ ticket, title: '', body: 'first', base: null }])
    expect(out).toEqual({ kind: 'saved', change: { id: meta.id, meta }, note: stored({ body: 'first', updated: 11 }) })
  })

  it('an edit carries the version it started from', async () => {
    const { save, sent } = saver({ ok: true, meta: noteMeta(stored({ updated: 12 })) })
    await saveTicketNote(save, { ...startDraft(ticket, stored()), body: 'more' })
    expect(sent[0].base).toBe(10)
    expect(sent[0].force).toBeUndefined()
  })

  it('saved empty, the note is removed', async () => {
    const { save } = saver({ ok: true, deleted: true, id: 't-acme~web~7' })
    expect(await saveTicketNote(save, { ...startDraft(ticket, stored()), body: '' })).toEqual({
      kind: 'saved', change: { id: 't-acme~web~7', deleted: true }, note: null,
    })
  })

  it('a version saved elsewhere is a clash, with the stored note', async () => {
    const theirs = stored({ body: 'theirs', updated: 15 })
    const { save } = saver({ ok: false, conflict: true, note: theirs })
    expect(await saveTicketNote(save, { ...startDraft(ticket, stored()), body: 'mine' })).toEqual({ kind: 'clash', note: theirs })
  })

  it('a note deleted elsewhere is a clash without a note', async () => {
    const { save } = saver({ ok: false, conflict: true, note: null })
    expect(await saveTicketNote(save, startDraft(ticket, stored()))).toEqual({ kind: 'clash', note: null })
  })

  it('Keep mine forces the write', async () => {
    const { save, sent } = saver({ ok: true, meta: noteMeta(stored({ updated: 20 })) })
    await saveTicketNote(save, startDraft(ticket, stored()), true)
    expect(sent[0].force).toBe(true)
  })

  it("the store's reason is kept; a disk failure or no answer may be tried again", async () => {
    expect(await saveTicketNote(saver({ ok: false, message: 'Too long' }).save, startDraft(ticket, null))).toEqual({ kind: 'refused', message: 'Too long' })
    expect(await saveTicketNote(saver({ ok: false, message: 'Disk', retry: true }).save, startDraft(ticket, null))).toEqual({ kind: 'failed' })
    expect(await saveTicketNote(saver(new Error('down')).save, startDraft(ticket, null))).toEqual({ kind: 'failed' })
  })
})

describe('shownTicketNote', () => {
  const old = stored({ body: 'old', updated: 10 })
  const mine = stored({ body: 'mine', updated: 20 })
  it('its own save is drawn at once, before the re-read', () => {
    expect(shownTicketNote({ id: mine.id, updated: 20 }, old, mine)).toBe(mine)
  })
  it('a newer read (an edit elsewhere) takes over from its own save', () => {
    const theirs = stored({ body: 'theirs', updated: 30 })
    expect(shownTicketNote({ id: mine.id, updated: 30 }, theirs, mine)).toBe(theirs)
  })
  it('nothing the row does not count yet, and nothing once the note is gone', () => {
    expect(shownTicketNote({ id: mine.id, updated: 10 }, old, mine)).toBe(old)
    expect(shownTicketNote(null, old, mine)).toBeNull()
    expect(shownTicketNote({ id: 't-acme~web~8', updated: 99 }, old, mine)).toBeNull()
  })
})

describe('drafts', () => {
  it('Reload takes the stored text and version; Keep after a delete starts a new note', () => {
    const d = { ...startDraft(ticket, stored()), body: 'mine' }
    expect(reloadDraft(d, stored({ body: 'theirs', updated: 30 }))).toEqual({ ticket, base: 30, body: 'theirs' })
    expect(recreateDraft(d)).toEqual({ ticket, base: null, body: 'mine' })
  })
  it('an empty box for a ticket without a note has nothing to save', () => {
    expect(nothingToSave(startDraft(ticket, null))).toBe(true)
    expect(nothingToSave({ ...startDraft(ticket, null), body: '  \n' })).toBe(true)
    expect(nothingToSave({ ...startDraft(ticket, stored()), body: '' })).toBe(false)
  })
  it('are kept per ticket, the primary repository by either name', () => {
    const drafts = new TicketNoteDrafts()
    drafts.set({ ...startDraft({ repo: null, number: 7 }, null), body: 'x' })
    expect(drafts.get(ticket)?.body).toBe('x')
    expect(drafts.get({ repo: 'acme/web', number: 8 })).toBeUndefined()
    drafts.clear(ticket)
    expect(drafts.get({ repo: null, number: 7 })).toBeUndefined()
  })
})

describe('saveStep', () => {
  it('an unchanged note, or nothing typed for a new one, writes nothing', () => {
    expect(saveStep(startDraft(ticket, stored()), stored())).toBe('close')
    expect(saveStep(startDraft(ticket, null), null)).toBe('close')
  })
  it('a stored note emptied is a delete (asked first), never a quiet save', () => {
    expect(saveStep({ ...startDraft(ticket, stored()), body: ' \n' }, stored())).toBe('delete')
  })
  it('changed text is saved; so is text whose version moved meanwhile (the store says clash)', () => {
    expect(saveStep({ ...startDraft(ticket, stored()), body: 'more' }, stored())).toBe('send')
    expect(saveStep(startDraft(ticket, stored()), stored({ updated: 11 }))).toBe('send')
    expect(saveStep({ ...startDraft(ticket, null), body: 'first' }, null)).toBe('send')
  })
})

describe('applyOwnChange', () => {
  const v = (updated: number, body = 'x') => noteMeta(stored({ updated, body }))
  it("its own answer never puts back an older version than the list's", () => {
    expect(applyOwnChange([v(30, 'theirs')], { id: 't-acme~web~7', meta: v(20, 'mine') })[0].preview).toBe('theirs')
    expect(applyOwnChange([v(10)], { id: 't-acme~web~7', meta: v(20, 'mine') })[0].preview).toBe('mine')
  })
  it('its own delete removes only the version it deleted', () => {
    expect(applyOwnChange([v(30)], { id: 't-acme~web~7', deleted: true }, 10)).toHaveLength(1)
    expect(applyOwnChange([v(10)], { id: 't-acme~web~7', deleted: true }, 10)).toHaveLength(0)
  })
})

describe('a save from the panel against a store that checks versions', () => {
  // The store's rule (main/notes.ts): a save is taken only from the stored version, unless forced.
  const store = () => {
    let note: Note | null = stored()
    let t = 10
    const save = async (i: NoteInput): Promise<SaveResult> => {
      if (!i.force && (note?.updated ?? null) !== i.base) return { ok: false, conflict: true, note }
      note = stored({ body: i.body, updated: ++t })
      return { ok: true, meta: noteMeta(note) }
    }
    const elsewhere = (body: string) => (note = stored({ body, updated: ++t }))
    return { save, elsewhere, now: () => note }
  }

  it('an edit elsewhere meanwhile is a clash; Reload then Save keeps both', async () => {
    const s = store()
    const d = { ...startDraft(ticket, s.now()), body: 'mine' }
    s.elsewhere('theirs')
    const out = await saveTicketNote(s.save, d)
    expect(out).toMatchObject({ kind: 'clash', note: { body: 'theirs' } })
    expect(s.now()?.body).toBe('theirs')
    const again = { ...reloadDraft(d, (out as { note: Note }).note), body: 'theirs + mine' }
    expect(await saveTicketNote(s.save, again)).toMatchObject({ kind: 'saved', note: { body: 'theirs + mine' } })
  })

  it('Keep mine writes over the other version', async () => {
    const s = store()
    const d = { ...startDraft(ticket, s.now()), body: 'mine' }
    s.elsewhere('theirs')
    expect((await saveTicketNote(s.save, d)).kind).toBe('clash')
    expect(await saveTicketNote(s.save, d, true)).toMatchObject({ kind: 'saved' })
    expect(s.now()?.body).toBe('mine')
  })
})
