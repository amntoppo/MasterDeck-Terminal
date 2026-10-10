import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, statSync, statfsSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { MODELS, modelById, type ModelProgress, type SpeechModel } from '@shared/meetingModels'

export interface ModelStoreDeps {
  /** Default: the global fetch (follows Hugging Face's redirect to its CDN). */
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  now?: () => number
  /** Free bytes where the models go; default statfs. null: unknown (the download is tried). */
  freeBytes?: (dir: string) => number | null
}

export type DownloadResult = { ok: true } | { ok: false; message: string; cancelled?: boolean }

/** How often a running download reports (the final report always goes out). */
const PROGRESS_MS = 250

function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/**
 * The speech models under MASTERDECK_HOME/meetings/models. Only the files MODELS names (and their
 * `.part` while downloading) are ever written or removed there. A model is ready when its file has
 * the expected size; its SHA-256 was checked once, before the rename that made it appear.
 */
export class ModelStore {
  private running: { id: string; abort: AbortController; progress: ModelProgress } | null = null

  constructor(
    readonly dir: string,
    private deps: ModelStoreDeps = {},
  ) {}

  /** The model's file, or null for a name MODELS does not have. */
  path(id: string): string | null {
    const m = modelById(id)
    return m ? join(this.dir, m.file) : null
  }

  ready(id: string): boolean {
    const m = modelById(id)
    if (!m) return false
    try {
      const s = statSync(join(this.dir, m.file))
      return s.isFile() && s.size === m.bytes
    } catch {
      return false
    }
  }

  status(): { models: { id: string; ready: boolean }[]; downloading: ModelProgress | null } {
    return {
      models: MODELS.map((m) => ({ id: m.id, ready: this.ready(m.id) })),
      downloading: this.running ? { ...this.running.progress } : null,
    }
  }

  /**
   * Downloads a model: streamed to `<file>.part` and hashed while it is written, then checked for
   * its size and SHA-256 and renamed into place. One at a time; cancel() stops it.
   */
  async download(id: string, onProgress: (p: ModelProgress) => void = () => {}): Promise<DownloadResult> {
    const m = modelById(id)
    if (!m) return { ok: false, message: 'Not a speech model.' }
    if (this.running) return { ok: false, message: 'A speech model is downloading already.' }
    if (this.ready(id)) return { ok: true }
    const abort = new AbortController()
    const progress: ModelProgress = { id, received: 0, total: m.bytes, state: 'downloading' }
    this.running = { id, abort, progress }
    const report = (p: Partial<ModelProgress>) => {
      Object.assign(progress, p)
      onProgress({ ...progress })
    }
    const part = join(this.dir, `${m.file}.part`)
    try {
      const r = await this.fetchTo(m, part, abort.signal, (received) => (progress.received = received), () => report({}))
      if (!r.ok) {
        rmQuiet(part)
        report({ state: r.cancelled ? 'cancelled' : 'failed', message: r.message })
        return r
      }
      renameSync(part, join(this.dir, m.file))
      report({ state: 'done', received: m.bytes })
      return { ok: true }
    } finally {
      this.running = null
    }
  }

  private async fetchTo(
    m: SpeechModel,
    part: string,
    signal: AbortSignal,
    received: (n: number) => void,
    tick: () => void,
  ): Promise<DownloadResult> {
    const cancelled: DownloadResult = { ok: false, cancelled: true, message: 'Download cancelled.' }
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      return { ok: false, message: 'Could not make the models folder.' }
    }
    const free = (this.deps.freeBytes ?? freeBytes)(this.dir)
    // Room for the model and a little more: a full disk would also stop recordings.
    if (free !== null && free < m.bytes + 200_000_000) return { ok: false, message: `Not enough disk space: the model needs ${Math.ceil(m.bytes / 1e6)} MB.` }
    const fetcher = this.deps.fetch ?? ((url, init) => fetch(url, init))
    const now = this.deps.now ?? Date.now
    let res: Response
    try {
      res = await fetcher(m.url, { signal })
    } catch {
      return signal.aborted ? cancelled : { ok: false, message: 'Could not reach the model server. Check the connection and try again.' }
    }
    if (!res.ok || !res.body) return { ok: false, message: `The model server answered ${res.status}.` }
    const hash = createHash('sha256')
    const fh = await open(part, 'w')
    let n = 0
    let last = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        n += value.byteLength
        if (n > m.bytes) {
          await reader.cancel().catch(() => {})
          return { ok: false, message: 'The download was larger than the model: thrown away.' }
        }
        hash.update(value)
        await fh.write(value)
        received(n)
        if (now() - last >= PROGRESS_MS) {
          last = now()
          tick()
        }
      }
    } catch {
      return signal.aborted ? cancelled : { ok: false, message: 'The download stopped. Try again.' }
    } finally {
      await fh.close().catch(() => {})
    }
    if (signal.aborted) return cancelled
    if (n !== m.bytes) return { ok: false, message: 'The download stopped before the end. Try again.' }
    if (hash.digest('hex') !== m.sha256) return { ok: false, message: 'The downloaded model is not the expected file: thrown away.' }
    return { ok: true }
  }

  /** Stops the running download (its `.part` is removed). */
  cancel(): boolean {
    if (!this.running) return false
    this.running.abort.abort()
    return true
  }

  /** Removes a downloaded model (and a leftover `.part`). Refused while it downloads. */
  remove(id: string): DownloadResult {
    const m = modelById(id)
    if (!m) return { ok: false, message: 'Not a speech model.' }
    if (this.running?.id === id) return { ok: false, message: 'Cancel the download first.' }
    rmQuiet(join(this.dir, `${m.file}.part`))
    try {
      unlinkSync(join(this.dir, m.file))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, message: 'Could not remove the model.' }
    }
    return { ok: true }
  }
}

function rmQuiet(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    // Already gone.
  }
}
