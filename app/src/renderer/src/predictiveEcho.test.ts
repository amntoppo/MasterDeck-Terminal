import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { createPredictor, type PredictorTerm } from './predictiveEcho'

const COLS = 40
const ROWS = 6
const newTerm = (cols = COLS, rows = ROWS) => new Terminal({ cols, rows, allowProposedApi: true })
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

function setup(opts: { latency?: number; timeoutMs?: number; realClock?: boolean; cols?: number; rows?: number; enabled?: boolean } = {}) {
  const term = newTerm(opts.cols, opts.rows)
  const ref = newTerm(opts.cols, opts.rows)
  let clock = 0
  const p = createPredictor(term as unknown as PredictorTerm, {
    now: opts.realClock ? Date.now : () => clock,
    timeoutMs: opts.timeoutMs,
    enabled: opts.enabled,
  })
  /** Output from the Mac, `latency` ms after the last keystroke. The reference sees only this. */
  const out = async (d: string) => {
    clock += opts.latency ?? 300
    ref.write(d)
    await new Promise<void>((r) => p.write(d, r))
    await settle(term)
    await settle(ref)
  }
  /** Keys, `gap` ms after the last thing that happened (a person pausing). */
  const type = async (keys: string | string[], gap = 2000) => {
    clock += gap
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

  it('a key typed while output is being parsed is predicted once it is parsed', async () => {
    const { term, ref, p, out, same } = setup()
    ref.write('$ ')
    p.write('$ ')
    p.onInput('l') // before '$ ' is parsed
    await settle(term)
    await settle(term)
    expect(p.pending()).toBe(1)
    expect(row(term)).toBe('$ l')
    await out('l')
    expect(p.pending()).toBe(0)
    same()
  })

  it('typing faster than the round trip: every key predicted, confirmed in order', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ')
    await type('l')
    await type('s', 80)
    await type(' ', 80)
    expect(row(term)).toBe('$ ls')
    await out('l')
    await type('-', 80)
    await out('s')
    await out(' ')
    await out('-')
    expect(p.pending()).toBe(0)
    expect(p.paused()).toBe(false)
    same()
  })

  it('after Enter, predicts nothing until the new prompt has had time to come', async () => {
    const { term, p, out, type, same } = setup()
    await out('$ ')
    await type('a')
    await out('a')
    await type(['\r'])
    await type('b', 50) // typed ahead of the next prompt: where it lands is unknown
    expect(p.pending()).toBe(0)
    await out('\r\n$ b')
    await type('c', 2000)
    expect(p.pending()).toBe(1)
    expect(row(term, 1)).toBe('$ bc')
    await out('c')
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

  it('on the alternate screen it only watches at first: nothing is drawn', async () => {
    const { p, out, type, same } = setup()
    await out('$ ')
    await type('a')
    await out('\x1b[?1049h')
    expect(p.pending()).toBe(0)
    same()
    await type('q')
    expect(p.shown()).toBe(0)
    same()
    await out('\x1b[?1049l')
    await type('b')
    expect(p.shown()).toBe(0) // back on the normal screen: watching again
    await out('b')
    same()
  })

  it('a full-screen app whose keys do not echo (vim normal mode) never gets predictions', async () => {
    const { p, out, type, same } = setup()
    await out('\x1b[?1049h\x1b[H~\r\n~\r\n~\x1b[H')
    const moves: [string, string][] = [['j', '\x1b[2;1H'], ['j', '\x1b[3;1H'], ['k', '\x1b[2;1H'], ['l', '\x1b[2;2H'], ['x', '\x1b[2;1H\x1b[K'], ['w', ''], ['j', '\x1b[3;1H']]
    for (const [k, echo] of moves) {
      await type(k, 2000)
      expect(p.shown()).toBe(0)
      same()
      await out(echo)
      same()
    }
  })

  it('a key echoed at the cursor three times in a row on the alternate screen: then predicted', async () => {
    const { term, p, out, type, same } = setup()
    await out('\x1b[?1049h\x1b[H> ')
    for (const ch of 'abc') {
      await type(ch)
      expect(p.shown()).toBe(0)
      await out(ch)
    }
    await type('d')
    expect(p.shown()).toBe(1)
    expect(row(term)).toBe('> abcd')
    await out('d')
    same()
    await type('e')
    await out('E') // mismatch: back to watching
    same()
    await type('f')
    expect(p.shown()).toBe(0)
  })

  it('Esc on the alternate screen goes back to watching (vim leaving insert mode)', async () => {
    const { p, out, type } = setup()
    await out('\x1b[?1049h\x1b[H')
    for (const ch of 'abc') {
      await type(ch)
      await out(ch)
    }
    await type(['\x1b'])
    await out('\b')
    await type('j')
    expect(p.shown()).toBe(0)
  })

  it('mouse motion reports do not disturb predictions', async () => {
    const { p, out, type, same } = setup()
    await out('\x1b[?1003h\x1b[?1006h$ ')
    await type('a')
    await type(['\x1b[<35;10;3M'], 50)
    await type(['\x1b[I'], 50)
    await type('b', 50)
    expect(p.shown()).toBe(2)
    await type(['\x1b[<64;10;3M'], 50) // the wheel is not neutral: it may scroll the app
    expect(p.shown()).toBe(0)
    await out('ab')
    same()
  })

  it('tracks the pen and the cursor from the start even while switched off', async () => {
    const { p, out, type, same } = setup({ enabled: false })
    await out('\x1b[1;38;5;33m$ \x1b[?25l')
    await type('a')
    expect(p.pending()).toBe(0)
    p.setEnabled(true)
    await type('b')
    expect(p.pending()).toBe(0) // the cursor is still hidden
    await out('b\x1b[?25h')
    await type('c')
    expect(p.shown()).toBe(1)
    await out('c')
    await out('z')
    same()
  })

  it('a long run of SGRs without a full reset (Claude Code never sends 0) keeps predicting', async () => {
    const { p, out, type, same } = setup()
    let s = ''
    for (let i = 0; i < 100; i++) s += `\x1b[38;2;${i};1;2m-\x1b[39m\x1b[2m.\x1b[22m`
    await out(s + '\r\n\x1b[48;5;4m$ ')
    await type('a')
    expect(p.shown()).toBe(1)
    await out('a')
    await out('z')
    same()
  })

  it('Claude Code (real capture): learns its echo, then predicts, and the screen ends exactly as the output makes it', async () => {
    const capture: [number, string][] = JSON.parse(readFileSync(resolve(__dirname, '../../../test/fixtures/claude-echo.json'), 'utf8'))
    const { term, p, out, type, same } = setup({ cols: 100, rows: 30 })
    // The capture up to the first keystroke ('h' was typed just before the 'h' echo).
    const echoAt = capture.findIndex(([, d]) => d.includes('\x1b[25Bh'))
    for (const [, d] of capture.slice(0, echoAt)) await out(d)
    expect(term.buffer.active.type).toBe('alternate')
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([2, 25])
    // h and i, with Claude's own echoes from the capture: watched, not drawn.
    await type('h')
    expect(p.shown()).toBe(0)
    await out(capture[echoAt][1])
    await type('i', 500)
    await out(capture[echoAt + 1][1])
    same()
    // Claude-style echoes from here on: hide the cursor, redraw at the input, park, show the cursor.
    const echo = (x: number, ch: string) => `\x1b[?25l\x1b[H\r\x1b[${x}C\x1b[25B${ch}\x1b[30;1H\x1b[26;${x + 2}H\x1b[?25h`
    await type(' ', 400)
    expect(p.shown()).toBe(0)
    await out(echo(4, ' ')) // third exact echo: learned
    await type('t', 400)
    expect(p.shown()).toBe(1)
    expect(row(term, 25).startsWith('❯\u00a0hi t')).toBe(true)
    await type('h', 80)
    await type('e', 80)
    expect(p.shown()).toBe(3)
    expect(row(term, 25).startsWith('❯\u00a0hi the')).toBe(true)
    await out(echo(5, 't'))
    expect(p.pending()).toBe(2)
    await out(echo(6, 'h'))
    await out(echo(7, 'e'))
    expect(p.pending()).toBe(0)
    expect(p.paused()).toBe(false)
    same()
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
          await type([queue[queue.length - 1]], [0, 80, 2000][rnd(3)])
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

  describe('review round 2', () => {
    const capture = (): [number, string][] => JSON.parse(readFileSync(resolve(__dirname, '../../../test/fixtures/claude-echo.json'), 'utf8'))

    for (const [name, chunks] of [
      ['an SGR', ['\x1b[3', '1mX']],
      ['a cursor move', ['\x1b[2;', '5HZ']],
      ['an OSC title', ['\x1b]0;ti', 'tle\x07Q']],
      ['a DCS string', ['\x1bP1$', 'qm\x1b\\Q']],
      ['an ESC with an intermediate', ['\x1b(', 'BQ']],
      ['an echo, then an SGR', ['a\x1b[3', '1mX']],
    ] as [string, string[]][]) {
      it(`output split inside ${name} with predictions on screen is not corrupted`, async () => {
        const { p, out, type, same } = setup()
        await out('$ ')
        await type('a')
        await out(chunks[0])
        await type('b', 50) // typed between the two halves
        for (const c of chunks.slice(1)) await out(c)
        await new Promise<void>((r) => p.clear(r))
        same()
      })
    }

    it('the Claude capture split at every boundary, a key typed in between: always the reference screen', async () => {
      const all = capture()
        .map(([, d]) => d)
        .join('')
      let drawnMidSequence = 0
      for (let k = 1; k < all.length; k++) {
        const { p, out, type, same } = setup({ cols: 100, rows: 30 })
        await out(all.slice(0, k))
        await type('x') // a person pausing, then typing: drawn if it can be
        drawnMidSequence += p.shown()
        await out(all.slice(k))
        await new Promise<void>((r) => p.clear(r))
        same()
      }
      expect(drawnMidSequence).toBeGreaterThan(0)
    }, 300_000)

    it('Claude, learned: its redraws split at every boundary with a key typed in between', async () => {
      const cap = capture()
      const echoAt = cap.findIndex(([, d]) => d.includes('\x1b[25Bh'))
      const echo = (x: number, ch: string) => `\x1b[?25l\x1b[H\r\x1b[${x}C\x1b[25B${ch}\x1b[30;1H\x1b[26;${x + 2}H\x1b[?25h`
      // Claude echoing 't', with its status line redraw (from the capture) in the same stream.
      const tail = echo(5, 't') + cap[cap.length - 3][1] + echo(6, 'h')
      let drawn = 0
      for (let k = 1; k < tail.length; k++) {
        const { p, out, type, same } = setup({ cols: 100, rows: 30 })
        for (const [, d] of cap.slice(0, echoAt)) await out(d)
        await type('h')
        await out(cap[echoAt][1])
        await type('i', 500)
        await out(cap[echoAt + 1][1])
        await type(' ', 500)
        await out(echo(4, ' '))
        await type('t', 500)
        await type('h', 80)
        await out(tail.slice(0, k))
        await type('e', 1000)
        drawn += p.shown()
        await out(tail.slice(k))
        await new Promise<void>((r) => p.clear(r))
        same()
      }
      expect(drawn).toBeGreaterThan(0)
    }, 300_000)

    it('insert mode switched on while a prediction waits: dropped, not redrawn', async () => {
      const { p, out, type, same } = setup()
      await out('$ xyz\x1b[3D')
      await type('a')
      await type('b', 50)
      await out('\x1b[4h')
      expect(p.shown()).toBe(0)
      await out('ab')
      same()
    })

    it('origin mode and margins switched on while a prediction waits: dropped', async () => {
      const { p, out, type, same } = setup()
      await out('\r\n\r\n$ ')
      await type('a')
      await out('\x1b[2;5r\x1b[?6h\x1b[2;3H')
      expect(p.shown()).toBe(0)
      await out('a')
      await new Promise<void>((r) => p.clear(r))
      same()
    })

    it('an unknown SGR while a prediction waits: dropped', async () => {
      const { p, out, type, same } = setup()
      await out('$ ')
      await type('ab')
      await out('\x1b[73m')
      expect(p.shown()).toBe(0)
      await out('ab')
      same()
    })

    it('a password prompt drawn while predictions wait: dropped', async () => {
      const { p, out, type, same } = setup()
      await out('$ ')
      await type('ab')
      await out('\x1b[s\x1b[1;20HPassword:\x1b[u')
      expect(p.shown()).toBe(0)
      await out('ab')
      same()
    })

    it('a line-drawing charset: nothing predicted until ASCII is back', async () => {
      const { p, out, type, same } = setup()
      await out('$ qqq\x1b[3D\x1b(0')
      await type('a')
      expect(p.pending()).toBe(0)
      await out('\x1b(B')
      await type('a')
      expect(p.shown()).toBe(1)
      await out('a')
      await out('\x1b)0\x0e') // G1 = line drawing, then SO shifts it in
      await type('b')
      expect(p.pending()).toBe(0)
      await out('\x0fb')
      same()
    })

    it('a key typed while clear(refit) is in flight waits for the resize (no reflowed overlay)', async () => {
      const { term, ref, p, out, type, same } = setup()
      await out('hello world, this is a long-ish line\r\n$ ')
      await type('a')
      await new Promise<void>((r) => {
        p.clear(() => {
          term.resize(20, ROWS)
          r()
        })
        p.onInput('b')
      })
      ref.resize(20, ROWS)
      await settle(term)
      await out('ab')
      await new Promise<void>((r) => p.clear(r))
      same()
    })

    it('a resize that did not go through clear() drops the predictions', async () => {
      const { term, p, out, type } = setup()
      await out('$ ')
      await type('ab')
      term.resize(30, ROWS)
      expect(p.pending()).toBe(0)
    })

    it('program output cannot fake the overlay marker', async () => {
      const { p, out, type, same } = setup()
      await out('$ \x1b]7731;1\x07\x1b[31m')
      await type('a')
      await out('a')
      await out('z') // red, as the program asked
      same()
      expect(p.shown()).toBe(0)
    })

    it('after dispose, late write callbacks draw nothing', async () => {
      const { term, ref, p, out, type, same } = setup()
      await out('$ ')
      await type('a')
      ref.write('x')
      p.write('x')
      p.dispose()
      await settle(term)
      await settle(term)
      await settle(ref)
      same()
    })
  })

  describe('review round 3', () => {
    // The reviewer's /tmp/sdrev/c1.ts: a prediction on screen, the first chunk, a key, the rest.
    async function c1(pre: string, chunks: string[]) {
      const { p, out, type, same } = setup()
      await out(pre)
      await type('a')
      await out(chunks[0])
      await type('b')
      for (const c of chunks.slice(1)) await out(c)
      await new Promise<void>((r) => p.clear(r))
      same()
    }
    it('an 8-bit CSI right after ESC, split', () => c1('$ ', ['\x1b\x9b3', '1mX']))
    it('an 8-bit OSC inside a CSI, split', () => c1('$ ', ['\x1b[\x9d0;t', 'itle\x07Q']))
    it('8-bit controls cancel a sequence from any state', () => c1('$ ', ['\x1b]0;x\x9a', 'Q\x1b[\x85', 'R']))
    it('G2 line drawing locked in with ESC n: nothing predicted over text', () => c1('$ xyz\x1b[3D', ['\x1b*0\x1bn', '\r\n']))
    it('G1 line drawing locked in with ESC ~: nothing predicted over text', () => c1('$ xyz\x1b[3D', ['\x1b)0\x1b~', '\r\n']))
    it('G3 via ESC + and ESC o, then back with SI', async () => {
      const { p, out, type } = setup()
      await out('$ \x1b+0\x1bo')
      await type('a')
      expect(p.pending()).toBe(0)
      await out('\x0f')
      await type('a')
      expect(p.shown()).toBe(1)
    })
    it('RIS resets the charsets', async () => {
      const { p, out, type } = setup()
      await out('\x1b(0\x1bc$ ')
      await type('a')
      expect(p.shown()).toBe(1)
    })

    // The reviewer's /tmp/sdrev/rz2.ts: a direct t.resize while 'ab' is predicted.
    it('a direct term.resize goes through clear first', async () => {
      const { term, ref, p, out, type, same } = setup()
      await out('$ ')
      await type('ab')
      term.resize(30, ROWS)
      ref.resize(30, ROWS)
      await settle(term)
      await settle(term)
      expect(term.cols).toBe(30)
      await out('\r\n')
      same()
      p.dispose()
    })
    it('a resize while an undo is still queued waits for it', async () => {
      const { term, ref, p, out, type, same } = setup()
      await out('hello world, this is a long-ish line\r\n$ ')
      await type('ab')
      p.clear() // undo queued, not parsed yet
      term.resize(20, ROWS)
      ref.resize(20, ROWS)
      await settle(term)
      await settle(term)
      await out('ab')
      same()
    })
    it('dispose puts term.resize back', async () => {
      const { term, p } = setup()
      const own = term.resize
      p.dispose()
      expect(term.resize).not.toBe(own)
      term.resize(25, ROWS)
      expect(term.cols).toBe(25)
    })
  })
})
