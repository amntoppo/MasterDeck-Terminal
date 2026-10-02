import { resolve } from 'node:path'

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
