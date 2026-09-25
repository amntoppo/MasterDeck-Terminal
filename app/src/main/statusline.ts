import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CliResult } from '@shared/types'

export interface StatuslineOpts {
  settingsPath: string
  home: string
  scriptPath: string
  python: string
  now?: () => number
}

type Settings = Record<string, unknown> & { statusLine?: { type?: string; command?: string; [k: string]: unknown } }

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Settings
}

/** Write via a temp file and rename. Follows a symlink so a dotfiles link stays a link. */
function writeAtomic(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.masterdeck-tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, target)
}

/** Copy the bundled tee script over the installed one when it is missing or different. Returns an error or null. */
export function refreshTee(bundled: string, installed: string): string | null {
  try {
    const want = readFileSync(bundled)
    if (existsSync(installed) && readFileSync(installed).equals(want)) return null
    mkdirSync(dirname(installed), { recursive: true })
    writeFileSync(installed, want)
    return null
  } catch (e) {
    return `could not refresh the status line script: ${String(e)}`
  }
}

export function teeCommand(python: string, scriptPath: string): string {
  return `${python} "${scriptPath}"`
}

export function isInstalled(settingsPath: string, scriptPath: string): boolean {
  try {
    return (readSettings(settingsPath).statusLine?.command ?? '').includes(scriptPath)
  } catch {
    return false
  }
}

/** Point Claude Code's status line at the tee script, keeping the old one running behind it. */
export function installStatusline(o: StatuslineOpts): CliResult {
  try {
    const settings = readSettings(o.settingsPath)
    const current = settings.statusLine
    const ours = teeCommand(o.python, o.scriptPath)
    mkdirSync(o.home, { recursive: true })
    const originalPath = join(o.home, 'statusline-original.json')
    if (current?.command && current.command.includes(o.scriptPath)) {
      if (current.command === ours) return { ok: true, message: 'already installed' }
    } else {
      // Save what was there, even "nothing", so uninstall can put it back.
      writeFileSync(originalPath, JSON.stringify({ command: current?.command ?? null, statusLine: current ?? null }, null, 2))
    }
    if (existsSync(o.settingsPath)) {
      copyFileSync(o.settingsPath, join(o.home, `settings.backup.${(o.now ?? Date.now)()}.json`))
    }
    settings.statusLine = { ...(current ?? {}), type: 'command', command: ours }
    writeAtomic(o.settingsPath, JSON.stringify(settings, null, 2) + '\n')
    return { ok: true, message: 'installed' }
  } catch (e) {
    return { ok: false, message: `could not install the status line hook: ${String(e)}` }
  }
}

export function uninstallStatusline(o: StatuslineOpts): CliResult {
  try {
    const settings = readSettings(o.settingsPath)
    if (!settings.statusLine?.command?.includes(o.scriptPath)) return { ok: true, message: 'not installed' }
    const originalPath = join(o.home, 'statusline-original.json')
    const saved = existsSync(originalPath) ? JSON.parse(readFileSync(originalPath, 'utf8')) : null
    if (saved?.statusLine) settings.statusLine = saved.statusLine
    else delete settings.statusLine
    writeAtomic(o.settingsPath, JSON.stringify(settings, null, 2) + '\n')
    return { ok: true, message: 'uninstalled' }
  } catch (e) {
    return { ok: false, message: `could not uninstall the status line hook: ${String(e)}` }
  }
}
