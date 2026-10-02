import type { IBufferCell, Terminal } from '@xterm/xterm'

/**
 * Predictive local echo ("Instant typing") for the web terminal, after VS Code's TypeAheadAddon and mosh.
 *
 * A keystroke we can predict (a printable character, Backspace, Left/Right) is drawn into the terminal at once, dim,
 * as an overlay: the cells it covers are saved first. Before each chunk of real output the overlay is undone (saved
 * cells rewritten, cursor and pen put back), so the program's output always lands on the real screen. Once the
 * output is parsed, the predictions are checked in order against the buffer: confirmed ones drop, the rest are
 * redrawn. Anything unexpected clears them and pauses predicting until three keystrokes in a row echo as predicted.
 *
 * Correctness over speed: whenever the screen could differ from what the output alone would make, predict nothing.
 */
export type PredictorTerm = Pick<Terminal, 'cols' | 'rows' | 'buffer' | 'modes' | 'parser' | 'write'>

export interface Predictor {
  /** A keystroke, before it goes to the pty. */
  onInput(data: string): void
  /** Real output from the pty: use instead of term.write. */
  write(data: string, cb?: () => void): void
  /** Take the overlay off (e.g. before a resize), then call back. */
  clear(cb?: () => void): void
  pending(): number
  shown(): number
  setEnabled(on: boolean): void
  paused(): boolean
  dispose(): void
}

type Kind = 'char' | 'bs' | 'left' | 'right'
interface Saved {
  x: number
  sgr: string
  ch: string
}
interface Pred {
  kind: Kind
  ch: string
  /** The cursor before the key (viewport column/row). */
  x: number
  y: number
  at: number
  shown: boolean
  saved: Saved[]
}

const OVERLAY = 7731 // a private OSC that brackets our own writes, so the pen/cursor tracking skips them
const BEGIN = `\x1b]${OVERLAY};1\x07`
const END = `\x1b]${OVERLAY};0\x07`
const STYLE = '\x1b[0;2m' // dim
const RECOVER_AFTER = 3
const RECOVER_MS = 10_000
const LOW_LATENCY_MS = 30

/** Input that is not typing and moves nothing: mouse motion reports (SGR, button bit 32) and focus in/out. */
const neutral = (d: string) => {
  const m = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(d)
  return m ? (Number(m[1]) & 32) !== 0 && Number(m[1]) < 64 : d === '\x1b[I' || d === '\x1b[O'
}
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-﹯＀-｠￠-￦]|\p{M}|[\u{10000}-\u{10ffff}]/u

function classify(d: string): Kind | null {
  if (d === '\x7f' || d === '\b') return 'bs'
  if (d === '\x1b[D' || d === '\x1bOD') return 'left'
  if (d === '\x1b[C' || d === '\x1bOC') return 'right'
  const cp = d.codePointAt(0) ?? 0
  if (Array.from(d).length !== 1 || cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || WIDE.test(d)) return null
  return 'char'
}

const to = (p: Pred) => (p.kind === 'char' || p.kind === 'right' ? p.x + 1 : p.x - 1)
const cup = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`
const blank = (ch: string) => ch === '' || ch === ' '

/** The program's current SGR attributes, by slot, as SGR text: enough to put the pen back after our overlay. */
type Pen = Record<string, string>

/** Apply one SGR to the pen; false for anything not understood (then the pen is unknown until a reset). */
function applySgr(pen: Pen, ps: (number | number[])[]): boolean {
  const reset = () => Object.keys(pen).forEach((k) => delete pen[k])
  if (!ps.length) return reset(), true
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    if (Array.isArray(p)) return false
    const sub = Array.isArray(ps[i + 1]) ? (ps[++i] as number[]) : null
    const subText = sub ? ':' + sub.map((v) => (v < 0 ? '' : v)).join(':') : ''
    const off = (...slots: string[]) => slots.forEach((k) => delete pen[k])
    if (p === 0) reset()
    else if (p === 1 || p === 2 || p === 3 || p === 5 || p === 6 || p === 7 || p === 8 || p === 9 || p === 53) pen[p === 6 ? 5 : p] = String(p)
    else if (p === 22) off('1', '2')
    else if (p === 23 || p === 25 || p === 27 || p === 28 || p === 29) off(String(p - 20))
    else if (p === 55) off('53')
    else if (p === 4) sub && sub[0] === 0 ? off('ul') : (pen.ul = '4' + subText)
    else if (p === 21) pen.ul = '21'
    else if (p === 24) off('ul')
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) pen.fg = String(p)
    else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) pen.bg = String(p)
    else if (p === 39) off('fg')
    else if (p === 49) off('bg')
    else if (p === 59) off('ulc')
    else if (p === 38 || p === 48 || p === 58) {
      const slot = p === 38 ? 'fg' : p === 48 ? 'bg' : 'ulc'
      if (sub) pen[slot] = p + subText
      else if (ps[i + 1] === 5 && typeof ps[i + 2] === 'number') (pen[slot] = `${p};5;${ps[i + 2]}`), (i += 2)
      else if (ps[i + 1] === 2 && ps.slice(i + 2, i + 5).every((v) => typeof v === 'number')) (pen[slot] = `${p};2;${ps.slice(i + 2, i + 5).join(';')}`), (i += 4)
      else return false
    } else return false
  }
  return true
}

function cellSgr(c: IBufferCell): string {
  const a: (number | string)[] = [0]
  if (c.isBold()) a.push(1)
  if (c.isDim()) a.push(2)
  if (c.isItalic()) a.push(3)
  if (c.isUnderline()) a.push(4)
  if (c.isBlink()) a.push(5)
  if (c.isInverse()) a.push(7)
  if (c.isInvisible()) a.push(8)
  if (c.isStrikethrough()) a.push(9)
  if (c.isOverline()) a.push(53)
  // Modes as xterm stores them: 16-colour (30-37/90-97), 256-colour (38;5;n), RGB (38;2;r;g;b).
  const color = (base: number, mode: number, v: number) => {
    if (mode === 0x1000000) a.push(v < 8 ? base - 8 + v : base + 52 + v - 8)
    else if (mode === 0x2000000) a.push(`${base};5;${v}`)
    else if (mode === 0x3000000) a.push(`${base};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`)
  }
  color(38, c.getFgColorMode(), c.getFgColor())
  color(48, c.getBgColorMode(), c.getBgColor())
  return `\x1b[${a.join(';')}m`
}

export function createPredictor(term: PredictorTerm, opts: { now?: () => number; timeoutMs?: number; enabled?: boolean } = {}): Predictor {
  const now = opts.now ?? (() => performance.now())
  const timeoutMs = opts.timeoutMs ?? 2000
  let preds: Pred[] = []
  /** The overlay of `preds` is in the write stream (drawn or about to be). */
  let drawn = false
  /** Our writes whose effect on the buffer is not parsed yet: real output and undos. */
  let busy = 0
  /** The viewport's scroll position the predictions' rows refer to. */
  let baseY = 0
  let isPaused = term.buffer.active.type === 'alternate'
  /** The buffer (normal/alternate) we last saw: a switch drops everything and starts watching again. */
  let lastType = term.buffer.active.type
  let enabled = opts.enabled ?? true
  let pausedAt = 0
  let streak = 0
  let hidden = false
  const pen: Pen = {}
  let penLost = false
  let inOverlay = false
  const lat: number[] = []
  let keyAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Keys typed while output was being parsed: decided once the buffer is current. */
  const deferred: string[] = []
  /** When we last sent a key we did not model; its echo (or a whole new prompt, after Enter) may still be on the way. */
  let blindAt = -Infinity

  const hooks = [
    term.parser.registerOscHandler(OVERLAY, (d) => ((inOverlay = d === '1'), true)),
    term.parser.registerCsiHandler({ final: 'm' }, (ps) => {
      if (inOverlay) return false
      if (!ps.length || ps[0] === 0) penLost = false
      if (!applySgr(pen, ps)) penLost = true // an SGR we do not model: no predictions until the next reset
      return false
    }),
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (ps) => (ps.includes(25) && (hidden = true), false)),
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (ps) => (ps.includes(25) && (hidden = false), false)),
    term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => (applySgr(pen, []), (penLost = false), (hidden = false), false)),
    term.parser.registerEscHandler({ final: 'c' }, () => (applySgr(pen, []), (penLost = false), (hidden = false), false)),
  ]

  const b = () => term.buffer.active
  const lineAt = (y: number) => b().getLine(baseY + y)
  const penSeq = () => '\x1b[0m' + (Object.keys(pen).length ? `\x1b[${Object.values(pen).join(';')}m` : '')
  // How long after an unmodelled key the screen may still change because of it: about one round trip.
  const syncMs = () => Math.min(3000, Math.max(300, 1.5 * (lat.length ? Math.max(...lat) : 700)))
  const lowLatency = () => lat.length >= 3 && lat.reduce((a, c) => a + c, 0) / lat.length < LOW_LATENCY_MS

  /** The line as it shows with the predictions applied. */
  function model(y: number): { ch: string; w: number }[] {
    const line = lineAt(y)
    const cells = Array.from({ length: term.cols }, (_, x) => {
      const c = line?.getCell(x)
      return { ch: c?.getChars() ?? '', w: c?.getWidth() ?? 1 }
    })
    for (const p of preds) {
      if (p.y !== y) continue
      if (p.kind === 'char') cells[p.x] = { ch: p.ch, w: 1 }
      if (p.kind === 'bs') cells[p.x - 1] = { ch: '', w: 1 }
    }
    return cells
  }

  function allowed(kind: Kind, x: number, y: number): boolean {
    if (y < 0 || y >= term.rows) return false
    // Full-screen apps: only characters, and only once their echo is learned (Backspace and arrows mean too many things there).
    if (kind !== 'char' && b().type === 'alternate') return false
    const cells = model(y)
    if (/pass(word|phrase|code)/i.test(cells.map((c) => c.ch || ' ').join(''))) return false
    switch (kind) {
      case 'char':
        return x < term.cols - 1 && cells[x].w === 1
      case 'right':
        return x < term.cols - 1 && cells[x].w === 1 && cells.slice(x).some((c) => !blank(c.ch))
      case 'left':
        return x > 0 && cells[x - 1].w === 1
      case 'bs':
        return x > 0 && cells[x - 1].w === 1 && cells.slice(x).every((c) => blank(c.ch))
    }
  }

  /** The cell a prediction draws over, if any. */
  const target = (p: Pred) => (p.kind === 'char' ? p.x : p.kind === 'bs' ? p.x - 1 : -1)

  function draw(list: Pred[]): void {
    if (!list.length) return
    let s = BEGIN
    for (const p of list) {
      const x = target(p)
      if (x < 0) continue
      const c = lineAt(p.y)?.getCell(x)
      p.saved = c ? [{ x, sgr: cellSgr(c), ch: c.getChars() }] : []
      s += cup(x, p.y) + (p.kind === 'char' ? STYLE + p.ch : '\x1b[0m\x1b[X')
    }
    const last = list[list.length - 1]
    term.write(s + cup(to(last), last.y) + penSeq() + END)
    drawn = true
  }

  function undoSeq(): string {
    const shown = preds.filter((p) => p.shown)
    if (!drawn || !shown.length) return ''
    let s = BEGIN
    for (const p of [...shown].reverse()) for (const c of p.saved) s += cup(c.x, p.y) + c.sgr + (c.ch || '\x1b[X')
    return s + cup(preds[0].x, preds[0].y) + penSeq() + END
  }

  function clear(cb?: () => void): void {
    const undo = undoSeq()
    preds = []
    drawn = false
    if (!undo) return void (cb && term.write('', cb))
    busy++
    term.write(undo, () => {
      busy--
      if (busy === 0) idle()
      cb?.()
    })
  }

  function pause(): void {
    isPaused = true
    pausedAt = now()
    streak = 0
  }

  function arm(): void {
    if (timer || !preds.length) return
    timer = setTimeout(
      () => {
        timer = null
        if (preds.length && now() - preds[0].at >= timeoutMs) {
          clear()
          pause()
          blindAt = now()
        }
        arm()
      },
      Math.max(0, preds.length ? preds[0].at + timeoutMs - now() : 0),
    )
  }

  /** All real output is parsed: confirm what it echoed, drop everything on a surprise, redraw the rest. */
  function validate(): void {
    const buf = b()
    if (buf.type !== lastType) {
      // Entered or left a full-screen app: its keys mean something else now; watch them again first.
      lastType = buf.type
      preds = []
      drawn = false
      pause()
      return
    }
    if (!preds.length) return
    const cx = buf.cursorX
    const cy = buf.cursorY
    const reasons = hidden || buf.baseY !== baseY
    let i = 0
    for (; !reasons && i < preds.length; i++) {
      const p = preds[i]
      if (cx === p.x && cy === p.y) break // its echo has not come yet
      const c = lineAt(p.y)?.getCell(target(p))
      const ok = p.kind === 'char' ? c?.getChars() === p.ch : p.kind === 'bs' ? blank(c?.getChars() ?? '') : true
      if (!ok) break
      if (!p.shown) streak++
    }
    const rest = preds.slice(i)
    if (reasons || (rest.length && (cx !== rest[0].x || cy !== rest[0].y))) {
      preds = []
      drawn = false
      pause()
      blindAt = now() // the keys behind the failed predictions are still on their way
      return
    }
    preds = rest
    if (isPaused && streak >= RECOVER_AFTER) isPaused = false
    draw(preds.filter((p) => p.shown))
  }

  function handle(d: string): void {
    const kind = classify(d)
    const buf = b()
    // Watching again after a while, but never on the alternate screen: there only exact echoes earn predictions.
    if (isPaused && buf.type === 'normal' && now() - pausedAt > RECOVER_MS) isPaused = false
    // Esc / Ctrl-C in a full-screen app usually change its mode (vim leaving insert mode): learn again.
    if (buf.type === 'alternate' && (d === '\x1b' || d === '\x03')) pause()
    const last = preds[preds.length - 1]
    const x = last ? to(last) : buf.cursorX
    const y = last ? last.y : buf.cursorY
    if (!last) baseY = buf.baseY
    const can =
      kind && now() - blindAt >= syncMs() && !hidden && !penLost && !term.modes.insertMode && !term.modes.originMode && !lowLatency()
    if (!can || !allowed(kind, x, y)) {
      // Not modelled: from here on we do not know where the cursor will be until the screen settles.
      clear()
      blindAt = now()
      return
    }
    const p: Pred = { kind, ch: d, x, y, at: now(), shown: !isPaused && preds.every((q) => q.shown), saved: [] }
    preds.push(p)
    if (p.shown) draw([p])
    arm()
  }

  /** Nothing of ours is waiting to be parsed: check the predictions, then the keys typed meanwhile. */
  function idle(): void {
    validate()
    while (deferred.length && busy === 0) handle(deferred.shift()!)
  }

  return {
    onInput(d) {
      if (!enabled || neutral(d)) return
      if (classify(d) && keyAt === null) keyAt = now()
      // Output is being parsed, so the cursor we would read is stale: the key cannot be echoed in it (the Mac
      // has not seen the key yet), so decide once it is parsed.
      if (busy > 0 || deferred.length) deferred.push(d)
      else handle(d)
    },
    write(data, cb) {
      const undo = undoSeq()
      drawn = false
      busy++
      term.write(undo + data, () => {
        busy--
        if (keyAt !== null) {
          lat.push(now() - keyAt)
          if (lat.length > 8) lat.shift()
          keyAt = null
        }
        if (busy === 0) idle()
        cb?.()
      })
    },
    clear,
    pending: () => preds.length,
    shown: () => preds.filter((q) => q.shown).length,
    setEnabled(on) {
      if (on === enabled) return
      enabled = on
      if (!on) clear()
      else if (b().type === 'alternate') pause()
    },
    paused: () => isPaused,
    dispose() {
      clear()
      if (timer) clearTimeout(timer)
      timer = null
      for (const h of hooks) h.dispose()
    },
  }
}
