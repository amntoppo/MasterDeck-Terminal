import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import type { PaneSpec } from '@shared/types'
import { keyOverride } from '@shared/keys'
import { deck } from '../deck'
import { isWeb, keyPlatform } from '../web'

const THEME = {
  background: '#0b0c0f',
  foreground: '#e6e9ef',
  cursor: '#6aa9ff',
  selectionBackground: 'rgba(106,169,255,0.35)',
  black: '#1c2130',
  brightBlack: '#5d6579',
  red: '#f26d6d',
  brightRed: '#ff8a8a',
  green: '#3ecf8e',
  brightGreen: '#6ee7b7',
  yellow: '#f5b83d',
  brightYellow: '#fcd34d',
  blue: '#6aa9ff',
  brightBlue: '#93c5fd',
  magenta: '#a78bfa',
  brightMagenta: '#c4b5fd',
  cyan: '#4fd1c5',
  brightCyan: '#81e6d9',
  white: '#e6e9ef',
  brightWhite: '#ffffff',
}

/** Terminal views by pane id (one pane can show in Terminals and in Tasks at once), for ⌘F. */
const searchers = new Map<string, { search: SearchAddon; host: HTMLElement }[]>()

/** The search of a pane's terminal on screen (else the last one opened), or null. */
export function terminalSearch(paneId: string): SearchAddon | null {
  const list = searchers.get(paneId) ?? []
  return (list.find((x) => x.host.offsetParent !== null) ?? list[list.length - 1])?.search ?? null
}

interface Props {
  paneId: string
  spec: PaneSpec
  /** Visible panes fit themselves; hidden ones keep running and refit when shown. */
  visible: boolean
  focusOnShow?: boolean
  /** Bumped by the parent to force a fresh PTY (Reattach). */
  generation?: number
  onExit?: (code: number) => void
}

export function TerminalView({ paneId, spec, visible, focusOnShow, generation = 0, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [error, setError] = useState<string | null>(null)
  const specKey = JSON.stringify(spec)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  // Only a view on screen sets the PTY's size: the same session can show in two places (Terminals,
  // and a task expanded in Tasks), one at a time.
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  useEffect(() => {
    if (!host.current) return
    const t = new Terminal({
      fontFamily: deck().platform === 'win32' ? 'Cascadia Mono, Consolas, monospace' : isWeb() ? 'SF Mono, Menlo, Cascadia Mono, Consolas, monospace' : 'SF Mono, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      macOptionIsMeta: true,
    })
    const f = new FitAddon()
    t.loadAddon(f)
    // Scans the scrollback only when searched (⌘F); highlights at most 1000 matches.
    const search = new SearchAddon({ highlightLimit: 1000 })
    t.loadAddon(search)
    t.open(host.current)
    const entry = { search, host: host.current }
    searchers.set(paneId, [...(searchers.get(paneId) ?? []), entry])
    term.current = t
    fit.current = f
    try {
      f.fit()
    } catch {
      // hidden on mount; fitted when shown
    }
    let disposed = false
    // Data that arrives before ptyOpen answers is queued, then dropped if the replay covers it.
    let ready = false
    let replaySeq = 0
    const queued: [string, number][] = []
    const offData = deck().onPtyData(paneId, (d, seq) => {
      if (!ready) queued.push([d, seq])
      else if (seq > replaySeq) t.write(d)
    })
    const offExit = deck().onPtyExit(paneId, (code) => onExitRef.current?.(code))
    void deck()
      .ptyOpen(paneId, spec, visibleRef.current ? t.cols : 0, visibleRef.current ? t.rows : 0)
      .then((r) => {
        if (disposed) return
        if (!r.ok) setError(r.message ?? 'could not start the terminal')
        else if (r.replay) t.write(r.replay)
        replaySeq = r.seq
        ready = true
        for (const [d, seq] of queued) if (seq > replaySeq) t.write(d)
        queued.length = 0
        if (r.ok && r.exited) onExitRef.current?.(0)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    const input = t.onData((d) => deck().ptyWrite(paneId, d))
    const resize = t.onResize(({ cols, rows }) => visibleRef.current && deck().ptyResize(paneId, cols, rows))
    // Cmd+C copies a selection instead of sending ^C; Cmd+V pastes.
    t.attachCustomKeyEventHandler((e) => {
      const o = keyOverride(e)
      if (o) {
        if (o !== 'swallow') deck().ptyWrite(paneId, o.send)
        e.preventDefault()
        return false
      }
      if (e.type !== 'keydown') return true
      const mod = keyPlatform() === 'darwin' ? e.metaKey : e.ctrlKey && e.shiftKey
      if (mod && e.key.toLowerCase() === 'c' && t.hasSelection()) {
        deck().copy(t.getSelection())
        return false
      }
      return true
    })
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.offsetParent === null) return
      try {
        f.fit()
      } catch {
        // not laid out yet
      }
    })
    ro.observe(host.current)
    return () => {
      disposed = true
      ro.disconnect()
      input.dispose()
      resize.dispose()
      offData()
      offExit()
      const rest = (searchers.get(paneId) ?? []).filter((x) => x !== entry)
      if (rest.length) searchers.set(paneId, rest)
      else searchers.delete(paneId)
      t.dispose()
      term.current = null
    }
    // The PTY outlives this view; only the owner (tab close) closes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, specKey, generation])

  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        fit.current?.fit()
      } catch {
        // ignore
      }
      // Take the PTY's size back: another view may have shown it at its own size meanwhile.
      if (term.current) deck().ptyResize(paneId, term.current.cols, term.current.rows)
      if (focusOnShow) term.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [visible, focusOnShow, paneId])

  return (
    <div className="term-wrap" onClick={() => term.current?.focus()}>
      <div className="term" ref={host} />
      {error && (
        <div className="overlay">
          <h3>Terminal did not start</h3>
          <div>{error}</div>
        </div>
      )}
    </div>
  )
}

/** Write text into a pane as if typed, then press Enter. */
export function typeInto(paneId: string, text: string): void {
  deck().ptyWrite(paneId, text)
  setTimeout(() => deck().ptyWrite(paneId, '\r'), 120)
}
