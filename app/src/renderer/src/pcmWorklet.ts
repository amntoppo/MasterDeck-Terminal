// The capture window's AudioWorklet (capture.ts): one per track. It mixes the input to mono and
// posts it in blocks of BLOCK frames; the page turns them into 16 kHz Int16 chunks. It writes no
// output, so nothing is played back. No imports: it runs in the AudioWorkletGlobalScope (loaded
// as a module, by `npm run dev` and the build alike: worker.format 'es' in electron.vite.config.ts).
//
// Messages from the page: 'pause' posts what is buffered (recorded before the pause) and drops
// the input from then on; 'resume' takes it again; 'flush' posts what is buffered, then 'flushed'
// (Stop waits for it). processorOptions.paused: the track starts paused (a pause that came while
// the page waited for its streams).

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: { processorOptions?: unknown })
}
declare function registerProcessor(name: string, ctor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessor): void

const BLOCK = 2048

class PcmTap extends AudioWorkletProcessor {
  private buf = new Float32Array(BLOCK)
  private n = 0
  private paused: boolean

  constructor(options?: { processorOptions?: unknown }) {
    super(options)
    const o = options?.processorOptions as { paused?: unknown } | undefined
    this.paused = o?.paused === true
    this.port.onmessage = (e) => {
      if (e.data === 'pause') {
        this.post()
        this.paused = true
      } else if (e.data === 'resume') this.paused = false
      else if (e.data === 'flush') {
        this.post()
        this.port.postMessage('flushed')
      }
    }
  }

  private post(): void {
    if (this.n) this.port.postMessage(this.buf.slice(0, this.n))
    this.n = 0
  }

  process(inputs: Float32Array[][]): boolean {
    const chans = inputs[0]
    if (this.paused || !chans || !chans.length) return true
    const len = chans[0].length
    for (let i = 0; i < len; i++) {
      let s = 0
      for (const c of chans) s += c[i]
      this.buf[this.n++] = s / chans.length
      if (this.n === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(BLOCK)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('md-pcm', PcmTap)

export {}
