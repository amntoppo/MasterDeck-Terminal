import { describe, it, expect } from 'vitest'
import {
  NOTE_BODY_MAX, NOTE_ID, NOTE_TITLE_MAX, applyChange, cleanNote, incoming, matches, noteMeta,
  sortNotes, storedNote, ticketNoteId, ticketTitle, type Note, type NoteMeta,
} from './notes'

const note = (over: Partial<Note> = {}): Note => ({
  id: 'n-' + '0'.repeat(32), title: 'Tomorrow', body: 'ask for a review\nmerge', ticket: null,
  created: 10, updated: 20, ...over,
})
const meta = (id: string, updated: number): NoteMeta => noteMeta(note({ id, updated }))

describe('ids', () => {
  it('accepts the two shapes only', () => {
    expect(NOTE_ID.test('n-' + 'a1'.repeat(16))).toBe(true)
    expect(NOTE_ID.test('t-acme~web.app~63')).toBe(true)
    for (const bad of ['', '..', 'n-ABC', 'n-' + 'a'.repeat(31), 't-acme/web~1', 't-Acme~web~1', 't-acme~web~0', '../x', 'n-' + 'a'.repeat(32) + '.json'])
      expect(NOTE_ID.test(bad), bad).toBe(false)
  })
  it('a ticket note id comes from the full repository, lowercased', () => {
    expect(ticketNoteId('Acme/Web.App', 63)).toBe('t-acme~web.app~63')
    expect(ticketNoteId('', 63)).toBeNull()
    expect(ticketNoteId('acme', 63)).toBeNull()
    expect(ticketNoteId('acme/web', 0)).toBeNull()
  })
})

describe('cleanNote', () => {
  it('normalises line endings and keeps tabs', () => {
    const r = cleanNote({ title: 'a', body: 'one\r\ntwo\rthree\tx', base: null })
    expect(r.ok && r.value.body).toBe('one\ntwo\nthree\tx')
  })
  it('a title is one line', () => {
    const r = cleanNote({ title: 'a\nb\tc', body: '', base: null })
    expect(r.ok && r.value.title).toBe('a b c')
  })
  it('refuses control characters and text over the limits, without cutting', () => {
    expect(cleanNote({ title: 'a', body: 'x\x1b[31m', base: null }).ok).toBe(false)
    expect(cleanNote({ title: 'a', body: 'x'.repeat(NOTE_BODY_MAX + 1), base: null }).ok).toBe(false)
    expect(cleanNote({ title: 'x'.repeat(NOTE_TITLE_MAX + 1), body: '', base: null }).ok).toBe(false)
    expect(cleanNote({ title: 'a', body: 'x'.repeat(NOTE_BODY_MAX), base: null }).ok).toBe(true)
  })
  it('refuses a bad id, a bad ticket, a bad base and a non-object', () => {
    expect(cleanNote({ id: '../x', title: '', body: '', base: null }).ok).toBe(false)
    expect(cleanNote({ title: '', body: '', base: null, ticket: { repo: 'not a repo', number: 1 } }).ok).toBe(false)
    expect(cleanNote({ title: '', body: '', base: 'yesterday' }).ok).toBe(false)
    expect(cleanNote(null).ok).toBe(false)
    expect(cleanNote('text').ok).toBe(false)
  })
  it('keeps a ticket and reads force', () => {
    const r = cleanNote({ title: 'ignored', body: 'b', base: 5, force: true, ticket: { repo: 'acme/web', number: 63 } })
    expect(r.ok && r.value).toEqual({ id: undefined, title: 'ignored', body: 'b', base: 5, force: true, ticket: { repo: 'acme/web', number: 63 } })
  })
})

describe('storedNote', () => {
  it('accepts what the store writes', () => {
    expect(storedNote(note(), note().id)).toEqual(note())
    const t = note({ id: 't-acme~web~63', title: '', ticket: { repo: 'acme/web', number: 63 } })
    expect(storedNote(t, t.id)).toEqual(t)
  })
  it('refuses a file whose name is not its id, a ticket note whose id is not its ticket, and bad fields', () => {
    expect(storedNote(note(), 'n-' + '1'.repeat(32))).toBeNull()
    expect(storedNote(note({ id: 't-acme~web~63', ticket: { repo: 'acme/other', number: 63 } }), 't-acme~web~63')).toBeNull()
    expect(storedNote(note({ id: 't-acme~web~63' }), 't-acme~web~63')).toBeNull()
    expect(storedNote({ ...note(), body: 'x'.repeat(NOTE_BODY_MAX + 1) }, note().id)).toBeNull()
    expect(storedNote({ ...note(), updated: 'now' }, note().id)).toBeNull()
    expect(storedNote([], note().id)).toBeNull()
  })
})

describe('list helpers', () => {
  it('noteMeta drops the body and keeps a one-line preview', () => {
    const m = noteMeta(note({ body: '  first\n\nsecond ' + 'x'.repeat(200) }))
    expect('body' in m).toBe(false)
    expect(m.preview.startsWith('first second x')).toBe(true)
    expect(m.preview.length).toBe(120)
  })
  it('the preview reads the Markdown: marks, addresses and tags are gone, the words stay', () => {
    const body = '# Plan\n\n- [x] **ship** it\n- [ ] read [the docs](https://example.com/d)\n\n<b>bold?</b> `code`'
    expect(noteMeta(note({ body })).preview).toBe('Plan ☑ ship it · ☐ read the docs <b>bold?</b> code')
  })
  it('a plain-text note keeps its text in the preview', () => {
    expect(noteMeta(note({ body: 'call Sam at 3\nthen 2 * 3 = 6' })).preview).toBe('call Sam at 3 then 2 * 3 = 6')
  })
  it('sorts newest edit first', () => {
    expect(sortNotes([meta('n-' + '1'.repeat(32), 5), meta('n-' + '2'.repeat(32), 9)]).map((m) => m.updated)).toEqual([9, 5])
  })
  it('matches every word, in title, body or ticket, whatever the case', () => {
    const n = note({ title: 'Review', body: 'ask Dana tomorrow' })
    expect(matches(n, '')).toBe(true)
    expect(matches(n, 'REVIEW dana')).toBe(true)
    expect(matches(n, 'review merge')).toBe(false)
    expect(matches(note({ ticket: { repo: 'acme/web', number: 63 } }), 'web#63')).toBe(true)
  })
  it('applyChange replaces, adds and removes', () => {
    const a = meta('n-' + '1'.repeat(32), 5)
    const b = meta('n-' + '2'.repeat(32), 9)
    expect(applyChange([a], { id: b.id, meta: b })).toEqual([b, a])
    expect(applyChange([a, b], { id: a.id, meta: { ...a, updated: 12 } }).map((m) => m.updated)).toEqual([12, 9])
    expect(applyChange([a, b], { id: a.id, deleted: true })).toEqual([b])
  })
})

describe('incoming', () => {
  const m = meta('n-' + '1'.repeat(32), 30)
  const e = { id: m.id, base: 20 as number | null, dirty: false, saving: false, loaded: true }
  it('ignores when there is nothing to compare', () => {
    expect(incoming({ ...e, id: null }, undefined)).toBe('ignore')
    expect(incoming({ ...e, base: null }, undefined)).toBe('ignore')
    expect(incoming({ ...e, loaded: false }, undefined)).toBe('ignore')
    expect(incoming({ ...e, base: 30 }, m)).toBe('ignore')
  })
  it('holds while its own save is in flight', () => {
    expect(incoming({ ...e, saving: true, dirty: true }, m)).toBe('hold')
    expect(incoming({ ...e, saving: true }, undefined)).toBe('hold')
  })
  it('reloads a clean editor, asks a dirty one, and says when the note is gone', () => {
    expect(incoming(e, m)).toBe('reload')
    expect(incoming({ ...e, dirty: true }, m)).toBe('ask')
    expect(incoming(e, undefined)).toBe('gone')
  })
})

describe('ticketTitle', () => {
  const issues = [{ number: 5, title: 'From issues' }]
  const cards = [{ number: 6, title: 'From the board' }, { number: 3, repo: 'acme/web', title: 'Web card' }]
  const view = [{ number: 7, repo: 'acme/api', title: 'From the view' }]
  const find = (t: { repo?: string | null; number: number }) => ticketTitle(t, issues, cards, view)
  it('finds it in the issues, on the board and in the repository view', () => {
    expect(find({ number: 5 })).toBe('From issues')
    expect(find({ number: 6 })).toBe('From the board')
    expect(find({ repo: 'acme/api', number: 7 })).toBe('From the view')
  })
  it('keeps repositories apart', () => {
    expect(find({ repo: 'Acme/Web', number: 3 })).toBe('Web card')
    expect(find({ repo: 'acme/api', number: 3 })).toBe('')
  })
  it('is empty when nobody knows it, or a list is missing', () => {
    expect(find({ number: 99 })).toBe('')
    expect(ticketTitle({ number: 1 }, undefined)).toBe('')
  })
})
