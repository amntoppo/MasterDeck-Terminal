import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
    mkdirSync(join(dir, 'n-' + '4'.repeat(32) + '.json'))
    expect(open().list()).toEqual([good])
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
