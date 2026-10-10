import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioId, parseRange, serveMeetingAudio } from './meetingMedia'

const ID = 'm-' + 'c0'.repeat(16)
const URL = `masterdeck-media://meeting/${ID}/audio`
const req = (url: string, range?: string, method = 'GET') => ({ url, method, headers: new Headers(range ? { range } : {}) })

describe('audioId', () => {
  it('only masterdeck-media://meeting/<id>/audio names a meeting', () => {
    expect(audioId(URL)).toBe(ID)
    for (const bad of [
      `masterdeck-media://meeting/${ID}/audio?x=1`,
      `masterdeck-media://meeting/${ID}/audio/`,
      `masterdeck-media://meeting/${ID}/chunks/you-0.wav`,
      `masterdeck-media://meeting/${ID}.json`,
      `masterdeck-media://meeting/../notes/audio`,
      `masterdeck-media://meeting/m-${'C0'.repeat(16)}/audio`,
      `masterdeck-media://other/${ID}/audio`,
      `file:///${ID}/audio`,
      `masterdeck-media://meeting/%2e%2e/audio`,
    ])
      expect(audioId(bad), bad).toBeNull()
  })
})

describe('parseRange', () => {
  it('reads a start, a start and end, and a suffix; clamps the end', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })
  it('a range past the end or reversed cannot be met; several ranges get the whole file', () => {
    expect(parseRange('bytes=100-', 100)).toBe('bad')
    expect(parseRange('bytes=20-10', 100)).toBe('bad')
    expect(parseRange('bytes=-0', 100)).toBe('bad')
    expect(parseRange('bytes=-', 100)).toBe('bad')
    expect(parseRange('bytes=0-', 0)).toBe('bad')
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
  })
})

describe('serveMeetingAudio', () => {
  let dir: string
  let file: string
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i))
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'md-media-'))
    mkdirSync(join(dir, ID))
    file = join(dir, ID, 'audio.webm')
    writeFileSync(file, bytes)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const asked: string[] = []
  const store = async (id: string) => (asked.push(id), id === ID ? file : null)

  it('the whole file: 200 with its length and Accept-Ranges', async () => {
    const r = await serveMeetingAudio(req(URL), store)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('audio/webm')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect(r.headers.get('content-length')).toBe('100')
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes)
  })

  it('a range: 206 with Content-Range and just those bytes', async () => {
    const r = await serveMeetingAudio(req(URL, 'bytes=10-19'), store)
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(r.headers.get('content-length')).toBe('10')
    expect([...Buffer.from(await r.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    const tail = await serveMeetingAudio(req(URL, 'bytes=95-'), store)
    expect(tail.headers.get('content-range')).toBe('bytes 95-99/100')
    expect([...Buffer.from(await tail.arrayBuffer())]).toEqual([95, 96, 97, 98, 99])
  })

  it('a range that cannot be met: 416 with the size', async () => {
    const r = await serveMeetingAudio(req(URL, 'bytes=100-'), store)
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */100')
  })

  it('HEAD: the headers only', async () => {
    const r = await serveMeetingAudio(req(URL, undefined, 'HEAD'), store)
    expect(r.status).toBe(200)
    expect(r.body).toBeNull()
    expect((await serveMeetingAudio(req(URL, undefined, 'POST'), store)).status).toBe(405)
  })

  // Symlinks need extra rights on Windows: POSIX only.
  it.skipIf(process.platform === 'win32')('404 for any other URL (the store is never asked), a meeting the store does not hold, or no regular file', async () => {
    asked.length = 0
    expect((await serveMeetingAudio(req(`masterdeck-media://meeting/${ID}.json`), store)).status).toBe(404)
    expect((await serveMeetingAudio(req('masterdeck-media://meeting/../../etc/passwd'), store)).status).toBe(404)
    expect(asked).toEqual([])
    expect((await serveMeetingAudio(req(`masterdeck-media://meeting/m-${'d1'.repeat(16)}/audio`), store)).status).toBe(404)
    rmSync(file)
    expect((await serveMeetingAudio(req(URL), store)).status).toBe(404)
    // A link where the audio was: not served.
    writeFileSync(join(dir, 'elsewhere'), 'secret')
    symlinkSync(join(dir, 'elsewhere'), file)
    expect((await serveMeetingAudio(req(URL), store)).status).toBe(404)
  })

  it.skipIf(process.platform === 'win32')('reads from the descriptor it checked: a file swapped for a link afterwards changes nothing; a folder is 404', async () => {
    const r = await serveMeetingAudio(req(URL, 'bytes=0-4'), store)
    rmSync(file)
    writeFileSync(join(dir, 'elsewhere'), 'secret')
    symlinkSync(join(dir, 'elsewhere'), file)
    expect([...Buffer.from(await r.arrayBuffer())]).toEqual([0, 1, 2, 3, 4])
    rmSync(file)
    mkdirSync(file)
    expect((await serveMeetingAudio(req(URL), store)).status).toBe(404)
  })
})
