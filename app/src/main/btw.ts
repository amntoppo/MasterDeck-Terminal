import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  btwModel,
  btwPrompt,
  capAnswer,
  capEntries,
  checkQuestion,
  parseBtwScreen,
  parseHistoryLine,
  parseStreamLine,
  sameQuestion,
  withEntry,
  type BtwAskResult,
  type BtwEntry,
  type BtwEvent,
} from '@shared/btw'
import { tidyScratchProject } from './summary'

const KEY = /^[A-Za-z0-9_-]{1,80}$/

/**
 * Each session's side questions, `<dir>/<session key>.json` (the key survives a resume), oldest
 * first. Every change goes out as a BtwEvent; an answer on its way is sent but written only when it ends.
 */
export class BtwStore {
  private cache = new Map<string, BtwEntry[]>()

  constructor(
    private dir: string,
    private onEvent: (ev: BtwEvent) => void,
  ) {}

  list(key: unknown): BtwEntry[] {
    if (typeof key !== 'string' || !KEY.test(key)) return []
    const hit = this.cache.get(key)
    if (hit) return hit
    let list: BtwEntry[] = []
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, `${key}.json`), 'utf8')) as { entries?: unknown }
      if (Array.isArray(raw.entries)) list = raw.entries.filter(isEntry)
    } catch {
      // none yet
    }
    // An answer the app quit in the middle of never ends now.
    list = list.map((e) => (e.status === 'asking' ? { ...e, status: 'stopped' as const, doneAt: e.doneAt ?? e.at } : e))
    this.cache.set(key, list)
    return list
  }

  /** Put an entry in (by id); `write` false only shows it (an answer still streaming). */
  put(key: string, entry: BtwEntry, write = true): void {
    if (!KEY.test(key)) return
    const list = withEntry(this.list(key), entry)
    this.cache.set(key, list)
    if (write) this.write(key, list)
    this.onEvent({ key, entry })
  }

  remove(key: unknown, id: unknown): boolean {
    if (typeof key !== 'string' || typeof id !== 'string') return false
    const list = this.list(key)
    if (!list.some((e) => e.id === id)) return false
    const next = list.filter((e) => e.id !== id)
    this.cache.set(key, next)
    this.write(key, next)
    this.onEvent({ key, removed: id })
    return true
  }

  private write(key: string, list: BtwEntry[]): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const f = join(this.dir, `${key}.json`)
      writeFileSync(`${f}.tmp`, JSON.stringify({ version: 1, entries: capEntries(list) }, null, 1))
      renameSync(`${f}.tmp`, f)
    } catch (e) {
      console.error(`btw: ${String(e)}`)
    }
  }
}

function isEntry(e: unknown): e is BtwEntry {
  const x = e as BtwEntry
  return !!x && typeof x.id === 'string' && typeof x.question === 'string' && typeof x.answer === 'string' && typeof x.at === 'number'
}

/** The bits of a child process the asker uses (a fake in tests). */
export interface BtwChild {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  stdin: NodeJS.WritableStream
  kill(): void
  on(ev: 'close', cb: (code: number | null) => void): unknown
  on(ev: 'error', cb: (e: Error) => void): unknown
}
export type BtwSpawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => BtwChild

export interface BtwSession {
  key: string
  sessionId: string
  /** The model the session uses (its transcript's), when known. */
  model: string | null
}

/** A streaming answer goes to the window at most this often. */
const SHOW_MS = 120
const TIMEOUT_MS = 5 * 60_000

/**
 * Asks a side question the way `/btw` does: a forked `claude -p` of the session (its whole
 * conversation), with no tools, hooks or MCP servers, nothing saved and the session itself untouched,
 * run from an empty temp folder. One question at a time per session.
 * ponytail: the fork starts its own prompt cache (its tool list differs from the session's), so each
 * question reads the session's whole context once; the cost is kept on the answer. Upgrade path: a
 * side-question API in Claude Code that MasterDeck can call.
 */
export class BtwAsker {
  private live = new Map<string, { id: string; child: BtwChild; stopped: boolean }>()

  constructor(
    private store: BtwStore,
    private claude: () => string,
    private env: () => NodeJS.ProcessEnv,
    private projectsDir: string | null,
    private spawn: BtwSpawn = (cmd, args, opts) => nodeSpawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  ) {}

  busy(key: string): boolean {
    return this.live.has(key)
  }

  ask(s: BtwSession, raw: unknown): BtwAskResult {
    const q = checkQuestion(raw)
    if (!q.ok) return q
    if (!/^[0-9a-f-]{36}$/i.test(s.sessionId)) return { ok: false, message: 'This session has no conversation to ask about yet.' }
    if (this.live.has(s.key)) return { ok: false, message: 'A side question is still being answered. Stop it or wait.' }
    const earlier = this.store.list(s.key)
    const model = btwModel(s.model)
    const entry: BtwEntry = { id: randomUUID(), question: q.question, answer: '', at: Date.now(), doneAt: null, source: 'panel', status: 'asking', ...(model ? { model } : {}) }
    const args = [
      '-p',
      '--resume',
      s.sessionId,
      '--fork-session',
      '--no-session-persistence',
      '--tools',
      '',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(model ? ['--model', model] : []),
    ]
    let scratch: string
    let child: BtwChild
    try {
      scratch = mkdtempSync(join(tmpdir(), 'masterdeck-btw-'))
    } catch (e) {
      return { ok: false, message: String(e) }
    }
    try {
      child = this.spawn(this.claude(), args, { cwd: scratch, env: this.env() })
    } catch (e) {
      rmSync(scratch, { recursive: true, force: true })
      return { ok: false, message: `Could not start claude: ${String(e)}` }
    }
    const run = { id: entry.id, child, stopped: false }
    this.live.set(s.key, run)
    this.store.put(s.key, entry)

    let cur = entry
    let text = ''
    let shown = 0
    let timer: NodeJS.Timeout | null = null
    let result: { ok: boolean; text: string; costUsd: number | null; model: string | null } | null = null
    let stderr = ''
    let rest = ''
    let ended = false
    const show = () => {
      timer = null
      shown = Date.now()
      cur = { ...cur, answer: capAnswer(text) }
      this.store.put(s.key, cur, false)
    }
    const end = (patch: Partial<BtwEntry>) => {
      if (ended) return
      ended = true
      clearTimeout(killer)
      if (timer) clearTimeout(timer)
      this.live.delete(s.key)
      cur = { ...cur, answer: capAnswer(text), doneAt: Date.now(), ...patch }
      this.store.put(s.key, cur)
      rmSync(scratch, { recursive: true, force: true })
      tidyScratchProject(this.projectsDir, scratch)
    }
    const killer = setTimeout(() => {
      child.kill()
      end({ status: 'error', error: 'No answer after 5 minutes.' })
    }, TIMEOUT_MS)
    const line = (l: string) => {
      const it = parseStreamLine(l)
      if (!it) return
      if (it.kind === 'delta') text += it.text
      else if (it.kind === 'text' && it.text.length > text.length) text = it.text
      else if (it.kind === 'model') cur = { ...cur, model: it.model }
      else if (it.kind === 'result') result = it
      if (it.kind === 'delta' || it.kind === 'text') {
        if (!timer) timer = setTimeout(show, Math.max(0, SHOW_MS - (Date.now() - shown)))
      }
    }
    child.stdout.on('data', (d: Buffer) => {
      const parts = (rest + d.toString()).split('\n')
      rest = parts.pop() ?? ''
      parts.forEach(line)
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString()
    })
    child.on('error', (e) => end({ status: 'error', error: `Could not run claude: ${e.message}` }))
    child.on('close', (code) => {
      if (rest) line(rest)
      const r = result as { ok: boolean; text: string; costUsd: number | null; model: string | null } | null
      if (run.stopped) return end({ status: 'stopped' })
      if (r?.ok) {
        if (r.text.length >= text.length) text = r.text
        return end({ status: 'done', ...(r.costUsd !== null ? { costUsd: r.costUsd } : {}), ...(r.model ? { model: r.model } : {}) })
      }
      const why = (r?.text || stderr || `claude exited ${code}`).trim().replace(/\s+/g, ' ').slice(0, 300)
      end({ status: 'error', error: why || 'No answer.' })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(btwPrompt(q.question, earlier))
    return { ok: true, id: entry.id }
  }

  stop(key: unknown, id: unknown): boolean {
    if (typeof key !== 'string') return false
    const run = this.live.get(key)
    if (!run || (typeof id === 'string' && id !== run.id)) return false
    run.stopped = true
    run.child.kill()
    return true
  }

  stopAll(): void {
    for (const run of this.live.values()) {
      run.stopped = true
      run.child.kill()
    }
  }
}

/** A session the follower may file a `/btw` under. */
export interface BtwTarget {
  key: string
  sessionId: string
  bgId: string | null
}

/** The first read of history.jsonl looks this far back. */
const BACKFILL_BYTES = 2_000_000
/** A `/btw` newer than this gets its answer read from the screen. */
const FRESH_MS = 2 * 60_000
const CAPTURE_EVERY_MS = 2_000
const CAPTURE_FOR_MS = 90_000

/**
 * `/btw` typed in a session's terminal: Claude Code writes the question to its prompt history
 * (`history.jsonl`, with the session id) and keeps the answer nowhere. The follower reads new lines
 * (its offset in `offsetFile`), files each question under its session, and for a background session
 * reads the answer off the screen (`claude logs`) while the box is open: what fit on the screen.
 */
export class BtwTerminal {
  private offset: number | null = null
  private capturing = new Map<string, string>()
  private busy = false
  /** `/btw` lines read and not filed yet. */
  private pending: { sessionId: string; question: string; at: number }[] = []

  constructor(
    private file: string,
    private offsetFile: string,
    private store: BtwStore,
    private screen: (bgId: string) => Promise<string | null>,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Read what history.jsonl gained. `sessions` empty means the list is not loaded yet: nothing is read. */
  async poll(sessions: BtwTarget[]): Promise<void> {
    if (this.busy || !sessions.length) return
    this.busy = true
    try {
      this.read()
      this.place(sessions)
    } finally {
      this.busy = false
    }
  }

  private read(): void {
    let size: number
    try {
      size = statSync(this.file).size
    } catch {
      return
    }
    if (this.offset === null) {
      try {
        const o = (JSON.parse(readFileSync(this.offsetFile, 'utf8')) as { offset?: unknown }).offset
        this.offset = typeof o === 'number' && o >= 0 ? o : null
      } catch {
        this.offset = null
      }
    }
    let from = this.offset ?? Math.max(0, size - BACKFILL_BYTES)
    // A history file that shrank was rewritten: start over from its end window.
    if (from > size) from = Math.max(0, size - BACKFILL_BYTES)
    if (from === size) {
      if (this.offset !== size) this.saveOffset(size)
      return
    }
    const buf = Buffer.alloc(Math.min(size - from, 8_000_000))
    const fd = openSync(this.file, 'r')
    try {
      readSync(fd, buf, 0, buf.length, from)
    } finally {
      closeSync(fd)
    }
    const text = buf.toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl < 0) return
    let lines = text.slice(0, lastNl).split('\n')
    // A first read that starts mid-file starts mid-line.
    if (this.offset === null && from > 0) lines = lines.slice(1)
    const next = from + Buffer.byteLength(text.slice(0, lastNl + 1))
    for (const l of lines) {
      const h = parseHistoryLine(l)
      if (h) this.pending.push(h)
    }
    this.saveOffset(next)
  }

  /** File what was read under its session. A fresh one whose session is not listed yet (just started) waits for it. */
  private place(sessions: BtwTarget[]): void {
    const wait: typeof this.pending = []
    for (const h of this.pending) {
      const s = sessions.find((x) => x.sessionId === h.sessionId) ?? sessions.find((x) => x.bgId && h.sessionId.startsWith(x.bgId))
      if (!s) {
        if (this.now() - h.at < FRESH_MS) wait.push(h)
        continue
      }
      const id = `t-${h.at}`
      if (this.store.list(s.key).some((e) => e.id === id)) continue
      const fresh = this.now() - h.at < FRESH_MS && !!s.bgId
      const entry: BtwEntry = {
        id,
        question: h.question,
        answer: '',
        at: h.at,
        doneAt: fresh ? null : h.at,
        source: 'terminal',
        status: fresh ? 'asking' : 'done',
        ...(fresh ? {} : { captured: false }),
      }
      this.store.put(s.key, entry)
      if (fresh && s.bgId) void this.capture(s.key, s.bgId, entry)
    }
    this.pending = wait
  }

  private saveOffset(offset: number): void {
    this.offset = offset
    try {
      writeFileSync(`${this.offsetFile}.tmp`, JSON.stringify({ offset }))
      renameSync(`${this.offsetFile}.tmp`, this.offsetFile)
    } catch {
      // read again next launch
    }
  }

  /** Read the answer off the screen until the box closes (or a newer `/btw` takes it), keeping the longest seen. */
  private async capture(key: string, bgId: string, entry: BtwEntry): Promise<void> {
    this.capturing.set(key, entry.id)
    const until = this.now() + CAPTURE_FOR_MS
    let cur = entry
    let seen = false
    while (this.now() < until && this.capturing.get(key) === entry.id) {
      const screen = await this.screen(bgId).catch(() => null)
      const box = screen ? parseBtwScreen(screen) : null
      const mine = box && sameQuestion(entry.question, box.question)
      if (mine) {
        seen = true
        if (box.answer.length >= cur.answer.length && box.answer !== cur.answer) {
          cur = { ...cur, answer: capAnswer(box.answer), partial: box.more }
          this.store.put(key, cur, false)
        }
      } else if (seen) break
      await this.sleep(CAPTURE_EVERY_MS)
    }
    if (this.capturing.get(key) === entry.id) this.capturing.delete(key)
    this.store.put(key, { ...cur, status: 'done', doneAt: this.now(), captured: seen && !!cur.answer })
  }
}
