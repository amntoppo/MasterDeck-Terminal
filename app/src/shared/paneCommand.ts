import type { PaneSpec } from './types'

export interface PaneCommand {
  file: string
  args: string[]
  cwd?: string
}

/** The process a pane runs. `shell` is $SHELL (unused on Windows); `claude` is the resolved binary. */
export function paneCommand(spec: PaneSpec, platform: string, shell: string | undefined, claude = 'claude'): PaneCommand {
  const win = platform === 'win32'
  if (spec.kind === 'attach') {
    return { file: claude, args: ['attach', spec.bgId] }
  }
  if (win) return { file: 'powershell.exe', args: ['-NoLogo'], cwd: spec.cwd }
  return { file: shell || '/bin/zsh', args: ['-l'], cwd: spec.cwd }
}

/** A background id is 8 hex characters; anything else is refused before it reaches a shell. */
export function isSafeBgId(id: string): boolean {
  return /^[0-9a-f]{8}$/i.test(id)
}
