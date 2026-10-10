/// <reference types="vite/client" />
import workletUrl from './pcmWorklet.ts?worker&url'
import { CaptureControl, Chunker, Resampler, rms, toInt16, wav, type CaptureBridge } from '@shared/meetingAudio'
import { AUDIO_BITS, AUDIO_SLICE_MS, SAMPLE_RATE, type CaptureCommand, type CaptureEnd, type Speaker } from '@shared/meetings'

// The meetings capture window (hidden; main/meetings/recorder.ts opens it at Record and closes it
// at Stop). Main starts it with window.mdCapture.record(id) or .probe(), and sends pause, resume
// and stop through window.mdCapture.command (kept until the streams are open: CaptureControl).
// Everything it records goes to main through
// window.capture (preload/capture.ts); it keeps nothing.

declare global {
  interface Window {
    capture: CaptureBridge
    mdCapture: { record(id: string): Promise<void>; probe(): Promise<void>; command(c: CaptureCommand): void }
  }
}

const LEVEL_MS = 500

/** One track: its worklet, resampled to 16 kHz if the context is not, cut into 30-second WAVs. */
class Tap {
  private chunker = new Chunker()
  private resampler: Resampler | null
  private node: AudioWorkletNode
  private sum = 0
  private count = 0
  private flushed: (() => void) | null = null

  constructor(
    readonly track: Speaker,
    private id: string,
    ctx: AudioContext,
    src: MediaStreamAudioSourceNode,
    paused: boolean,
  ) {
    this.resampler = ctx.sampleRate === SAMPLE_RATE ? null : new Resampler(ctx.sampleRate)
    this.node = new AudioWorkletNode(ctx, 'md-pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { paused },
    })
    src.connect(this.node)
    // The worklet writes silence: connected only so the graph pulls it.
    this.node.connect(ctx.destination)
    this.node.port.onmessage = (e) => {
      if (e.data === 'flushed') return this.flushed?.()
      if (e.data instanceof Float32Array) this.take(e.data)
    }
  }

  /** The worklet holds the pause: it posts what it buffered before it, then drops the input. */
  pause(paused: boolean): void {
    this.node.port.postMessage(paused ? 'pause' : 'resume')
  }

  private take(block: Float32Array): void {
    for (let i = 0; i < block.length; i++) this.sum += block[i] * block[i]
    this.count += block.length
    const samples = this.resampler ? this.resampler.push(block) : block
    for (const c of this.chunker.push(toInt16(samples))) this.send(c)
  }

  private send(c: { seq: number; samples: Int16Array }): void {
    window.capture.chunk({ id: this.id, track: this.track, seq: c.seq }, wav(c.samples))
  }

  /** RMS since the last call. */
  level(): number {
    const v = this.count ? Math.sqrt(this.sum / this.count) : 0
    this.sum = 0
    this.count = 0
    return v
  }

  /** The worklet's last frames, then the last (short) chunk. */
  async flush(): Promise<void> {
    await new Promise<void>((res) => {
      this.flushed = res
      this.node.port.postMessage('flush')
      setTimeout(res, 1000)
    })
    const last = this.chunker.flush()
    if (last) this.send(last)
  }
}

let stopping: Promise<void> | null = null
let stopFn: ((reason: CaptureEnd) => Promise<void>) | null = null
/** Pause and stop: kept while the page waits for its streams, applied when they open. */
const control = new CaptureControl()
const stopAll = (...streams: (MediaStream | null)[]) => {
  for (const s of streams) for (const t of s?.getTracks() ?? []) t.stop()
}

const endOnce = (() => {
  let done = false
  return (reason: CaptureEnd) => {
    if (done) return
    done = true
    window.capture.ended(reason)
  }
})()

/** The Mac's sound: a display capture whose video track is dropped at once. Null when there is none. */
async function systemAudio(): Promise<MediaStream | null> {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    for (const t of s.getVideoTracks()) {
      t.stop()
      s.removeTrack(t)
    }
    if (s.getAudioTracks().some((t) => t.readyState === 'live')) return s
    for (const t of s.getTracks()) t.stop()
  } catch {}
  return null
}

async function record(id: string): Promise<void> {
  if (control.stopped) return endOnce('stopped')
  // The Mac's sound first: getDisplayMedia wants the user activation executeJavaScript gave, and
  // waiting for the microphone (macOS may be asking) could use it up. Both are asked at once.
  const sysAsked = systemAudio()
  let mic: MediaStream
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
  } catch {
    stopAll(await sysAsked)
    return endOnce('mic-refused')
  }
  const sys = await sysAsked
  if (control.stopped) {
    stopAll(mic, sys)
    return endOnce('stopped')
  }
  if (!sys) window.capture.level('others', -1)
  try {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    await ctx.audioWorklet.addModule(workletUrl)
    await ctx.resume()
    const micSrc = ctx.createMediaStreamSource(mic)
    const sysSrc = sys ? ctx.createMediaStreamSource(sys) : null
    // A pause that came while the streams were opening holds from the first frame.
    const paused = control.paused
    const taps = [new Tap('you', id, ctx, micSrc, paused), ...(sysSrc ? [new Tap('others', id, ctx, sysSrc, paused)] : [])]
    // The playback copy: both tracks mixed, Opus, appended by main every 10 s.
    const mix = ctx.createMediaStreamDestination()
    micSrc.connect(mix)
    sysSrc?.connect(mix)
    const recorder = new MediaRecorder(mix.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: AUDIO_BITS })
    let slices = Promise.resolve()
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return
      // In order: each slice waits for the one before.
      slices = slices.then(async () => window.capture.audio(id, new Uint8Array(await e.data.arrayBuffer())))
    }
    recorder.start(AUDIO_SLICE_MS)
    if (paused) recorder.pause()
    const levels = setInterval(() => {
      for (const t of taps) window.capture.level(t.track, t.level())
    }, LEVEL_MS)

    control.attach((c) => {
      if (c === 'stop') return void stopFn?.('stopped')
      const pause = c === 'pause'
      for (const t of taps) t.pause(pause)
      if (pause && recorder.state === 'recording') recorder.pause()
      if (!pause && recorder.state === 'paused') recorder.resume()
    })
    stopFn = (reason) =>
      (stopping ??= (async () => {
        clearInterval(levels)
        // The worklets' last frames. Still paused: they posted what they had at the pause and
        // dropped the input since, so nothing recorded while paused is sent.
        for (const t of taps) await t.flush()
        if (recorder.state !== 'inactive')
          await new Promise<void>((res) => {
            recorder.onstop = () => res()
            recorder.stop()
          })
        await slices
        stopAll(mic, sys)
        await ctx.close().catch(() => {})
        endOnce(reason)
      })())
    mic.getAudioTracks()[0]?.addEventListener('ended', () => void stopFn?.('mic-ended'))
    sys?.getAudioTracks()[0]?.addEventListener('ended', () => window.capture.level('others', -1))
    if (control.stopped) void stopFn('stopped')
  } catch {
    stopAll(mic, sys)
    endOnce('error')
  }
}

/** One second of the Mac's sound: the loudest it was, then 'probe' (or 'no-track'). */
async function probe(): Promise<void> {
  const sys = await systemAudio()
  if (!sys) {
    window.capture.level('others', -1)
    return endOnce('no-track')
  }
  try {
    const ctx = new AudioContext()
    await ctx.resume()
    const an = ctx.createAnalyser()
    ctx.createMediaStreamSource(sys).connect(an)
    const buf = new Float32Array(an.fftSize)
    let max = 0
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 100))
      an.getFloatTimeDomainData(buf)
      max = Math.max(max, rms(buf))
    }
    const live = sys.getAudioTracks().some((t) => t.readyState === 'live')
    window.capture.level('others', live ? max : -1)
    for (const t of sys.getTracks()) t.stop()
    await ctx.close().catch(() => {})
    endOnce(live ? 'probe' : 'no-track')
  } catch {
    for (const t of sys.getTracks()) t.stop()
    endOnce('error')
  }
}

window.mdCapture = {
  record,
  probe,
  command: (c) => control.take(c),
}
