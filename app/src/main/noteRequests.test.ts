import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NotesStore } from './notes'
import { answerNoteRequest, pumpNoteRequests } from './noteRequests'
import { NOTE_BODY_MAX, type NoteChange } from '@shared/notes'

let root: string
let deck: string
let changes: NoteChange[]
let store: NotesStore
const open = () => new NotesStore(join(root, 'notes'), { onChange: (c) => changes.push(c), repoOf: (r) => r ?? 'acme/web' })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'md-notereq-'))
  deck = join(root, 'deck')
  mkdirSync(deck)
  changes = []
  store = open()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('answerNoteRequest', () => {
  it('new makes a global note and answers its id, never its text', () => {
    const a = answerNoteRequest(store, { op: 'new', arg: 'Plan', body: '# Steps\n- [ ] one' })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.id).toMatch(/^n-/)
    expect(JSON.stringify(a)).not.toContain('Steps')
    expect(store.get(a.id)).toMatchObject({ title: 'Plan', body: '# Steps\n- [ ] one', ticket: null })
  })
  it('several new requests are several notes', () => {
    answerNoteRequest(store, { op: 'new', arg: 'A', body: 'a' })
    answerNoteRequest(store, { op: 'new', arg: 'B', body: 'b' })
    expect(store.list().map((m) => m.title).sort()).toEqual(['A', 'B'])
  })
  it("ticket makes the ticket's note, then adds under the user's text", () => {
    expect(answerNoteRequest(store, { op: 'ticket', arg: '#12', body: 'first' })).toMatchObject({ ok: true, id: 't-acme~web~12' })
    store.save({ id: 't-acme~web~12', title: '', body: 'first\n\nmine', base: store.get('t-acme~web~12')!.updated })
    const a = answerNoteRequest(store, { op: 'ticket', arg: 'acme/web#12', body: 'second' })
    expect(a).toMatchObject({ ok: true, message: 'Added to the note of acme/web#12.' })
    expect(store.get('t-acme~web~12')!.body).toBe('first\n\nmine\n\nsecond')
  })
  it('append adds to a global note made before; an unknown id is refused', () => {
    const a = answerNoteRequest(store, { op: 'new', arg: 'Log', body: 'one' })
    if (!a.ok) throw new Error(a.error)
    expect(answerNoteRequest(store, { op: 'append', arg: a.id, body: 'two' })).toMatchObject({ ok: true, id: a.id })
    expect(store.get(a.id)).toMatchObject({ title: 'Log', body: 'one\n\ntwo' })
    expect(answerNoteRequest(store, { op: 'append', arg: 'n-' + 'b'.repeat(32), body: 'x' })).toMatchObject({ ok: false, error: /No note/ })
  })
  it('a note that would pass the limit is left as it was', () => {
    const a = answerNoteRequest(store, { op: 'new', arg: 'Big', body: 'x'.repeat(NOTE_BODY_MAX - 10) })
    if (!a.ok) throw new Error(a.error)
    const before = store.get(a.id)!.updated
    expect(answerNoteRequest(store, { op: 'append', arg: a.id, body: 'y'.repeat(20) })).toMatchObject({ ok: false, error: /50,000/ })
    expect(store.get(a.id)!.updated).toBe(before)
  })
  it('every write is a change event, so the window and web tabs see it', () => {
    answerNoteRequest(store, { op: 'new', arg: 'A', body: 'a' })
    expect(changes).toHaveLength(1)
  })
})

describe('pumpNoteRequests', () => {
  const put = (id: string, o: unknown) => {
    mkdirSync(join(deck, 'note-requests'), { recursive: true })
    writeFileSync(join(deck, 'note-requests', `${id}.json`), typeof o === 'string' ? o : JSON.stringify(o))
  }
  const answer = (id: string) => JSON.parse(readFileSync(join(deck, 'note-answers', `${id}.json`), 'utf8'))

  it('answers each request and leaves nothing behind in requests', () => {
    put('1-2-3', { op: 'new', arg: 'T', body: 'b' })
    put('1-2-4', 'not json')
    expect(pumpNoteRequests(deck, store)).toBe(2)
    expect(answer('1-2-3')).toMatchObject({ ok: true })
    expect(answer('1-2-4')).toEqual({ ok: false, error: 'Not a note request.' })
    expect(readdirSync(join(deck, 'note-requests'))).toEqual([])
  })
  it('skips names that are not requests, and a request the script took back', () => {
    put('../../x', { op: 'new', arg: 'T', body: 'b' })
    put('weird', { op: 'new', arg: 'T', body: 'b' })
    expect(pumpNoteRequests(deck, store)).toBe(0)
    expect(store.list()).toEqual([])
  })
  it('a request file over the size limit is refused unread', () => {
    put('1-1-1', { op: 'new', arg: 'T', body: 'x'.repeat(300 * 1024) })
    pumpNoteRequests(deck, store)
    expect(answer('1-1-1')).toMatchObject({ ok: false, error: /too long/ })
  })
  it('old answers and leftovers are swept', () => {
    mkdirSync(join(deck, 'note-answers'), { recursive: true })
    mkdirSync(join(deck, 'note-requests'), { recursive: true })
    const old = join(deck, 'note-answers', '9-9-9.json')
    const body = join(deck, 'note-requests', '9-9-9.body')
    writeFileSync(old, '{}')
    writeFileSync(body, 'x')
    const t = new Date(Date.now() - 120_000)
    utimesSync(old, t, t)
    utimesSync(body, t, t)
    pumpNoteRequests(deck, store)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(body)).toBe(false)
  })
})

// The skill's script against this pump: a request, its answer, and what the script prints.
describe('note.sh', () => {
  const script = resolve(__dirname, '../../../skills/masterdeck-notes/scripts/note.sh')
  const run = (args: string[], input: string, pump = true) =>
    new Promise<{ code: number | null; out: string; err: string }>((done) => {
      const p = spawn('bash', [script, ...args], { env: { ...process.env, MASTERDECK_HOME: root } })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (err += d))
      const t = pump ? setInterval(() => pumpNoteRequests(deck, store), 100) : null
      p.on('close', (code) => {
        if (t) clearInterval(t)
        done({ code, out, err })
      })
      p.stdin.end(input)
    })
  const alive = () => writeFileSync(join(deck, 'alive'), '')

  it('saves a new note and prints its id', async () => {
    alive()
    const r = await run(['new', 'From a session'], "# Done\n- [x] it's $HOME `x`\n")
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const id = /id (n-[0-9a-f]{32})/.exec(r.out)![1]
    expect(store.get(id)!.body).toBe("# Done\n- [x] it's $HOME `x`")
    expect(readdirSync(join(deck, 'note-requests'))).toEqual([])
  }, 20_000)
  it('adds to a ticket note, and says why when refused', async () => {
    alive()
    expect((await run(['ticket', 'acme/api#3'], 'hello')).code).toBe(0)
    expect(store.get('t-acme~api~3')!.body).toBe('hello')
    const bad = await run(['ticket', 'nope'], 'x')
    expect(bad.code).toBe(1)
    expect(bad.err).toMatch(/^note: Name the ticket/)
  }, 20_000)
  it('saves nothing when MasterDeck is not running', async () => {
    const r = await run(['new', 'T'], 'x', false)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/not running/)
    expect(existsSync(join(deck, 'note-requests'))).toBe(false)
  }, 20_000)
  it('usage without a command', async () => {
    expect((await run(['read', 'x'], '', false)).code).toBe(2)
  }, 20_000)
})
