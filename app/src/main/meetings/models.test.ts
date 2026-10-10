import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny stand-in for the real models: the store checks whatever MODELS says.
const fake = vi.hoisted(() => {
  const body = new Uint8Array(1000).map((_, i) => i % 251)
  return { body }
})
vi.mock('@shared/meetingModels', async (orig) => {
  const real = await orig<typeof import('@shared/meetingModels')>()
  const { createHash: h } = await import('node:crypto')
  const sha = h('sha256').update(fake.body).digest('hex')
  const MODELS = [
    { id: 'base', label: 'Fast', hint: '', file: 'ggml-base.bin', bytes: fake.body.byteLength, sha256: sha, url: 'https://models.test/ggml-base.bin' },
    { id: 'other', label: 'Best', hint: '', file: 'ggml-other.bin', bytes: 5, sha256: '0'.repeat(64), url: 'https://models.test/ggml-other.bin' },
  ]
  return { ...real, MODELS, modelById: (id: unknown) => MODELS.find((m) => m.id === id) ?? null }
})

import { ModelStore } from './models'

/** A response that streams `data` in pieces; `gate` holds it after the first piece until released. */
function streamed(data: Uint8Array, opts: { pieces?: number; hold?: Promise<void>; signal?: AbortSignal } = {}): Response {
  const n = opts.pieces ?? 4
  const size = Math.ceil(data.byteLength / n)
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i > 0 && opts.hold) await opts.hold
      if (opts.signal?.aborted) return c.error(new DOMException('aborted', 'AbortError'))
      if (i * size >= data.byteLength) return c.close()
      c.enqueue(data.slice(i * size, (i + 1) * size))
      i++
    },
  })
  return new Response(stream, { status: 200 })
}

let dir: string
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'md-models-')), 'meetings', 'models')
})
afterEach(() => rmSync(join(dir, '..', '..'), { recursive: true, force: true }))

describe('ModelStore', () => {
  it('downloads to .part, checks size and SHA-256, renames, and reports progress', async () => {
    const urls: string[] = []
    let t = 0
    const store = new ModelStore(dir, {
      fetch: async (url) => (urls.push(url), streamed(fake.body)),
      now: () => (t += 300),
      freeBytes: () => null,
    })
    expect(store.status().models).toEqual([
      { id: 'base', ready: false },
      { id: 'other', ready: false },
    ])
    const seen: string[] = []
    expect(await store.download('base', (p) => seen.push(`${p.state}:${p.received}`))).toEqual({ ok: true })
    expect(urls).toEqual(['https://models.test/ggml-base.bin'])
    expect(readFileSync(join(dir, 'ggml-base.bin'))).toEqual(Buffer.from(fake.body))
    expect(readdirSync(dir)).toEqual(['ggml-base.bin'])
    expect(store.ready('base')).toBe(true)
    expect(store.path('base')).toBe(join(dir, 'ggml-base.bin'))
    expect(seen.at(-1)).toBe('done:1000')
    expect(seen.filter((s) => s.startsWith('downloading')).length).toBeGreaterThan(0)
    expect(store.status().downloading).toBeNull()
  })

  it('a wrong hash, a short or a long download is thrown away', async () => {
    const wrong = new Uint8Array(fake.body).fill(7)
    for (const [data, msg] of [
      [wrong, /not the expected file/],
      [fake.body.slice(0, 600), /before the end/],
      [new Uint8Array(1500), /larger than the model/],
    ] as const) {
      const store = new ModelStore(dir, { fetch: async () => streamed(data), freeBytes: () => null })
      const states: string[] = []
      const r = await store.download('base', (p) => states.push(p.state))
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(msg) })
      expect(states.at(-1)).toBe('failed')
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
      expect(store.ready('base')).toBe(false)
    }
  })

  it('a server error, a network error and a full disk', async () => {
    const s1 = new ModelStore(dir, { fetch: async () => new Response('no', { status: 404 }), freeBytes: () => null })
    expect(await s1.download('base')).toMatchObject({ ok: false, message: 'The model server answered 404.' })
    const s2 = new ModelStore(dir, {
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      freeBytes: () => null,
    })
    expect(await s2.download('base')).toMatchObject({ ok: false, message: expect.stringMatching(/Could not reach/) })
    const fetcher = vi.fn()
    const s3 = new ModelStore(dir, { fetch: fetcher, freeBytes: () => 10 })
    expect(await s3.download('base')).toMatchObject({ ok: false, message: expect.stringMatching(/disk space/) })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('one at a time, and cancel removes the .part', async () => {
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const store = new ModelStore(dir, {
      fetch: async (_u, init) => streamed(fake.body, { hold, signal: init.signal }),
      freeBytes: () => null,
    })
    const first = store.download('base')
    expect(await store.download('other')).toEqual({ ok: false, message: 'A speech model is downloading already.' })
    await vi.waitFor(() => expect(existsSync(join(dir, 'ggml-base.bin.part'))).toBe(true))
    expect(store.status().downloading).toMatchObject({ id: 'base', state: 'downloading', total: 1000 })
    expect(store.remove('base')).toEqual({ ok: false, message: 'Cancel the download first.' })
    expect(store.cancel()).toBe(true)
    release()
    expect(await first).toMatchObject({ ok: false, cancelled: true })
    expect(readdirSync(dir)).toEqual([])
    expect(store.cancel()).toBe(false)
  })

  it('remove deletes the model and a leftover .part, and nothing else', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ggml-base.bin'), fake.body)
    writeFileSync(join(dir, 'ggml-base.bin.part'), 'x')
    writeFileSync(join(dir, 'notes.txt'), 'mine')
    const store = new ModelStore(dir)
    expect(store.ready('base')).toBe(true)
    expect(store.remove('base')).toEqual({ ok: true })
    expect(readdirSync(dir)).toEqual(['notes.txt'])
    expect(store.remove('base')).toEqual({ ok: true })
    expect(store.remove('../notes.txt')).toMatchObject({ ok: false })
    expect(store.path('../notes.txt')).toBeNull()
  })

  it('a file of the wrong size is not ready', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ggml-base.bin'), 'short')
    expect(new ModelStore(dir).ready('base')).toBe(false)
  })
})
