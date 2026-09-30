import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { canDeliver, enqueue, eventMessage, sameWatch, type WatchInfo, type WatchRequest } from '@shared/watches'
import type { CliResult, Session } from '@shared/types'

interface Watch {
  id: string
  sessionId: string
  description: string
  command: string
  cwd: string
  startedAt: number
  events: number
  lastEventAt: number | null
  queue: string[]
  dropped: number
  proc: ChildProcess | null
  rest: string
  /** Its script exited: the last message says so, then it is gone. */
  ended: boolean
}

/** What is kept across launches: the monitors to start again. */
type Saved = Pick<Watch, 'id' | 'sessionId' | 'description' | 'command' | 'cwd' | 'startedAt' | 'events' | 'lastEventAt'> & {
  /** Its script's process group, to end a leftover one (the app was killed) before starting it again. */
  pid?: number
}

/**
 * Monitors MasterDeck runs for sessions (see shared/watches): each one's script runs until it
 * exits or it is stopped, with no time limit. What it prints waits until the session's turn is
 * over, then goes to it as one message. Saved in `watches.json` and started again at launch.
 */
export class Watches {
  private list: Watch[] = []
  private sending = new Set<string>()
  private missingSince = new Map<string, number>()

  constructor(
    private file: string,
    private env: () => NodeJS.ProcessEnv,
    private send: (s: Session, text: string) => Promise<CliResult>,
    private onChange: () => void,
  ) {}

  /** Start the monitors saved by the last launch. */
  load(): void {
    let saved: Saved[] = []
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8')) as Saved[]
    } catch {
      return
    }
    for (const w of Array.isArray(saved) ? saved : []) {
      if (typeof w?.id !== 'string' || typeof w.command !== 'string' || typeof w.sessionId !== 'string') continue
      if (typeof w.pid === 'number' && w.pid > 1 && isOurScript(w.pid, w.command)) killGroup(w.pid)
      this.start({ ...w, queue: [], dropped: 0, proc: null, rest: '', ended: false })
    }
  }

  /** A session asked for a monitor: true when MasterDeck already runs that one (a re-arm). */
  add(r: WatchRequest): { already: boolean } {
    if (this.list.some((w) => !w.ended && sameWatch(w, r))) return { already: true }
    this.start({
      id: r.id,
      sessionId: r.sessionId,
      description: r.description,
      command: r.command,
      cwd: r.cwd,
      startedAt: Date.now(),
      events: 0,
      lastEventAt: null,
      queue: [],
      dropped: 0,
      proc: null,
      rest: '',
      ended: false,
    })
    this.save()
    this.onChange()
    return { already: false }
  }

  private start(w: Watch): void {
    this.list.push(w)
    try {
      w.proc = spawn('bash', ['-c', w.command], {
        cwd: w.cwd && existsSync(w.cwd) ? w.cwd : process.env.HOME,
        env: this.env(),
        stdio: ['ignore', 'pipe', 'ignore'],
        // Its own process group: stopping it ends everything the script started.
        detached: true,
      })
    } catch (e) {
      this.finish(w, `could not start: ${String(e)}`)
      return
    }
    w.proc.stdout?.setEncoding('utf8')
    w.proc.stdout?.on('data', (chunk: string) => {
      const text = w.rest + chunk
      const lines = text.split('\n')
      w.rest = lines.pop() ?? ''
      const got = lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim())
      if (!got.length) return
      w.events += got.length
      w.lastEventAt = Date.now()
      w.dropped += enqueue(w.queue, got)
      this.onChange()
    })
    w.proc.on('error', (e) => this.finish(w, `failed: ${String(e)}`))
    w.proc.on('exit', (code, signal) => {
      if (w.rest.trim()) enqueue(w.queue, [w.rest])
      w.rest = ''
      if (!w.ended) this.finish(w, signal ? `stopped (${signal})` : `its script exited (code ${code ?? '?'})`)
    })
  }

  private finish(w: Watch, why: string): void {
    if (w.ended) return
    w.ended = true
    w.proc = null
    enqueue(w.queue, [`(monitor ended: ${why})`])
    this.save()
    this.onChange()
  }

  /** Stop one (from Details): its session is told it stopped. */
  stop(id: string): boolean {
    const w = this.list.find((x) => x.id === id && !x.ended)
    if (!w) return false
    w.ended = true
    if (w.proc?.pid) killGroup(w.proc.pid)
    w.proc = null
    w.queue.push('(monitor stopped from MasterDeck)')
    this.save()
    this.onChange()
    return true
  }

  /** App quits: the scripts stop; they start again at the next launch. */
  killAll(): void {
    for (const w of this.list)
      if (w.proc?.pid) {
        w.proc.removeAllListeners('exit')
        killGroup(w.proc.pid)
      }
  }

  /**
   * Hand what is waiting to sessions whose turn is over (one message each). Monitors of ended
   * sessions stop. Finished monitors leave once their last lines went out.
   */
  deliver(sessions: Session[]): void {
    const bySession = new Map<string, Watch[]>()
    for (const w of this.list) (bySession.get(w.sessionId) ?? bySession.set(w.sessionId, []).get(w.sessionId)!).push(w)
    for (const [sid, ws] of bySession) {
      const s = sessions.find((x) => x.sessionId === sid)
      // Missing from the list for a moment is not gone: only after 2 minutes, or once it ended.
      if (s) this.missingSince.delete(sid)
      else if (!this.missingSince.has(sid)) this.missingSince.set(sid, Date.now())
      const gone = s ? s.state === 'done' : Date.now() - (this.missingSince.get(sid) ?? Date.now()) > 120_000
      if (!s && !gone) continue
      if (!s || gone) {
        // The session is gone: nobody to tell.
        this.missingSince.delete(sid)
        for (const w of ws) if (!w.ended) this.stop(w.id)
        this.list = this.list.filter((w) => w.sessionId !== sid)
        this.save()
        this.onChange()
        continue
      }
      if (this.sending.has(sid) || !ws.some((w) => w.queue.length) || !canDeliver(s)) continue
      const taken = ws.map((w) => {
        const lines = w.dropped ? [`(${w.dropped} older lines dropped)`, ...w.queue] : [...w.queue]
        return { w, lines }
      })
      const text = eventMessage(taken.map(({ w, lines }) => ({ description: w.description, lines })))
      this.sending.add(sid)
      void this.send(s, text)
        .then((r) => {
          if (!r.ok) return
          for (const { w, lines } of taken) {
            w.queue.splice(0, lines.length - (w.dropped ? 1 : 0))
            w.dropped = 0
          }
          this.list = this.list.filter((w) => !(w.ended && !w.queue.length))
          this.save()
          this.onChange()
        })
        .finally(() => this.sending.delete(sid))
    }
  }

  info(): WatchInfo[] {
    return this.list
      .filter((w) => !w.ended)
      .map((w) => ({
        id: w.id,
        sessionId: w.sessionId,
        description: w.description,
        command: w.command,
        startedAt: w.startedAt,
        events: w.events,
        lastEventAt: w.lastEventAt,
        queued: w.queue.length,
      }))
  }

  private save(): void {
    const saved: Saved[] = this.list
      .filter((w) => !w.ended)
      .map(({ id, sessionId, description, command, cwd, startedAt, events, lastEventAt, proc }) => ({ id, sessionId, description, command, cwd, startedAt, events, lastEventAt, pid: proc?.pid }))
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(saved, null, 1))
      renameSync(`${this.file}.tmp`, this.file)
    } catch {
      // next change
    }
  }
}

/** End a script and everything it started (its process group). */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // gone
  }
}

/** The pid still runs this watch's script (a pid can be reused after a restart). */
function isOurScript(pid: number, command: string): boolean {
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })
    return cmd.startsWith('bash -c') && cmd.includes(command.trim().split('\n')[0].slice(0, 60))
  } catch {
    return false
  }
}
