import { spawn, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, existsSync, rmSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** One piece of a transcript, in milliseconds from the start of the audio file. */
export interface Segment {
  start: number
  end: number
  text: string
}

/** Where whisper-cli may be (resolvePaths' inputs, and the login shell's PATH). */
export interface WhisperWhere {
  env: NodeJS.ProcessEnv
  /** process.resourcesPath */
  resourcesPath: string
  /** app.getAppPath(): in development whisper.sh builds into <app>/resources/whisper. */
  appRoot: string
  packaged: boolean
  arch: string
  pathEnv: string
}

const BIN = 'whisper-cli'

export function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The speech engine: MASTERDECK_WHISPER, then the app's own (Resources/whisper/<arch>/, built by
 * scripts/whisper.sh), then whisper-cli on PATH (Homebrew's whisper-cpp, for `npm run dev`).
 */
export function findWhisper(w: WhisperWhere): string | null {
  const own = w.env.MASTERDECK_WHISPER
  if (own) return executable(own) ? own : null
  const bundled = w.packaged ? join(w.resourcesPath, 'whisper', w.arch, BIN) : join(w.appRoot, 'resources', 'whisper', w.arch, BIN)
  if (executable(bundled)) return bundled
  for (const dir of w.pathEnv.split(delimiter)) {
    if (!dir) continue
    const p = join(dir, BIN)
    if (executable(p)) return p
  }
  return null
}

/** Leaves two cores to the rest of the Mac: transcription runs while you work. */
export function whisperThreads(cores = availableParallelism()): number {
  return Math.max(1, cores - 2)
}

const LANGUAGE = /^(auto|[a-z]{2,3})$/
/** whisper.cpp's marker for a stretch of silence: not words anyone said. */
const BLANK = /^\[BLANK_AUDIO\]$/

/**
 * whisper-cli's `-oj` file: `transcription[].offsets` (ms) and `text`. Rows of another shape are
 * skipped; a file that is not JSON throws (a failed chunk, not a silent one). whisper-cli (1.9.4)
 * escapes only `"` and `\` in its text, so a raw tab or newline in what was heard would break
 * JSON.parse: control characters are read as spaces first (JSON's own whitespace is one too).
 */
export function parseWhisperJson(raw: string): Segment[] {
  let j: unknown
  try {
    // eslint-disable-next-line no-control-regex
    j = JSON.parse(raw.replace(/[\u0000-\u001f]/g, ' '))
  } catch {
    throw new Error('whisper-cli wrote a transcript that could not be read.')
  }
  const list = (j as { transcription?: unknown })?.transcription
  if (!Array.isArray(list)) return []
  const out: Segment[] = []
  for (const s of list) {
    const o = (s as { offsets?: { from?: unknown; to?: unknown } })?.offsets
    const text = (s as { text?: unknown })?.text
    if (!o || typeof o.from !== 'number' || typeof o.to !== 'number' || typeof text !== 'string') continue
    const t = text.trim()
    if (!t || BLANK.test(t) || !Number.isFinite(o.from) || !Number.isFinite(o.to) || o.from < 0 || o.to < o.from) continue
    out.push({ start: Math.round(o.from), end: Math.round(o.to), text: t })
  }
  return out
}

export interface TranscribeOptions {
  bin: string
  /** 16 kHz mono WAV (the recorder's chunk). */
  wav: string
  model: string
  /** 'auto' or a two/three-letter code; anything else is 'auto'. */
  language: string
  threads?: number
  /** Default 10 minutes: a 30-second chunk takes seconds. */
  timeoutMs?: number
}

/** The whisper-cli runs in progress: process group id → their temp folder. */
const running = new Map<number, string>()

/**
 * Stops every whisper-cli still running (its whole process group) and removes their temp folders,
 * for a quit: the transcribe() calls then fail. Errors are ignored (a process that ended already).
 */
export function killRunning(): void {
  for (const [pid, dir] of running) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Gone already.
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // transcribe()'s own clean-up tries again.
    }
  }
  running.clear()
}

/**
 * Transcribes one WAV file with whisper-cli at low priority (`nice`): `-oj -of <tmp>` writes the
 * JSON that is read back, so nothing whisper prints is parsed.
 */
export async function transcribe(o: TranscribeOptions): Promise<Segment[]> {
  const dir = await mkdtemp(join(tmpdir(), 'md-whisper-'))
  const base = join(dir, 'out')
  const lang = LANGUAGE.test(o.language) ? o.language : 'auto'
  const args = ['-m', o.model, '-f', o.wav, '-oj', '-of', base, '-l', lang, '-t', String(o.threads ?? whisperThreads()), '-np']
  const nice = existsSync('/usr/bin/nice') ? '/usr/bin/nice' : null
  try {
    await new Promise<void>((resolve, reject) => {
      // Its own process group, so a timeout stops whatever it started too.
      const opts: SpawnOptions = { stdio: ['ignore', 'ignore', 'pipe'], detached: true }
      const p = nice ? spawn(nice, ['-n', '10', o.bin, ...args], opts) : spawn(o.bin, args, opts)
      const pid = p.pid
      if (pid) running.set(pid, dir)
      const done = () => {
        clearTimeout(timer)
        if (pid) running.delete(pid)
      }
      let err = ''
      p.stderr?.on('data', (d: Buffer) => {
        // The last lines only: enough to say why it failed.
        err = (err + d.toString()).slice(-2000)
      })
      const timer = setTimeout(() => {
        try {
          if (p.pid) process.kill(-p.pid, 'SIGKILL')
        } catch {
          p.kill('SIGKILL')
        }
      }, o.timeoutMs ?? 600_000)
      p.on('error', (e) => {
        done()
        reject(new Error(`whisper-cli did not start: ${e.message}`))
      })
      p.on('close', (code, signal) => {
        done()
        if (code === 0) resolve()
        else reject(new Error(`whisper-cli failed (${signal ?? code}): ${err.trim().split('\n').slice(-3).join(' ')}`))
      })
    })
    const raw = await readFile(`${base}.json`, 'utf8').catch(() => {
      throw new Error('whisper-cli wrote no transcript.')
    })
    return parseWhisperJson(raw)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
