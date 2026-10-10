// The capture window's AudioWorklet (capture.ts): one per track. It mixes the input to mono and
// posts it in blocks of BLOCK frames; the page turns them into 16 kHz Int16 chunks. It writes no
// output, so nothing is played back. No imports: it runs in the AudioWorkletGlobalScope.

declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

const BLOCK = 2048

class PcmTap extends AudioWorkletProcessor {
  private buf = new Float32Array(BLOCK)
  private n = 0

  constructor() {
    super()
    // 'flush': post what is buffered, then say so (Stop waits for it).
    this.port.onmessage = (e) => {
      if (e.data !== 'flush') return
      if (this.n) this.port.postMessage(this.buf.slice(0, this.n))
      this.n = 0
      this.port.postMessage('flushed')
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const chans = inputs[0]
    if (!chans || !chans.length) return true
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
