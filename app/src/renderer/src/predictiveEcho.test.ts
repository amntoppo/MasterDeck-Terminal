import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { createPredictor, type PredictorTerm } from './predictiveEcho'

const COLS = 40
const ROWS = 6
const newTerm = () => new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
const settle = (t: Terminal) => new Promise<void>((r) => t.write('', r))

/** Every cell (chars, width, colors, bold/dim) and the cursor: what "the same screen" means here. */
function snap(t: Terminal): string[] {
  const b = t.buffer.active
  const out = [`cursor ${b.cursorX},${b.cursorY} base ${b.baseY} ${b.type}`]
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y)!
    let s = ''
    for (let x = 0; x < t.cols; x++) {
      const c = line.getCell(x)!
      s += `[${c.getChars()}|${c.getWidth()}|${c.getFgColorMode()}:${c.getFgColor()}|${c.getBgColorMode()}:${c.getBgColor()}|${c.isBold()}${c.isDim()}${c.isUnderline()}]`
    }
    out.push(s)
  }
  return out
}
const row = (t: Terminal, y = 0) => t.buffer.active.getLine(t.buffer.active.baseY + y)!.translateToString(true).trimEnd()

function setup(opts: { latency?: number; timeoutMs?: number; realClock?: boolean } = {}) {
  const term = newTerm()
  const ref = newTerm()
  let clock = 0
  const p = createPredictor(term as unknown as PredictorTerm, {
    now: opts.realClock ? Date.now : () => clock,
    timeoutMs: opts.timeoutMs,
  })
  /** Output from the Mac, `latency` ms after the last keystroke. The reference sees only this. */
  const out = async (d: string) => {
    clock += opts.latency ?? 300
    ref.write(d)
    await new Promise<void>((r) => p.write(d, r))
    await settle(term)
    await settle(ref)
  }
  const type = async (keys: string | string[]) => {
    for (const k of typeof keys === 'string' ? Array.from(keys) : keys) p.onInput(k)
    await settle(term)
  }
  const same = () => expect(snap(term)).toEqual(snap(ref))
  return { term, ref, p, out, type, same }
}

describe('predictive echo', () => {
  it('shows typed characters at once and drops them when the echo confirms', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ')
    await type('abc')
    expect(row(term)).toBe('$ abc')
    expect(term.buffer.active.cursorX).toBe(5)
    expect(term.buffer.active.getLine(0)!.getCell(2)!.isDim()).toBeTruthy()
    expect(p.pending()).toBe(3)
    await out('a')
    expect(p.pending()).toBe(2)
    expect(row(term)).toBe('$ abc')
    await out('bc')
    expect(p.pending()).toBe(0)
    same()
  })

  it('keeps the colors the program set (the pen) across predictions', async () => {
    const { p, out, type, same } = setup()
    await out('\x1b[1;38;5;196m$ \x1b[38:2::10:20:30m')
    await type('ab')
    await out('a')
    await out('b')
    expect(p.pending()).toBe(0)
    await out('c\x1b[0mz')
    same()
  })

  it('undo restores the colors of the cells it drew over', async () => {
    const { p, out, type, same } = setup()
    await out('$ \x1b[32;1;44mabc\x1b[0m\x1b[3D')
    await type('xy')
    expect(p.pending()).toBe(2)
    await type(['\x03'])
    same()
  })

  it('a prompt that does not echo (password) leaks nothing', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ sudo ls\r\n> ')
    await type('secret')
    await out('')
    p.onInput('\r')
    await out('\r\n')
    expect(p.pending()).toBe(0)
    expect(snap(term).join('')).not.toMatch(/\[[ecrt]\|/)
    same()
  })

  it('does not predict on a password prompt', async () => {
    const { term, p, out, type, same } = setup()
    await out('Password: ')
    await type('hunter2')
    expect(p.pending()).toBe(0)
    expect(row(term)).toBe('Password:')
    same()
  })

  it('predicts and confirms backspace', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ab')
    await type('\x7f')
    expect(row(term)).toBe('$ a')
    expect(term.buffer.active.cursorX).toBe(3)
    await out('\b \b')
    expect(p.pending()).toBe(0)
    same()
    await type('\b')
    expect(row(term)).toBe('$')
    await out('\b\x1b[K')
    expect(p.pending()).toBe(0)
    same()
  })

  it('does not predict backspace with text to its right (the line would shift)', async () => {
    const { p, out, type } = setup()
    await out('$ abc\b')
    await type('\x7f')
    expect(p.pending()).toBe(0)
  })

  it('predicts and confirms left and right', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ abc')
    await type(['\x1b[D'])
    expect(term.buffer.active.cursorX).toBe(4)
    await out('\b')
    expect(p.pending()).toBe(0)
    await type(['\x1b[D', 'x'])
    expect(row(term)).toBe('$ axc')
    await out('\b') // readline: Left, then insert x before b
    await out('xbc\b\b')
    expect(p.pending()).toBe(0)
    expect(row(term)).toBe('$ axbc')
    same()
    await type(['\x1bOC'])
    expect(term.buffer.active.cursorX).toBe(5)
    await out('\x1b[C')
    expect(p.pending()).toBe(0)
    same()
  })

  it('does not predict right past the end of the text', async () => {
    const { p, out, type } = setup()
    await out('$ abc')
    await type(['\x1b[C'])
    expect(p.pending()).toBe(0)
  })

  it('a mismatch clears, pauses, and three exact echoes resume', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ')
    await type('abc')
    await out('ABC')
    expect(p.pending()).toBe(0)
    expect(p.paused()).toBe(true)
    same()
    for (const ch of 'def') {
      await type(ch)
      expect(row(term)).not.toContain(ch) // not shown while paused
      await out(ch)
      same()
    }
    expect(p.paused()).toBe(false)
    await type('g')
    expect(row(term)).toBe('$ ABCdefg')
    await out('g')
    same()
  })

  it('a wrong echo while paused restarts the count', async () => {
    const { p, out, type } = setup()
    await out('$ ')
    await type('a')
    await out('X')
    for (const [k, e] of [['b', 'b'], ['c', 'C'], ['d', 'd'], ['e', 'e']]) {
      await type(k)
      await out(e)
    }
    expect(p.paused()).toBe(true)
    await type('f')
    await out('f')
    expect(p.paused()).toBe(false)
  })

  it('a line redraw (CR + clear line) clears the predictions', async () => {
    const { p, out, type, same } = setup()
    await out('$ ')
    await type('ab')
    await out('\r\x1b[K$ xy')
    expect(p.pending()).toBe(0)
    expect(p.paused()).toBe(true)
    same()
  })

  it('does not predict on the alternate screen', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ')
    await type('a')
    await out('\x1b[?1049h')
    expect(p.pending()).toBe(0)
    same()
    await type('q')
    expect(p.pending()).toBe(0)
    expect(row(term)).toBe('')
    await out('\x1b[?1049l')
    await type('b')
    expect(p.pending()).toBe(1)
  })

  it('does not predict while the cursor is hidden', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ \x1b[?25l')
    await type('a')
    expect(p.pending()).toBe(0)
    expect(row(term)).toBe('$')
    await out('\x1b[?25h')
    await type('a')
    expect(p.pending()).toBe(1)
    await out('a')
    same()
  })

  it('Enter, Tab, Ctrl-C, Esc and pastes clear and are not predicted', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ')
    for (const k of ['\r', '\t', '\x03', '\x1b', 'hello', '\x1b[200~x\x1b[201~', '\x1b[A']) {
      await type('ab')
      expect(p.pending()).toBe(2)
      await type([k])
      expect(p.pending()).toBe(0)
      expect(row(term)).toBe('$')
    }
    same()
  })

  it('does not predict wide characters or at the last column', async () => {
    const { p, out, type } = setup()
    await out('$ ')
    await type('中')
    expect(p.pending()).toBe(0)
    await type('é')
    expect(p.pending()).toBe(1)
    await out('é')
    await out('\r' + 'x'.repeat(COLS - 1))
    await type('y')
    expect(p.pending()).toBe(0)
  })

  it('removes predictions not confirmed in time', async () => {
    const { term, p, out, type, same } = setup({ timeoutMs: 40, realClock: true })
    await out('$ ')
    await type('ab')
    expect(p.pending()).toBe(2)
    await new Promise((r) => setTimeout(r, 80))
    await settle(term)
    expect(p.pending()).toBe(0)
    expect(row(term)).toBe('$')
    same()
  })

  it('turns itself off when the echo is fast (low latency)', async () => {
    const { term, p, out, type } = setup({ latency: 5 })
    await out('$ ')
    for (const ch of 'abcd') {
      await type(ch)
      await out(ch)
    }
    await type('e')
    expect(p.pending()).toBe(0)
    expect(row(term)).toBe('$ abcd')
  })

  it('clear() takes the overlay off before calling back (resize)', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ')
    await type('ab')
    await new Promise<void>((r) => p.clear(r))
    expect(row(term)).toBe('$')
    same()
  })

  it('dispose() takes the overlay off', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ')
    await type('ab')
    p.dispose()
    await settle(term)
    same()
  })

  it('random typing and output: the screen always ends as the output alone makes it', async () => {
    let seed = 7
    const rnd = (n: number) => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n | 0
    }
    // What a shell echoes for each key (the Mac answers in order, late).
    const echo: Record<string, string> = { a: 'a', b: 'b', é: 'é', ' ': ' ', '\x7f': '\b \b', '\x1b[D': '\b', '\x1b[C': '\x1b[C', '\r': '\r\n$ ', '\x03': '^C\r\n$ ', xy: 'xy' }
    const keys = Object.keys(echo)
    const outs = ['X', '\r\x1b[K$ ', '\x1b[31m', '\x1b[0m', '\x1b[?25l', '\x1b[?25h', '\x1b[?1049h', '\x1b[?1049l', '', '\x1b[44mz\x1b[49m']
    let predicted = 0
    for (let run = 0; run < 20; run++) {
      const { term, ref, p, out, type } = setup()
      await out('$ \x1b[1;32mok\x1b[0m ')
      const queue: string[] = []
      for (let step = 0; step < 50; step++) {
        if (rnd(2)) {
          const k = keys[rnd(keys.length - 2)] // mostly printable / editing keys
          queue.push(rnd(10) ? k : keys[keys.length - 2 + rnd(2)])
          await type([queue[queue.length - 1]])
          predicted = Math.max(predicted, p.pending())
        } else {
          await out(queue.length && rnd(10) < 8 ? echo[queue.shift()!] : outs[rnd(outs.length)])
          if (p.pending() === 0) expect(snap(term)).toEqual(snap(ref))
        }
      }
      await new Promise<void>((r) => p.clear(r))
      expect(snap(term)).toEqual(snap(ref))
    }
    expect(predicted).toBeGreaterThan(2)
  }, 30_000)
})
