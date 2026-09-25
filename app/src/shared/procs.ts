/** Is this `ps -o comm=` / tasklist image name a Claude Code process? Guards against a reused pid. */
export function isClaudeCommand(comm: string): boolean {
  const base = comm.trim().split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return base === 'claude' || base === 'claude.exe' || base.startsWith('claude ')
}

/** The image name from `tasklist /FI "PID eq N" /FO CSV /NH` output, or null when there is no such pid. */
export function tasklistImage(csv: string): string | null {
  const m = /^"([^"]+)"/m.exec(csv.trim())
  return m ? m[1] : null
}
