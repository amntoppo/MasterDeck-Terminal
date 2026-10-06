import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * A remote save merges over the full current settings (a malformed payload changes nothing) and never changes
 * remoteEnabled (settings saves replace the whole object).
 */
export function remoteSettings(patch: unknown, current: object): Record<string, unknown> {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {}
  return { ...current, ...p, remoteEnabled: (current as { remoteEnabled?: unknown }).remoteEnabled }
}

/** Only dirs the deck already knows (workspace repos, session cwds); path.resolve normalises trailing slashes and `..`. */
export function knownDirsOnly(dirs: string[], known: Iterable<string>): string[] {
  const ok = new Set([...known].map((d) => resolve(d)))
  return dirs.map((d) => resolve(d)).filter((d) => ok.has(d))
}

/**
 * The folder a draft is asked for (the Start dialog's Choose folder…). From a browser it is dropped
 * and the draft is made without it: choosing a folder on the Mac is the desktop's. From the Mac's
 * own window it must be an absolute path to a folder that is there.
 */
export function chosenFolder(remote: boolean, cwd: unknown): { ok: true; cwd?: string } | { ok: false; message: string } {
  if (remote || cwd === undefined || cwd === null || cwd === '') return { ok: true }
  if (typeof cwd !== 'string') return { ok: false, message: 'not a folder on this Mac' }
  let dir = false
  try {
    dir = isAbsolute(cwd) && statSync(cwd).isDirectory()
  } catch {
    dir = false
  }
  return dir ? { ok: true, cwd } : { ok: false, message: `not a folder on this Mac: ${cwd}` }
}

/**
 * The folder **Open Claude there…** runs `claude` in, for the user to answer Claude Code's trust
 * prompt: only from the Mac's own window (a browser or a phone has no tab for it), and only an
 * absolute path to a folder that is there (anything else would start claude in another folder).
 */
export function claudeFolder(remote: boolean, cwd: unknown): { ok: true; cwd: string } | { ok: false; message: string } {
  if (remote) return { ok: false, message: 'Do this on your Mac: open Claude in that folder once and accept its prompt.' }
  if (typeof cwd !== 'string' || !cwd) return { ok: false, message: 'not a folder on this Mac' }
  const r = chosenFolder(false, cwd)
  return r.ok ? { ok: true, cwd } : r
}

/**
 * An inbox action as the `inboxAct` handler passes it on. The paired web app's actions take the
 * same path as the window's (reply, approve and the rest, unchanged); only **Open Claude there…**
 * (`trust`), which opens a tab on the Mac, is refused for a browser, whatever the item allows.
 */
export function inboxActCall(
  remote: boolean,
  id: unknown,
  type: unknown,
  payload: unknown,
): { ok: true; id: string; type: string; payload: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof id !== 'string' || typeof type !== 'string') return { ok: false, message: 'bad inbox action' }
  if (remote && type === 'trust') return claudeFolder(true, null) as { ok: false; message: string }
  return { ok: true, id, type, payload: payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {} }
}

/**
 * Spec §4 size rule: one size per PTY; while the Mac's window shows a pane its size wins, otherwise the latest
 * browser size applies. The window reports a shown pane with cols > 0 (ptyOpen/ptyResize) and a hidden one with 0.
 * ponytail: one flag per pane id; two Mac views of one pane (split) hiding one clears it until the other resizes.
 */
export class MacPanes {
  private shown = new Set<string>()
  /** A ptyOpen/ptyResize from the Mac's window. */
  local(id: string, cols: number): void {
    if (cols > 0) this.shown.add(id)
    else this.shown.delete(id)
  }
  closed(id: string): void {
    this.shown.delete(id)
  }
  /** The size a browser may apply, or null (the Mac shows the pane, or no size given). */
  remoteSize(id: string, cols: number, rows: number): [number, number] | null {
    return this.shown.has(id) || !(cols > 0 && rows > 0) ? null : [cols, rows]
  }
}
