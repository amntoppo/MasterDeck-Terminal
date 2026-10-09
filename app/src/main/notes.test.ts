import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotesStore } from './notes'
import { NOTES_MAX, type NoteChange } from '@shared/notes'

let dir: string
let changes: NoteChange[]
let clock: number
const open = () =>
  new NotesStore(dir, { onChange: (c) => changes.push(c), repoOf: (r) => r ?? 'acme/web', now: () => clock })
const saved = (r: ReturnType<NotesStore['save']>) => {
  if (!r.ok || !('meta' in r)) throw new Error(JSON.stringify(r))
  return r.meta
}

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'md-notes-')), 'notes')
  changes = []
  clock = 1000
})
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

describe('NotesStore', () => {
  it('a saved note is there for the next store, and no temp file is left', () => {
    const m = saved(open().save({ title: 'Tomorrow', body: 'ask\r\nmerge', base: null }))
    expect(m.id).toMatch(/^n-[0-9a-f]{32}$/)
    expect(readdirSync(dir)).toEqual([`${m.id}.json`])
    const again = open()
    expect(again.list()).toEqual([m])
    expect(again.get(m.id)?.body).toBe('ask\nmerge')
  })

  it('an empty folder, or none, is an empty list', () => {
    expect(open().list()).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it('a save against an older version writes nothing; force writes', () => {
    const s = open()
    const a = saved(s.save({ title: 't', body: 'one', base: null }))
    const b = saved(s.save({ id: a.id, title: 't', body: 'two', base: a.updated }))
    const r = s.save({ id: a.id, title: 't', body: 'stale', base: a.updated })
    expect(r).toMatchObject({ ok: false, conflict: true, note: { body: 'two', updated: b.updated } })
    expect(s.get(a.id)?.body).toBe('two')
    expect(saved(s.save({ id: a.id, title: 't', body: 'mine', base: a.updated, force: true })).preview).toBe('mine')
  })

  it('updated grows even when the clock does not', () => {
    const s = open()
    const a = saved(s.save({ title: 't', body: '1', base: null }))
    const b = saved(s.save({ id: a.id, title: 't', body: '2', base: a.updated }))
    clock = 5
    const c = saved(s.save({ id: a.id, title: 't', body: '3', base: b.updated }))
    expect(b.updated).toBe(a.updated + 1)
    expect(c.updated).toBe(b.updated + 1)
    expect(c.created).toBe(a.created)
  })

  it('a note deleted meanwhile is a conflict with no note', () => {
    const s = open()
    const a = saved(s.save({ title: 't', body: '1', base: null }))
    s.delete(a.id)
    expect(s.save({ id: a.id, title: 't', body: '2', base: a.updated })).toEqual({ ok: false, conflict: true, note: null })
    expect(saved(s.save({ id: a.id, title: 't', body: '2', base: a.updated, force: true })).id).toBe(a.id)
  })

  it('one note per ticket, keyed by the full repository; its title is dropped', () => {
    const s = open()
    const a = saved(s.save({ title: 'x', body: 'waiting for CI', base: null, ticket: { repo: null, number: 63 } }))
    expect(a).toMatchObject({ id: 't-acme~web~63', title: '', ticket: { repo: 'acme/web', number: 63 } })
    // The same ticket named in full is the same note: a second "new" save is a conflict.
    expect(s.save({ title: '', body: 'again', base: null, ticket: { repo: 'Acme/Web', number: 63 } })).toMatchObject({ conflict: true })
    expect(s.list()).toHaveLength(1)
  })

  it('a ticket note saved empty is removed', () => {
    const s = open()
    const a = saved(s.save({ title: '', body: 'x', base: null, ticket: { repo: 'acme/web', number: 63 } }))
    changes = []
    expect(s.save({ id: a.id, title: '', body: '  \n', base: a.updated, ticket: { repo: 'acme/web', number: 63 } })).toEqual({ ok: true, deleted: true, id: a.id })
    expect(readdirSync(dir)).toEqual([])
    expect(changes).toEqual([{ id: a.id, deleted: true }])
    // Emptying a ticket note that was never saved writes nothing either.
    expect(s.save({ title: '', body: '', base: null, ticket: { repo: 'acme/web', number: 64 } })).toEqual({ ok: true, deleted: true, id: 't-acme~web~64' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a ticket note when no repository is known', () => {
    const s = new NotesStore(dir, { repoOf: () => '' })
    expect(s.save({ title: '', body: 'x', base: null, ticket: { repo: null, number: 63 } })).toEqual({ ok: false, message: 'This ticket has no repository yet. Finish Setup first.' })
    expect(existsSync(dir)).toBe(false)
  })

  it('an empty global note is kept', () => {
    expect(saved(open().save({ title: '', body: '', base: null })).preview).toBe('')
  })

  it('files MasterDeck did not write are skipped and left alone', () => {
    const good = saved(open().save({ title: 'ok', body: 'ok', base: null }))
    const strays: Record<string, string> = {
      'readme.txt': 'hello',
      'n-zz.json': '{}',
      ['n-' + '1'.repeat(32) + '.json']: '{ not json',
      ['n-' + '2'.repeat(32) + '.json']: JSON.stringify({ ...open().get(good.id), id: good.id }),
      ['n-' + '3'.repeat(32) + '.json.123.tmp']: 'half',
    }
    for (const [f, text] of Object.entries(strays)) writeFileSync(join(dir, f), text)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mkdirSync(join(dir, 'n-' + '4'.repeat(32) + '.json'))
    expect(open().list()).toEqual([good])
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
    for (const [f, text] of Object.entries(strays)) expect(readFileSync(join(dir, f), 'utf8')).toBe(text)
  })

  it('refuses bad input and ids that are not ids, and never throws', () => {
    const s = open()
    expect(s.save(null)).toMatchObject({ ok: false })
    expect(s.save({ id: '../../x', title: '', body: '', base: null })).toMatchObject({ ok: false })
    expect(s.get('../../x')).toBeNull()
    expect(s.get(42)).toBeNull()
    expect(s.delete('../../x')).toEqual({ ok: false, message: 'Not a note.' })
    expect(s.search(42)).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it('delete removes the file; deleting again is fine', () => {
    const s = open()
    const a = saved(s.save({ title: 't', body: 'b', base: null }))
    changes = []
    expect(s.delete(a.id)).toEqual({ ok: true })
    expect(s.delete(a.id)).toEqual({ ok: true })
    expect(readdirSync(dir)).toEqual([])
    expect(changes).toEqual([{ id: a.id, deleted: true }])
  })

  it('tells every write to onChange', () => {
    const s = open()
    const a = saved(s.save({ title: 't', body: 'b', base: null }))
    expect(changes).toEqual([{ id: a.id, meta: a }])
  })

  it('a skipped file with a note name is never overwritten or deleted', () => {
    const id = 't-acme~web~63'
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), '{ hand edited')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = open()
    const msg = `The file ${id}.json in the notes folder is not a note MasterDeck can read. Move it away, then try again.`
    const input = { title: '', body: 'x', base: null, ticket: { repo: 'acme/web', number: 63 } }
    expect(s.save(input)).toEqual({ ok: false, message: msg })
    expect(s.save({ ...input, force: true })).toEqual({ ok: false, message: msg })
    expect(s.delete(id)).toEqual({ ok: false, message: msg })
    err.mockRestore()
    expect(readFileSync(join(dir, `${id}.json`), 'utf8')).toBe('{ hand edited')
    expect(readdirSync(dir)).toEqual([`${id}.json`])
  })

  it('a skipped file moved away frees its id', () => {
    const id = 't-acme~web~63'
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), 'junk')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = open()
    err.mockRestore()
    const input = { title: '', body: 'x', base: null, ticket: { repo: 'acme/web', number: 63 } }
    expect(s.save(input)).toMatchObject({ ok: false })
    rmSync(join(dir, `${id}.json`))
    expect(s.delete(id)).toEqual({ ok: true })
    expect(saved(s.save(input)).id).toBe(id)
    expect(s.get(id)?.body).toBe('x')
  })

  it('a throwing onChange does not fail a done save or delete', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = new NotesStore(dir, { onChange: () => { throw new Error('boom') }, now: () => clock })
    const m = saved(s.save({ title: 't', body: 'b', base: null }))
    expect(s.get(m.id)?.body).toBe('b')
    expect(s.delete(m.id)).toEqual({ ok: true })
    expect(s.get(m.id)).toBeNull()
    expect(err).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })

  it('a failed rename leaves no temp file', () => {
    const s = open()
    const id = 't-acme~web~63'
    mkdirSync(join(dir, `${id}.json`), { recursive: true }) // a directory made after load, so rename onto it fails
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = s.save({ title: '', body: 'x', base: null, ticket: { repo: 'acme/web', number: 63 } })
    log.mockRestore()
    expect(r).toMatchObject({ ok: false })
    expect(readdirSync(dir)).toEqual([`${id}.json`])
  })

  it('a failed write is marked as worth another try, and its answer names no path', () => {
    const s = open()
    const id = 't-acme~web~63'
    mkdirSync(join(dir, `${id}.json`), { recursive: true })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = s.save({ title: '', body: 'x', base: null, ticket: { repo: 'acme/web', number: 63 } })
    // The whole error, path included, is for the log of this process only.
    expect(log).toHaveBeenCalledOnce()
    expect(String(log.mock.calls[0][1])).toContain(dir)
    log.mockRestore()
    expect(r).toMatchObject({ ok: false, retry: true })
    const message = (r as { message: string }).message
    expect(message).toMatch(/^Could not save the note \([A-Z0-9_]+\)\.$/)
    expect(message).not.toContain(dir)
    expect(JSON.stringify(r)).not.toContain(tmpdir())
  })

  it('a failed delete is marked the same way; the note stays', () => {
    const s = open()
    const m = saved(s.save({ title: 'a', body: 'x', base: null }))
    const file = join(dir, `${m.id}.json`)
    rmSync(file)
    mkdirSync(file) // a directory in the file's place: removing it as a file fails
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = s.delete(m.id)
    expect(log).toHaveBeenCalledOnce()
    log.mockRestore()
    expect(r).toMatchObject({ ok: false, retry: true })
    expect(r.message).toMatch(/^Could not delete the note( \([A-Z0-9_]+\))?\.$/)
    expect(r.message).not.toContain(dir)
    expect(s.get(m.id)?.body).toBe('x')
  })

  it('a refusal about the note itself is not marked for another try', () => {
    const s = open()
    expect(s.save({ title: 'a', body: 'x\x1b[31m', base: null })).toEqual({ ok: false, message: 'The note has characters that cannot be saved.' })
    expect(s.save({ title: '', body: 'x', base: null, ticket: { repo: null, number: 1 } })).not.toHaveProperty('retry')
  })

  it('search answers ids, newest first', () => {
    const s = open()
    const a = saved(s.save({ title: 'Review', body: 'ask Dana', base: null }))
    clock = 2000
    const b = saved(s.save({ title: 'List', body: 'review the plan', base: null }))
    saved(s.save({ title: 'Other', body: 'nothing', base: null }))
    expect(s.search('review')).toEqual([b.id, a.id])
    expect(s.search('x'.repeat(201))).toEqual([])
  })

  it('stops at the cap, and existing notes can still be edited', () => {
    const s = open()
    let first = saved(s.save({ title: '0', body: '', base: null }))
    for (let i = 1; i < NOTES_MAX; i++) s.save({ title: String(i), body: '', base: null })
    expect(s.save({ title: 'one more', body: '', base: null })).toEqual({ ok: false, message: `${NOTES_MAX} notes is the limit. Delete some first.` })
    first = saved(s.save({ id: first.id, title: 'edited', body: '', base: first.updated }))
    expect(first.title).toBe('edited')
  }, 20_000)
})

describe('links and meetings', () => {
  const M = { id: 'm-' + 'a'.repeat(32), title: 'Standup', at: 1_700_000_000_000 }
  const LINK = { session: { key: 'bg:1a2b3c4d', name: 'Fix login' }, ticket: { repo: 'acme/web', number: 7 } }
  const file = (id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))

  it('a note file from before links and meetings still loads, and a save keeps it without them', () => {
    const id = 'n-' + '0'.repeat(32)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, title: 'Old', body: 'x', ticket: null, created: 1, updated: 2 }))
    const s = open()
    expect(s.get(id)?.body).toBe('x')
    saved(s.save({ id, title: 'Old', body: 'y', base: 2 }))
    expect(Object.keys(file(id)).sort()).toEqual(['body', 'created', 'id', 'ticket', 'title', 'updated'])
  })

  it('a new note takes its link, named in full; it survives a restart and later saves', () => {
    const s = open()
    const m = saved(s.save({ title: 'About it', body: 'b', base: null, link: { session: LINK.session, ticket: { repo: null, number: 7 } } }))
    expect(m.link).toEqual(LINK)
    const again = open()
    expect(again.get(m.id)?.link).toEqual(LINK)
    // An editor cannot move a stored note's link (nor drop it).
    const b = saved(again.save({ id: m.id, title: 'About it', body: 'c', base: m.updated, link: { session: { key: 'other', name: 'x' } } }))
    expect(b.link).toEqual(LINK)
    expect(saved(again.save({ id: m.id, title: 'About it', body: 'd', base: b.updated, link: null })).link).toEqual(LINK)
  })

  it('a link on a ticket note is refused', () => {
    const s = open()
    expect(s.save({ title: '', body: 'x', base: null, ticket: { repo: 'acme/web', number: 63 }, link: LINK })).toEqual({ ok: false, message: 'Not a note.' })
    expect(s.list()).toEqual([])
  })

  it('an editor cannot set a meeting; a save keeps the one a note has', () => {
    const s = open()
    const m = saved(s.save({ title: 't', body: 'b', base: null, meeting: M } as never))
    expect(m.meeting).toBeUndefined()
    const n = s.addMeetingNote({ title: 'From standup', body: 'said', link: LINK, meeting: M })
    const meta = saved(n)
    expect(meta).toMatchObject({ title: 'From standup', ticket: null, link: LINK, meeting: M })
    expect(meta.created).toBe(meta.updated)
    const edited = saved(s.save({ id: meta.id, title: 'From standup', body: 'said more', base: meta.updated }))
    expect(edited.meeting).toEqual(M)
    expect(open().get(meta.id)?.meeting).toEqual(M)
  })

  it('addMeetingNote cuts a long body at a line break, and checks the rest', () => {
    const s = open()
    const line = 'x'.repeat(99) + '\n'
    const m = saved(s.addMeetingNote({ title: 't', body: line.repeat(1000), link: LINK, meeting: M }))
    const body = s.get(m.id)!.body
    expect(body.length).toBeLessThanOrEqual(50_000)
    expect(body.endsWith('x')).toBe(true)
    expect(s.addMeetingNote({ title: 't', body: 'b', link: LINK, meeting: { ...M, id: '../m' } })).toEqual({ ok: false, message: 'Not a meeting.' })
    expect(s.addMeetingNote({ title: 't', body: 'b', link: {}, meeting: M })).toMatchObject({ ok: false })
    expect(s.addMeetingNote({ title: 't', body: 'b\x1b[31m', link: LINK, meeting: M })).toMatchObject({ ok: false })
    expect(s.addMeetingNote({ title: 't', body: 'b', link: { session: { key: '/etc', name: 'x' } }, meeting: M })).toMatchObject({ ok: false })
  })

  it('meetingNotes lists a meeting\'s notes; dropMeetingNotes leaves the edited ones when asked', () => {
    const s = open()
    const other = { ...M, id: 'm-' + 'b'.repeat(32) }
    const a = saved(s.addMeetingNote({ title: 'a', body: 'a', link: LINK, meeting: M }))
    clock = 2000
    const b = saved(s.addMeetingNote({ title: 'b', body: 'b', link: { ticket: LINK.ticket }, meeting: M }))
    const c = saved(s.addMeetingNote({ title: 'c', body: 'c', link: LINK, meeting: other }))
    const plain = saved(s.save({ title: 'mine', body: 'x', base: null }))
    expect(s.meetingNotes(M.id).map((m) => m.id)).toEqual([b.id, a.id])
    clock = 3000
    saved(s.save({ id: a.id, title: 'a', body: 'a, edited', base: a.updated }))
    expect(s.dropMeetingNotes(M.id, true)).toEqual({ removed: [b.id], failed: [] })
    expect(s.meetingNotes(M.id).map((m) => m.id)).toEqual([a.id])
    expect(s.dropMeetingNotes(M.id, false)).toEqual({ removed: [a.id], failed: [] })
    expect(s.list().map((m) => m.id).sort()).toEqual([c.id, plain.id].sort())
    expect(readdirSync(dir).sort()).toEqual([`${c.id}.json`, `${plain.id}.json`].sort())
  })
})
