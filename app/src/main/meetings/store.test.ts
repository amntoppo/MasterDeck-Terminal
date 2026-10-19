import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUDIO_MAX_BYTES } from '@shared/meetings'
import { MeetingStore } from './store'

let dir: string
let store: MeetingStore
let clock = 1000
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'md-meetings-'))
  clock = 1000
  store = new MeetingStore(dir, () => clock)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (title = '') => {
  const r = store.create({ title, titleBy: title ? 'user' : null, model: 'base', language: 'auto' })
  if (!r.ok) throw new Error(r.message)
  return r.meeting
}
const FOREIGN = 'm-' + 'f'.repeat(32)

describe('MeetingStore', () => {
  it('create writes <id>.json and the chunks folder; no temp file stays', () => {
    const m = make('Standup')
    expect(m.id).toMatch(/^m-[0-9a-f]{32}$/)
    expect(m).toMatchObject({ state: 'recording', started: 1000, ended: null, title: 'Standup', titleBy: 'user' })
    expect(store.get(m.id)).toEqual(m)
    expect(existsSync(join(dir, m.id, 'chunks'))).toBe(true)
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('update is atomic, keeps the id, and refuses what would not be a meeting', () => {
    const m = make()
    const r = store.update(m.id, (x) => ({ ...x, id: 'm-' + '0'.repeat(32), state: 'transcribing', ended: 2000 }))
    expect(r.ok && r.meeting).toMatchObject({ id: m.id, state: 'transcribing', ended: 2000 })
    expect(JSON.parse(readFileSync(join(dir, `${m.id}.json`), 'utf8')).state).toBe('transcribing')
    const before = readFileSync(join(dir, `${m.id}.json`), 'utf8')
    expect(store.update(m.id, (x) => ({ ...x, state: 'nope' as never })).ok).toBe(false)
    expect(readFileSync(join(dir, `${m.id}.json`), 'utf8')).toBe(before)
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('onEnded: once, when the recording ends; a throw breaks nothing', () => {
    const ended: string[] = []
    const st = new MeetingStore(dir, () => clock, (m) => {
      ended.push(`${m.id}:${m.ended}`)
      throw new Error('boom')
    })
    const r = st.create({ title: 'Standup', titleBy: 'user', model: 'base', language: 'auto' })
    if (!r.ok) throw new Error(r.message)
    const id = r.meeting.id
    expect(st.update(id, (x) => ({ ...x, pausedMs: 5 })).ok).toBe(true)
    expect(ended).toEqual([])
    const u = st.update(id, (x) => ({ ...x, state: 'transcribing', ended: 2000 }))
    expect(u.ok && u.meeting.ended).toBe(2000)
    expect(st.update(id, (x) => ({ ...x, state: 'done', ended: 2500 })).ok).toBe(true)
    expect(ended).toEqual([`${id}:2000`])
  })

  it('foreign files are skipped and never overwritten or removed', () => {
    const m = make()
    writeFileSync(join(dir, `${FOREIGN}.json`), '{"mine": true}')
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    writeFileSync(join(dir, m.id, 'keep.txt'), 'mine')
    expect(store.list().map((x) => x.id)).toEqual([m.id])
    expect(store.get(FOREIGN)).toBeNull()
    expect(store.update(FOREIGN, (x) => x).ok).toBe(false)
    expect(store.delete(FOREIGN).ok).toBe(false)
    expect(store.writeChunk(FOREIGN, 'you', 0, new Uint8Array(4)).ok).toBe(false)
    expect(store.appendAudio(FOREIGN, new Uint8Array(4)).ok).toBe(false)
    expect(readFileSync(join(dir, `${FOREIGN}.json`), 'utf8')).toBe('{"mine": true}')
    // Deleting the meeting leaves the file it does not know, and so its folder.
    store.appendAudio(m.id, new Uint8Array([1, 2]))
    expect(store.delete(m.id)).toEqual({ ok: true })
    expect(existsSync(join(dir, `${m.id}.json`))).toBe(false)
    expect(existsSync(join(dir, m.id, 'audio.webm'))).toBe(false)
    expect(readFileSync(join(dir, m.id, 'keep.txt'), 'utf8')).toBe('mine')
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })

  it('bad ids, tracks and sequence numbers are refused before any path is made', () => {
    for (const id of ['../x', 'm-ABC', `m-${'a'.repeat(32)}/../..`, 5, null]) {
      expect(store.get(id)).toBeNull()
      expect(store.chunkPath(id, 'you', 0)).toBeNull()
      expect(store.audioPath(id)).toBeNull()
      expect(store.delete(id).ok).toBe(false)
      expect(store.deleteAudio(id).ok).toBe(false)
    }
    const m = make()
    expect(store.chunkPath(m.id, 'them', 0)).toBeNull()
    expect(store.chunkPath(m.id, 'you', -1)).toBeNull()
    expect(store.chunkPath(m.id, 'you', 1.5)).toBeNull()
    expect(store.chunkPath(m.id, 'you', 100000)).toBeNull()
    expect(store.chunkPath(m.id, 'others', 3)).toBe(join(dir, m.id, 'chunks', 'others-3.wav'))
  })

  it('chunks are written once; leftovers after a crash come back in order', () => {
    const a = make()
    clock = 2000
    const b = make()
    for (const [id, track, seq] of [[b.id, 'others', 0], [a.id, 'others', 1], [a.id, 'you', 1], [a.id, 'you', 0]] as const)
      expect(store.writeChunk(id, track, seq, new Uint8Array([seq]))).toEqual({ ok: true })
    expect(store.writeChunk(a.id, 'you', 0, new Uint8Array([9])).ok).toBe(false)
    // A temp file from a crash mid-write and a foreign file are not leftovers.
    writeFileSync(join(dir, a.id, 'chunks', 'you-2.wav.123.tmp'), 'x')
    writeFileSync(join(dir, a.id, 'chunks', 'other.wav'), 'x')
    const left = new MeetingStore(dir).leftovers().map((l) => `${l.id === a.id ? 'a' : 'b'}:${l.track}-${l.seq}`)
    const ofA = ['a:you-0', 'a:you-1', 'a:others-1']
    expect(left).toEqual(a.id < b.id ? [...ofA, 'b:others-0'] : ['b:others-0', ...ofA])
    // One meeting's only; a bad id or no meeting file: none.
    expect(store.leftovers(b.id).map((l) => `${l.track}-${l.seq}`)).toEqual(['others-0'])
    expect(store.leftovers(a.id).map((l) => `${l.track}-${l.seq}`)).toEqual(['you-0', 'you-1', 'others-1'])
    expect(store.leftovers('../x')).toEqual([])
    expect(store.leftovers('m-' + '0'.repeat(32))).toEqual([])
    store.removeChunk(a.id, 'you', 0)
    expect(store.leftovers().some((l) => l.id === a.id && l.track === 'you' && l.seq === 0)).toBe(false)
  })

  it('audio is appended, capped, and deleteAudio keeps the transcript', () => {
    const m = make()
    store.appendAudio(m.id, new Uint8Array([1, 2]))
    store.appendAudio(m.id, new Uint8Array([3]))
    expect([...readFileSync(join(dir, m.id, 'audio.webm'))]).toEqual([1, 2, 3])
    expect(store.appendAudio(m.id, new Uint8Array(AUDIO_MAX_BYTES)).ok).toBe(false)
    expect(store.sizes()).toEqual([expect.objectContaining({ id: m.id, audio: 3, chunks: 0 })])
    expect(store.deleteAudio(m.id)).toEqual({ ok: true })
    expect(existsSync(join(dir, m.id, 'audio.webm'))).toBe(false)
    expect(store.get(m.id)).not.toBeNull()
  })

  it('list filters by start and sorts newest first', () => {
    const a = make()
    clock = 5000
    const b = make()
    expect(store.list().map((m) => m.id)).toEqual([b.id, a.id])
    expect(store.list(2000, 6000).map((m) => m.id)).toEqual([b.id])
  })

  it('a missing folder is an empty list', () => {
    expect(new MeetingStore(join(dir, 'none')).list()).toEqual([])
    expect(new MeetingStore(join(dir, 'none')).leftovers()).toEqual([])
  })

  it('a disk error is said without the path', () => {
    const m = make()
    mkdirSync(join(dir, m.id, 'chunks', 'you-0.wav'))
    const r = store.writeChunk(m.id, 'you', 0, new Uint8Array(1))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).not.toContain(dir)
  })
})
