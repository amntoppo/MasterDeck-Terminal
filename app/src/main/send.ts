import * as pty from 'node-pty'
import { menuOnScreen, plainScreen, type KeyStep } from '@shared/ask'
import { heldReasonText, isCommand, promptDraft, type HeldMessage, type HeldReason } from '@shared/heldMessages'
import { isSafeBgId } from '@shared/paneCommand'
import { looksLikePrompt } from '@shared/promptGuard'
import { canSend, pasteSequence } from '@shared/send'
import type { CliResult, Session } from '@shared/types'
import type { HeldStore } from './held'
import type { MasterCli } from './masterCli'
import type { ModDeliverResult } from './modDeliver'
import type { PtyManager } from './ptys'
import { promptLines } from './screen'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The user typed into the pane this recently: a message waits (keys not echoed yet are not on screen). */
export const TYPING_MS = 4_000
/** A held message for a session with no open pane is tried through a hidden attach at most this often. */
export const ATTACH_RETRY_MS = 20_000
// The hidden attach's size.
const ATTACH_COLS = 120
const ATTACH_ROWS = 40

export interface SendOpts {
  /** Who sends it, in words (shown while it is held). */
  from?: string
  /** Send now: also while the prompt can't be read or the user just typed; never over text in it. */
  force?: boolean
  /** The held message this is (a retry): it is not held a second time. */
  held?: string
}

/** `held`: not sent yet, kept to go once the prompt is empty (#123). */
export type SendResult = CliResult & { held?: true; typedNotSent?: true }

/** Ways around typing (#123), and where held messages wait. All optional: without them, typing as before, guarded. */
export interface DeliverDeps {
  /** The session runs MasterDeck's core mod and it takes messages (its heartbeat says `deliver`). */
  modTakes?: (s: Session) => boolean
  mod?: { deliver(sessionId: string, text: string): Promise<ModDeliverResult> }
  held?: HeldStore
  log?: (m: string) => void
  /** Renders output as the screen's rows, dim cells blanked (tests stub it). */
  lines?: (raw: string, cols: number, rows: number) => Promise<string[]>
}

type Box = 'empty' | HeldReason

/**
 * Sends a message to a session without ever mixing it with what the user is typing (#123). First
 * through MasterDeck's core mod, which submits it as a prompt of its own and never touches the
 * prompt box. Else it is typed in as if the user typed it (see `canSend` for the rules): into its
 * open tab or through a short hidden `claude attach`, only while the prompt box is empty and the
 * user is not typing; or relayed by master-agent (`SendMessage`, which never types) for a session in
 * another terminal. A message that can't go now is held (`HeldStore`) and tried again by `pumpHeld`.
 */
export class Sender {
  /** Sessions with a send in flight: a second send is refused, never doubled. */
  private inFlight = new Set<string>()
  /** Hidden attach processes, killed if the app quits mid-send. */
  private procs = new Set<pty.IPty>()
  /** When a held message of a session was last tried through a hidden attach, by session key. */
  private attachTried = new Map<string, number>()
  private pumping = false

  constructor(
    private ptys: PtyManager,
    private cli: MasterCli,
    private env: () => NodeJS.ProcessEnv,
    private claude: () => string,
    /** The session as the app sees it now (re-checked right before typing). */
    private current: (key: string) => Session | undefined,
    private d: DeliverDeps = {},
  ) {}

  /** Refuse if, by the time we type, the session blocked on a prompt or ended. */
  private stillSafe(key: string, screen: string): string | null {
    const now = this.current(key)
    if (!now || now.state === 'done') return 'the session ended'
    if (now.state === 'needs-input') return 'it started waiting on a prompt; open it to answer'
    if (looksLikePrompt(screen)) return 'its screen shows a prompt; open it to answer'
    return null
  }

  /** What the prompt box holds on this screen: empty, the user's text, or no box to be seen. */
  private async box(raw: string, cols: number, rows: number): Promise<'empty' | 'draft' | 'unknown'> {
    const draft = promptDraft(await (this.d.lines ?? promptLines)(raw, cols, rows))
    return draft === null ? 'unknown' : draft ? 'draft' : 'empty'
  }

  private async paneBox(paneId: string): Promise<Box> {
    const sc = this.ptys.screen(paneId)
    const box = sc ? await this.box(sc.raw, sc.cols, sc.rows) : 'unknown'
    if (box === 'draft') return box
    return Date.now() - this.ptys.inputAt(paneId) < TYPING_MS ? 'typing' : box
  }

  /** Keep it for later (or, a retry, say why it still waits). Without a store it is refused. */
  private hold(s: Session, text: string, reason: HeldReason, opts: SendOpts): SendResult {
    const why = heldReasonText(reason)
    if (!this.d.held) return { ok: false, message: `${s.name}: not sent. ${why}` }
    if (opts.held) this.d.held.setReason(opts.held, reason)
    else this.d.held.add(s.key, text.trim(), opts.from ?? 'MasterDeck', reason)
    return { ok: true, held: true, message: `${s.name}: waiting to send. ${why}` }
  }

  async send(s: Session, text: string, masterUp: boolean, opts: SendOpts = {}): Promise<SendResult> {
    if (!text.trim()) return { ok: false, message: 'nothing to send' }
    // Never ahead of messages already waiting for this session.
    const waiting = opts.held ? [] : (this.d.held?.forKey(s.key) ?? [])
    if (waiting.length) return this.hold(s, text, waiting[0].reason, opts)
    if (this.inFlight.has(s.key))
      // Behind the one going in now: held (it goes right after), or refused without a store or for a retry.
      return this.d.held && !opts.held ? this.hold(s, text, 'sending', opts) : { ok: false, message: `${s.name}: a message is already being sent` }
    this.inFlight.add(s.key)
    try {
      const viaMod = await this.viaMod(s, text)
      if (viaMod) return viaMod
      const paneId = `s:${s.key}`
      const route = canSend(s, this.ptys.isAlive(paneId), masterUp)
      if (!route.ok) return { ok: false, message: `${s.name}: ${route.reason}` }
      const { paste, enter } = pasteSequence(text)
      if (route.via === 'pane') {
        const unsafe = this.stillSafe(s.key, this.ptys.tail(paneId))
        if (unsafe) return { ok: false, message: `${s.name}: ${unsafe}` }
        const box = await this.paneBox(paneId)
        if (box === 'draft' || (box !== 'empty' && !opts.force)) return this.hold(s, text, box as HeldReason, opts)
        const typed = this.ptys.inputAt(paneId)
        this.ptys.write(paneId, paste)
        await sleep(150)
        // The user typed while it went in: Enter would send their keys with it. It stays in the box.
        if (this.ptys.inputAt(paneId) !== typed)
          // ok: it is in the prompt (the user sends it); a caller that retried would put it there twice.
          return { ok: true, typedNotSent: true, message: `${s.name}: you typed while it went in, so it is in the prompt, not sent` }
        this.ptys.write(paneId, enter)
        return { ok: true, message: `sent to ${s.name}` }
      }
      if (route.via === 'master') {
        const r = await this.cli.say(s.name, text.trim())
        return r.ok ? { ok: true, message: `master-agent will relay it to ${s.name}` } : r
      }
      return await this.viaAttach(s, text, paste, enter, opts)
    } finally {
      this.inFlight.delete(s.key)
    }
  }

  /** Through the core mod, when the session runs one that takes messages; null: type it instead. */
  private async viaMod(s: Session, text: string): Promise<SendResult | null> {
    if (!this.d.mod || !this.d.modTakes?.(s) || isCommand(text)) return null
    // As the typed routes: never into a question or permission (a submit would wait behind it), an ended or a parked session.
    if (s.state === 'done' || s.state === 'needs-input' || s.state === 'suspended') return null
    const r = await this.d.mod.deliver(s.sessionId, text.trim())
    if (r.kind === 'sent' || r.kind === 'handed') return { ok: true, message: `sent to ${s.name}` }
    if (r.kind === 'failed') this.d.log?.(`[send] ${s.name}: the mod could not submit it (${r.error}); typing it instead`)
    return null
  }

  /**
   * Try each session's first held message again (every couple of seconds): mod first, else typed
   * once its prompt is empty. A session with no open pane is tried through an attach at most every
   * ATTACH_RETRY_MS. Messages of sessions that ended or are gone are dropped.
   */
  async pumpHeld(sessions: Session[], masterUp: boolean, now = Date.now()): Promise<void> {
    const store = this.d.held
    if (!store || this.pumping) return
    this.pumping = true
    try {
      const live = new Map(sessions.map((s) => [s.key, s]))
      for (const m of store.drop((m) => !live.has(m.key) || live.get(m.key)?.state === 'done'))
        this.d.log?.(`[send] dropped a held message from ${m.from}: its session ended`)
      const firsts = new Map<string, HeldMessage>()
      for (const m of store.list()) if (!firsts.has(m.key)) firsts.set(m.key, m)
      for (const m of firsts.values()) {
        const s = live.get(m.key)
        if (!s || s.state === 'needs-input' || s.state === 'suspended') continue
        const attach = !this.ptys.isAlive(`s:${s.key}`) && !this.d.modTakes?.(s) && s.kind === 'background'
        if (attach && now - (this.attachTried.get(s.key) ?? 0) < ATTACH_RETRY_MS) continue
        if (attach) this.attachTried.set(s.key, now)
        const r = await this.send(s, m.text, masterUp, { from: m.from, held: m.id })
        if ((r.ok && !r.held) || r.typedNotSent) store.remove(m.id)
      }
    } finally {
      this.pumping = false
    }
  }

  /** Send now (the held bar): typed even if the prompt can't be read or the user just typed, never over text in it. */
  async sendHeld(id: string, masterUp: boolean): Promise<SendResult> {
    const m = this.d.held?.get(id)
    if (!m) return { ok: false, message: 'that message was already sent or discarded' }
    const s = this.current(m.key)
    if (!s) return { ok: false, message: 'its session is no longer listed' }
    const r = await this.send(s, m.text, masterUp, { from: m.from, held: m.id, force: true })
    if ((r.ok && !r.held) || r.typedNotSent) this.d.held?.remove(m.id)
    return r.held ? { ok: false, message: `${s.name}: ${heldReasonText(this.d.held?.get(id)?.reason ?? 'draft')}` } : r
  }

  dropHeld(id: string): CliResult {
    return this.d.held?.remove(id) ? { ok: true, message: 'discarded' } : { ok: false, message: 'that message was already sent or discarded' }
  }

  /** Sessions (session ids) with messages held: their Stop hook asks MasterDeck for them. */
  heldSessionIds(): Set<string> {
    const out = new Set<string>()
    for (const m of this.d.held?.list() ?? []) {
      const s = this.current(m.key)
      if (s?.sessionId) out.add(s.sessionId)
    }
    return out
  }

  /**
   * The Stop hook of a session whose turn ended: its first held message, to hand over as the hook's
   * answer. None while a send to it is in flight (that one may be the message going in now), and
   * none when the first is a command (an answer is read as words, so it would never run).
   */
  takeHeldFor(sessionId: string): { id: string; text: string; left: number } | null {
    const list = (this.d.held?.list() ?? []).filter((m) => this.current(m.key)?.sessionId === sessionId)
    if (!list.length || this.inFlight.has(list[0].key) || isCommand(list[0].text)) return null
    return { id: list[0].id, text: list[0].text, left: list.length - 1 }
  }

  /** The Stop hook read it: it reached the session. */
  heldDelivered(id: string): void {
    this.d.held?.remove(id)
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

  /**
   * Answer an AskUserQuestion menu with keys (see `menuKeys`): in the open tab, or through a short
   * hidden `claude attach`. Only while the menu is on screen; the tab shows it being answered.
   */
  async answerMenu(s: Session, steps: KeyStep[]): Promise<CliResult> {
    if (this.inFlight.has(s.key)) return { ok: false, message: `${s.name}: a message is already being sent` }
    this.inFlight.add(s.key)
    try {
      const paneId = `s:${s.key}`
      if (this.ptys.isAlive(paneId))
        return await this.typeKeys(s, steps, (d) => this.ptys.write(paneId, d), () => this.ptys.tail(paneId))
      if (s.kind !== 'background') return { ok: false, message: `${s.name} runs in another terminal: answer it there` }
      return await this.withAttach(s, (write, screen) => this.typeKeys(s, steps, write, screen))
    } finally {
      this.inFlight.delete(s.key)
    }
  }

  private async typeKeys(s: Session, steps: KeyStep[], write: (d: string) => void, screen: () => string): Promise<CliResult> {
    // A fresh attach can go quiet before it redraws the prompt: give it a moment to show.
    for (let waited = 0; !menuOnScreen(screen()) && waited < 3000; waited += 250) await sleep(250)
    if (!menuOnScreen(screen())) return { ok: false, message: `${s.name}: its question is no longer on screen; open it to answer` }
    for (const step of steps) {
      if ('expect' in step && !step.expect.test(plainScreen(screen()).slice(-4000)))
        return { ok: false, message: `${s.name}: the answers are in but not submitted; open it to finish` }
      write(step.keys)
      await sleep(step.wait)
    }
    return { ok: true, message: `answered ${s.name}` }
  }

  /**
   * Attach, wait for the screen to settle, paste, Enter, detach. The session keeps running. Text in
   * its prompt box (or no box to be seen, unless sent now) holds the message: nothing is typed.
   */
  private viaAttach(s: Session, text: string, paste: string, enter: string, opts: SendOpts): Promise<SendResult> {
    return this.withAttach(s, async (write, screen) => {
      const unsafe = this.stillSafe(s.key, screen())
      if (unsafe) return { ok: false, message: `${s.name}: ${unsafe}` }
      const box = await this.box(screen(), ATTACH_COLS, ATTACH_ROWS)
      if (box === 'draft' || (box === 'unknown' && !opts.force)) return this.hold(s, text, box, opts)
      write(paste)
      await sleep(150)
      write(enter)
      return { ok: true, message: `sent to ${s.name}` }
    })
  }

  /** A hidden `claude attach` to a background session: once its screen settles, `act` types into it. */
  private withAttach(s: Session, act: (write: (d: string) => void, screen: () => string) => Promise<SendResult>): Promise<SendResult> {
    const bgId = s.bgId
    if (!bgId || !isSafeBgId(bgId)) return Promise.resolve({ ok: false, message: 'bad background id' })
    return new Promise((resolve) => {
      let proc: pty.IPty
      try {
        proc = pty.spawn(this.claude(), ['attach', bgId], {
          name: 'xterm-256color',
          cols: ATTACH_COLS,
          rows: ATTACH_ROWS,
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
          const r = await act((d) => {
            if (exited) throw new Error('attach exited while typing')
            proc.write(d)
          }, () => screen)
          if (r.ok) await sleep(1500)
          done(r)
        } catch (e) {
          done({ ok: false, message: `${s.name}: ${String(e)}` })
        }
      }, 200)
    })
  }
}
