import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Markers a running Claude Code session sets for its own children. User settings such as
 * CLAUDE_CODE_USE_BEDROCK or CLAUDE_CONFIG_DIR are not markers and are kept.
 */
const CLAUDE_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_SSE_PORT',
])
const CLAUDE_MARKER_PREFIXES = ['CLAUDE_CODE_SESSION_', 'CLAUDE_CODE_CHILD_', 'CLAUDE_CODE_MESSAGING_']

export function isClaudeMarker(name: string): boolean {
  return CLAUDE_MARKERS.has(name) || CLAUDE_MARKER_PREFIXES.some((p) => name.startsWith(p))
}

/**
 * A copy of env without the Claude session markers. Launched from inside a Claude terminal, the app
 * would otherwise pass them on: the CLI guard refuses every write, and a `claude` started in a
 * shell tab thinks it is a child session (no transcript, not listed, and the parent's messaging
 * token in its environment).
 */
export function cleanEnv(env: NodeJS.ProcessEnv, pathOverride?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const k of Object.keys(out)) if (isClaudeMarker(k)) delete out[k]
  if (pathOverride) out.PATH = pathOverride
  return out
}

function fallbackPath(current: string | undefined): string {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin']
  const parts = (current ?? '').split(delimiter).filter(Boolean)
  for (const e of extra) if (!parts.includes(e)) parts.push(e)
  return parts.join(delimiter)
}

/**
 * The PATH a login shell would have. A GUI app started from Finder or the Dock gets a bare PATH
 * without Homebrew or ~/.local/bin, where claude, gh and python3 usually live.
 */
export function loginPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve(process.env.PATH ?? '')
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (p: string) => {
      if (done) return
      done = true
      resolve(p)
    }
    try {
      const child = spawn(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], {
        env: cleanEnv(process.env),
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const timer = setTimeout(() => {
        child.kill()
        finish(fallbackPath(process.env.PATH))
      }, 5000)
      child.stdout.on('data', (d) => (out += d.toString()))
      child.on('error', () => finish(fallbackPath(process.env.PATH)))
      child.on('close', () => {
        clearTimeout(timer)
        const m = /__PATH__(.*)__PATH__/s.exec(out)
        finish(fallbackPath(m ? m[1] : process.env.PATH))
      })
    } catch {
      finish(fallbackPath(process.env.PATH))
    }
  })
}

/**
 * The claude binary to run. On Windows it is claude.exe (native install) or claude.cmd (npm), and
 * spawning without a shell only finds .exe, so `where` picks the real file. Elsewhere, `claude`.
 */
export function resolveClaude(env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('claude')
  return new Promise((resolve) => {
    let out = ''
    try {
      const child = spawn('where', ['claude'], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      child.stdout.on('data', (d) => (out += d.toString()))
      child.on('error', () => resolve('claude'))
      child.on('close', () => {
        const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        resolve(lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? 'claude')
      })
    } catch {
      resolve('claude')
    }
  })
}
