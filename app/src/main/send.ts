import * as pty from 'node-pty'
import { isSafeBgId } from '@shared/paneCommand'
import { looksLikePrompt } from '@shared/promptGuard'
import { canSend, pasteSequence } from '@shared/send'
import type { CliResult, Session } from '@shared/types'
import type { MasterCli } from './masterCli'
import type { PtyManager } from './ptys'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Types a message into a session as if the user typed it (see `canSend` for the rules): into its open
 * tab, through a short hidden `claude attach`, or relayed by master-agent for a session in another
 * terminal.
 */
export class Sender {
  /** Sessions with a send in flight: a second send is refused, never doubled. */
  private inFlight = new Set<string>()
  /** Hidden attach processes, killed if the app quits mid-send. */
  private procs = new Set<pty.IPty>()

  constructor(
    private ptys: PtyManager,
    private cli: MasterCli,
    private env: () => NodeJS.ProcessEnv,
    private claude: () => string,
    /** The session as the app sees it now (re-checked right before typing). */
    private current: (key: string) => Session | undefined,
  ) {}

  /** Refuse if, by the time we type, the session blocked on a prompt or ended. */
  private stillSafe(key: string, screen: string): string | null {
    const now = this.current(key)
    if (!now || now.state === 'done') return 'the session ended'
    if (now.state === 'needs-input') return 'it started waiting on a prompt; open it to answer'
    if (looksLikePrompt(screen)) return 'its screen shows a prompt; open it to answer'
    return null
  }

  async send(s: Session, text: string, masterUp: boolean): Promise<CliResult> {
    if (!text.trim()) return { ok: false, message: 'nothing to send' }
    if (this.inFlight.has(s.key)) return { ok: false, message: `${s.name}: a message is already being sent` }
    this.inFlight.add(s.key)
    try {
      const paneId = `s:${s.key}`
      const route = canSend(s, this.ptys.isAlive(paneId), masterUp)
      if (!route.ok) return { ok: false, message: `${s.name}: ${route.reason}` }
      const { paste, enter } = pasteSequence(text)
      if (route.via === 'pane') {
        const unsafe = this.stillSafe(s.key, this.ptys.tail(paneId))
        if (unsafe) return { ok: false, message: `${s.name}: ${unsafe}` }
        this.ptys.write(paneId, paste)
        await sleep(150)
        this.ptys.write(paneId, enter)
        return { ok: true, message: `sent to ${s.name}` }
      }
      if (route.via === 'master') {
        const r = await this.cli.say(s.name, text.trim())
        return r.ok ? { ok: true, message: `master-agent will relay it to ${s.name}` } : r
      }
      return await this.viaAttach(s, paste, enter)
    } finally {
      this.inFlight.delete(s.key)
    }
  }

  killAll(): void {
    for (const p of this.procs) {
      try {
        p.kill()
      } catch {
        // already gone
      }
    }
    this.procs.clear()
  }

  /** Attach, wait for the screen to settle, paste, Enter, detach. The session keeps running. */
  private viaAttach(s: Session, paste: string, enter: string): Promise<CliResult> {
    const bgId = s.bgId
    if (!bgId || !isSafeBgId(bgId)) return Promise.resolve({ ok: false, message: 'bad background id' })
    return new Promise((resolve) => {
      let proc: pty.IPty
      try {
        proc = pty.spawn(this.claude(), ['attach', bgId], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: s.cwd || process.env.HOME || process.cwd(),
          env: { ...this.env(), TERM: 'xterm-256color' } as Record<string, string>,
        })
      } catch (e) {
        resolve({ ok: false, message: `could not attach to ${s.name}: ${String(e)}` })
        return
      }
      this.procs.add(proc)
      let last = Date.now()
      let exited = false
      let screen = ''
      proc.onData((d) => {
        last = Date.now()
        screen = (screen + d).slice(-20_000)
      })
      proc.onExit(() => (exited = true))
      const started = Date.now()
      const done = (r: CliResult) => {
        try {
          proc.kill()
        } catch {
          // already gone
        }
        this.procs.delete(proc)
        resolve(r)
      }
      const tick = setInterval(async () => {
        if (exited) {
          clearInterval(tick)
          done({ ok: false, message: `${s.name}: attach exited before the message could be sent` })
          return
        }
        const quiet = Date.now() - last > 800
        if (!quiet && Date.now() - started < 6000) return
        clearInterval(tick)
        try {
          const unsafe = this.stillSafe(s.key, screen)
          if (unsafe) {
            done({ ok: false, message: `${s.name}: ${unsafe}` })
            return
          }
          proc.write(paste)
          await sleep(150)
          if (exited) throw new Error('attach exited while typing')
          proc.write(enter)
          await sleep(1500)
          done({ ok: true, message: `sent to ${s.name}` })
        } catch (e) {
          done({ ok: false, message: `${s.name}: ${String(e)}` })
        }
      }, 200)
    })
  }
}
