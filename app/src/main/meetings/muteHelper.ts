import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { MUTE_RULES, muteRulesLine, parseMuteLine, type MuteReading, type MuteRule } from '../../shared/meetingMute'
import { executable } from './whisper'

/** Where md-mute may be (like whisper-cli's, without PATH: it is MasterDeck's own). */
export interface MuteWhere {
  env: NodeJS.ProcessEnv
  /** process.resourcesPath */
  resourcesPath: string
  /** app.getAppPath(): in development mute.sh builds into <app>/resources/mute. */
  appRoot: string
  packaged: boolean
  arch: string
}

const BIN = 'md-mute'

/** MASTERDECK_MUTE (set but not runnable: none), then the app's own (scripts/mute.sh). */
export function findMute(w: MuteWhere): string | null {
  const own = w.env.MASTERDECK_MUTE
  if (own) return executable(own) ? own : null
  const bundled = w.packaged ? join(w.resourcesPath, 'mute', w.arch, BIN) : join(w.appRoot, 'resources', 'mute', w.arch, BIN)
  return executable(bundled) ? bundled : null
}

export interface MuteHelper {
  /** Every line md-mute writes that parses (junk is dropped). */
  onLine(cb: (r: MuteReading) => void): void
  /** Once, when it ended (killed, crashed, or it refused the rules: `error` is its stderr). */
  onExit(cb: (code: number | null, error: string) => void): void
  kill(): void
}

/** Lines longer than this are junk; a stuck partial line is dropped rather than grown. */
const MAX_LINE = 4096
const MAX_STDERR = 2048

/**
 * Starts md-mute with the rules on its stdin. Its stdin stays open: closing it (kill, or this
 * process going away) ends the helper.
 */
export function spawnMute(bin: string, rules: readonly MuteRule[] = MUTE_RULES): MuteHelper {
  const known = new Set(rules.map((r) => r.id))
  const p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lineCbs: ((r: MuteReading) => void)[] = []
  const exitCbs: ((code: number | null, error: string) => void)[] = []
  let buf = ''
  let err = ''
  let ended = false

  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const r = parseMuteLine(line, known)
      if (r) for (const cb of lineCbs) cb(r)
    }
    if (buf.length > MAX_LINE) buf = ''
  })
  p.stderr.setEncoding('utf8')
  p.stderr.on('data', (chunk: string) => {
    if (err.length < MAX_STDERR) err = (err + chunk).slice(0, MAX_STDERR)
  })
  // A helper that died before reading its rules makes the write fail: the exit says so.
  p.stdin.on('error', () => {})
  p.stdin.write(muteRulesLine(rules))

  const end = (code: number | null): void => {
    if (ended) return
    ended = true
    for (const cb of exitCbs) cb(code, err.trim())
  }
  p.on('error', (e) => {
    if (!err) err = e.message
    end(null)
  })
  // 'close', not 'exit': every line it wrote has been read by then.
  p.on('close', (code) => end(code))

  return {
    onLine: (cb) => void lineCbs.push(cb),
    onExit: (cb) => void exitCbs.push(cb),
    kill: () => {
      if (ended) return
      p.stdin.end()
      p.kill('SIGTERM')
    },
  }
}
