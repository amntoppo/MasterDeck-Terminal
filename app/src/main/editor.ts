import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Runner } from './run'

/** Apps that open files but are not code editors: never used for a folder. */
const NOT_EDITORS = /\/(TextEdit|Preview|Finder|Notes|Pages|Safari|Google Chrome|Warp|Terminal|iTerm|IDLE)[^/]*\.app$/i

/** Editors to try, in order, when macOS has no default one for code files. */
const KNOWN_MAC = ['Cursor', 'Visual Studio Code', 'Antigravity IDE', 'Antigravity', 'Windsurf', 'Zed', 'IntelliJ IDEA', 'WebStorm', 'PyCharm', 'Android Studio', 'Sublime Text', 'Xcode']

let macDefault: { app: string | null; at: number } | null = null

/**
 * The app macOS opens code files with (a .ts file, then .json and .js), when it is an editor:
 * that is the user's default IDE. Asked once an hour.
 */
async function macDefaultEditor(run: Runner, probeDir: string): Promise<string | null> {
  if (macDefault && Date.now() - macDefault.at < 3_600_000) return macDefault.app
  mkdirSync(probeDir, { recursive: true })
  let app: string | null = null
  for (const ext of ['ts', 'json', 'js']) {
    const f = join(probeDir, `probe.${ext}`)
    if (!existsSync(f)) writeFileSync(f, '')
    const js = `ObjC.import('AppKit'); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(${JSON.stringify(f)})); u.isNil() ? '' : u.path.js`
    const r = await run('osascript', ['-l', 'JavaScript', '-e', js], { timeoutMs: 10_000 })
    const p = r.stdout.trim()
    if (r.code === 0 && p.endsWith('.app') && !NOT_EDITORS.test(p)) {
      app = p
      break
    }
  }
  macDefault = { app, at: Date.now() }
  return app
}

/**
 * Open a folder in the user's IDE: on macOS the default app for code files, else the first known
 * editor installed; elsewhere (or failing that) the `cursor` / `code` command. The file manager only
 * as a last resort.
 */
export async function openInEditor(run: Runner, dir: string, probeDir: string, openPath: (p: string) => Promise<string>): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(dir)) return { ok: false, message: `${dir} no longer exists` }
  if (process.platform === 'darwin') {
    const def = await macDefaultEditor(run, probeDir)
    const apps = [...(def ? [def] : []), ...KNOWN_MAC.map((a) => `/Applications/${a}.app`).filter((a) => a !== def && existsSync(a))]
    for (const app of apps) {
      const r = await run('open', ['-a', app, dir], { timeoutMs: 15_000 })
      if (r.code === 0) return { ok: true, message: `Opened in ${basename(app, '.app')}` }
    }
  }
  for (const bin of process.platform === 'win32' ? ['cursor.cmd', 'code.cmd'] : ['cursor', 'code']) {
    const r = await run(bin, [dir], { timeoutMs: 15_000 })
    if (r.code === 0) return { ok: true, message: `Opened in ${bin.replace(/\.cmd$/, '')}` }
  }
  const err = await openPath(dir)
  return err ? { ok: false, message: err } : { ok: true, message: 'No editor found; opened the folder' }
}
