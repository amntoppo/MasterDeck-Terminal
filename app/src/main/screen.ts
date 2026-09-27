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

/** A background session's screen now, from `claude logs <id>` (its recent output), rendered. */
export async function sessionScreen(run: Runner, claude: string, bgId: string): Promise<string | null> {
  if (!isSafeBgId(bgId)) return null
  const r = await run(claude, ['logs', bgId], { timeoutMs: 15_000 })
  if (r.code !== 0 || !r.stdout) return null
  return renderScreen(r.stdout)
}
