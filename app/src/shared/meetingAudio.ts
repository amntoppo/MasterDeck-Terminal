import { CHUNK_MAX_BYTES, CHUNK_SAMPLES, SAMPLE_RATE, type CaptureCommand, type CaptureEnd, type Speaker } from './meetings'

/** What the capture window's preload (preload/capture.ts) gives its page as `window.capture`: send only. */
export interface CaptureBridge {
  chunk(meta: { id: string; track: Speaker; seq: number }, bytes: Uint8Array): void
  audio(id: string, bytes: Uint8Array): void
  level(track: Speaker, value: number): void
  ended(reason: CaptureEnd): void
}

// The capture window's pure parts (renderer/src/capture.ts): float samples to 16 kHz mono Int16,
// cut into 30-second WAV chunks. Main checks every chunk with checkWav before writing it.

export const WAV_HEADER = 44

/** A 16-bit mono PCM WAV of these samples. */
export function wav(samples: Int16Array, rate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(WAV_HEADER + samples.length * 2)
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true) // bytes per second
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) v.setInt16(WAV_HEADER + i * 2, samples[i], true)
  return out
}

/** Whether bytes are exactly what wav() writes: 16 kHz mono 16-bit, sizes that add up, at most CHUNK_MAX_BYTES. */
export function checkWav(bytes: Uint8Array): boolean {
  if (bytes.length < WAV_HEADER || bytes.length > CHUNK_MAX_BYTES || bytes.length % 2) return false
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
  return (
    tag(0) === 'RIFF' &&
    v.getUint32(4, true) === bytes.length - 8 &&
    tag(8) === 'WAVE' &&
    tag(12) === 'fmt ' &&
    v.getUint32(16, true) === 16 &&
    v.getUint16(20, true) === 1 &&
    v.getUint16(22, true) === 1 &&
    v.getUint32(24, true) === SAMPLE_RATE &&
    v.getUint32(28, true) === SAMPLE_RATE * 2 &&
    v.getUint16(32, true) === 2 &&
    v.getUint16(34, true) === 16 &&
    tag(36) === 'data' &&
    v.getUint32(40, true) === bytes.length - WAV_HEADER
  )
}

/** Float samples (-1..1, clipped) as Int16. */
export function toInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i] || 0))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

/** Root mean square of a block (0 for an empty one). */
export function rms(f: Float32Array): number {
  if (!f.length) return 0
  let sum = 0
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
  return Math.sqrt(sum / f.length)
}

/**
 * Any rate down (or up) to `to` Hz, block by block, by linear interpolation; its position carries
 * over between blocks so the chunks join without a click. The capture window asks its AudioContext
 * for 16 kHz, so this runs only when Chromium gave another rate.
 * ponytail: no low-pass before decimating (some aliasing above 8 kHz); speech recognition does not
 * mind. Upgrade: a windowed-sinc filter.
 */
export class Resampler {
  // Positions count in [the previous block's last sample, ...this block]: index 0 is `last`.
  private pos = 1
  private last = 0
  private readonly step: number
  constructor(
    readonly from: number,
    readonly to = SAMPLE_RATE,
  ) {
    this.step = from / to
  }

  push(input: Float32Array): Float32Array {
    if (this.from === this.to) return input.slice()
    const at = (k: number) => (k === 0 ? this.last : input[k - 1])
    const out: number[] = []
    while (this.pos < input.length) {
      const i = Math.floor(this.pos)
      const t = this.pos - i
      out.push(at(i) + (at(i + 1) - at(i)) * t)
      this.pos += this.step
    }
    // This block's last sample is index 0 of the next one.
    this.pos -= input.length
    if (input.length) this.last = input[input.length - 1]
    return Float32Array.from(out)
  }
}

/** Collects Int16 samples and hands out full chunks of CHUNK_SAMPLES; flush() gives the part left (or null). */
export class Chunker {
  private buf: Int16Array
  private n = 0
  seq = 0
  constructor(readonly size = CHUNK_SAMPLES) {
    this.buf = new Int16Array(size)
  }

  /** Every chunk that filled up, each with its sequence number (offset = seq × size samples). */
  push(samples: Int16Array): { seq: number; samples: Int16Array }[] {
    const done: { seq: number; samples: Int16Array }[] = []
    let at = 0
    while (at < samples.length) {
      const take = Math.min(this.size - this.n, samples.length - at)
      this.buf.set(samples.subarray(at, at + take), this.n)
      this.n += take
      at += take
      if (this.n === this.size) {
        done.push({ seq: this.seq++, samples: this.buf })
        this.buf = new Int16Array(this.size)
        this.n = 0
      }
    }
    return done
  }

  flush(): { seq: number; samples: Int16Array } | null {
    if (!this.n) return null
    const out = { seq: this.seq++, samples: this.buf.slice(0, this.n) }
    this.n = 0
    return out
  }
}

/**
 * The capture page's pause and stop as main sent them. A command can arrive while the page still
 * waits for the microphone and the Mac's sound (macOS may be asking); it is kept here and applied
 * when the streams open, so a pause or a stop is never lost and the page never records while main
 * shows "Paused".
 */
export class CaptureControl {
  paused = false
  stopped = false
  private on: ((c: CaptureCommand) => void) | null = null

  take(c: CaptureCommand): void {
    if (c === 'stop') this.stopped = true
    else this.paused = c === 'pause'
    this.on?.(c)
  }

  /** The streams are open: they read paused / stopped now, and each later command goes to fn. */
  attach(fn: (c: CaptureCommand) => void): void {
    this.on = fn
  }
}
