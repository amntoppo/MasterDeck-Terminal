import { beforeAll, describe, expect, it } from 'vitest'

// The worklet runs in an AudioWorkletGlobalScope: stand in for its two globals, then load it.
type Posted = Float32Array | string
class FakePort {
  posted: Posted[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  postMessage(d: Posted) {
    this.posted.push(d instanceof Float32Array ? d.slice() : d)
  }
  send(data: unknown) {
    this.onmessage?.({ data })
  }
}
type Tap = { port: FakePort; process(inputs: Float32Array[][]): boolean }
let Ctor: new (o?: { processorOptions?: unknown }) => Tap

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>
  g.AudioWorkletProcessor = class {
    port = new FakePort()
  }
  g.registerProcessor = (name: string, c: typeof Ctor) => {
    if (name === 'md-pcm') Ctor = c
  }
  await import('./pcmWorklet')
})

const quantum = (v: number) => [[new Float32Array(128).fill(v)]]
const frames = (p: Posted[]) => p.filter((x): x is Float32Array => x instanceof Float32Array).reduce((n, b) => n + b.length, 0)

describe('pcmWorklet', () => {
  it('posts blocks of 2048 frames, and the rest on flush', () => {
    const t = new Ctor()
    for (let i = 0; i < 17; i++) t.process(quantum(0.5))
    expect(t.port.posted.map((x) => (typeof x === 'string' ? x : x.length))).toEqual([2048])
    t.port.send('flush')
    expect(t.port.posted.map((x) => (typeof x === 'string' ? x : x.length))).toEqual([2048, 128, 'flushed'])
  })

  it('pause posts what was buffered and drops the input until resume; a flush while paused adds nothing', () => {
    const t = new Ctor()
    t.process(quantum(0.1))
    t.port.send('pause')
    expect(frames(t.port.posted)).toBe(128)
    for (let i = 0; i < 40; i++) t.process(quantum(0.9))
    t.port.send('flush')
    expect(t.port.posted.at(-1)).toBe('flushed')
    expect(frames(t.port.posted)).toBe(128)
    t.port.send('resume')
    t.process(quantum(0.2))
    t.port.send('flush')
    expect(frames(t.port.posted)).toBe(256)
    // Nothing recorded while paused was ever posted.
    for (const b of t.port.posted) if (b instanceof Float32Array) expect(b.every((v) => Math.abs(v - 0.9) > 1e-6)).toBe(true)
  })

  it('starts paused when the page says so (a pause that came while it waited for its streams)', () => {
    const t = new Ctor({ processorOptions: { paused: true } })
    for (let i = 0; i < 20; i++) t.process(quantum(0.3))
    t.port.send('flush')
    expect(t.port.posted).toEqual(['flushed'])
  })

  it('mixes channels to mono', () => {
    const t = new Ctor()
    t.process([[new Float32Array(128).fill(1), new Float32Array(128).fill(0)]])
    t.port.send('flush')
    expect((t.port.posted[0] as Float32Array)[0]).toBeCloseTo(0.5)
  })

  it('gate writes zeros in place of the input (same number of frames), ungate takes it again', () => {
    const t = new Ctor()
    t.process(quantum(0.4))
    t.port.send('gate')
    for (let i = 0; i < 3; i++) t.process(quantum(0.9))
    t.port.send('ungate')
    t.process(quantum(0.2))
    t.port.send('flush')
    const out = t.port.posted.filter((x): x is Float32Array => x instanceof Float32Array)
    const all = Float32Array.from(out.flatMap((b) => [...b]))
    // The timeline is kept: five quanta in, five out.
    expect(all.length).toBe(5 * 128)
    expect(all.slice(0, 128).every((v) => Math.abs(v - 0.4) < 1e-6)).toBe(true)
    expect(all.slice(128, 4 * 128).every((v) => v === 0)).toBe(true)
    expect(all.slice(4 * 128).every((v) => Math.abs(v - 0.2) < 1e-6)).toBe(true)
  })

  it('starts gated when the page says so (a recording that starts muted never keeps the mic)', () => {
    const t = new Ctor({ processorOptions: { gated: true } })
    for (let i = 0; i < 20; i++) t.process([[new Float32Array(128).fill(0.7), new Float32Array(128).fill(0.3)]])
    t.port.send('flush')
    expect(frames(t.port.posted)).toBe(20 * 128)
    for (const b of t.port.posted) if (b instanceof Float32Array) expect(b.every((v) => v === 0)).toBe(true)
  })

  it('a pause holds over a gate: nothing is posted while paused, gated or not', () => {
    const t = new Ctor({ processorOptions: { paused: true, gated: true } })
    t.process(quantum(0.5))
    t.port.send('ungate')
    t.process(quantum(0.5))
    t.port.send('flush')
    expect(t.port.posted).toEqual(['flushed'])
  })
})
