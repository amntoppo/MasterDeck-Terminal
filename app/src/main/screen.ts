import { Terminal } from '@xterm/headless'
import { isSafeBgId } from '@shared/paneCommand'
import type { Runner } from './run'

/** Render terminal output the way a terminal would show it, as lines of text. */
export function renderScreen(raw: string, cols = 250, rows = 80): Promise<string> {
  const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
  return new Promise((resolve) => {
    term.write(raw, () => {
      const b = term.buffer.active
      const out: string[] = []
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
      term.dispose()
      resolve(out.join('\n'))
    })
  })
}

/**
 * The visible rows of a terminal after `raw` (the screen as it stands, at the terminal's size),
 * with dim cells blanked: Claude Code draws its prompt box's placeholder and suggestions dim, so
 * what is left in the box is what the user typed (see `promptDraft`).
 */
export function promptLines(raw: string, cols: number, rows: number): Promise<string[]> {
  const term = new Terminal({ cols: Math.max(cols, 20), rows: Math.max(rows, 5), scrollback: 0, allowProposedApi: true })
  return new Promise((resolve) => {
    term.write(raw, () => {
      const b = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < term.rows; y++) {
        const line = b.getLine(b.viewportY + y)
        let s = ''
        for (let x = 0; line && x < term.cols; x++) {
          const c = line.getCell(x)
          if (!c || c.getWidth() === 0) continue
          s += c.isDim() ? ' ' : c.getChars() || ' '
        }
        out.push(s.replace(/\s+$/, ''))
      }
      term.dispose()
      resolve(out)
    })
  })
}

/** A background session's screen now, from `claude logs <id>` (its recent output), rendered. */
export async function sessionScreen(run: Runner, claude: string, bgId: string): Promise<string | null> {
  if (!isSafeBgId(bgId)) return null
  const r = await run(claude, ['logs', bgId], { timeoutMs: 15_000 })
  if (r.code !== 0 || !r.stdout) return null
  return renderScreen(r.stdout)
}
