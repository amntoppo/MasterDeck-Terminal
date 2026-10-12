import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal, type ILink } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import type { PaneSpec } from '@shared/types'
import { keyOverride } from '@shared/keys'
import { findPaths } from '@shared/filePath'
import { findUrls, isWebLink } from '@shared/termLinks'
import { cellRange, logicalLine } from '../termText'
import { deck } from '../deck'
import { createPredictor, type Predictor } from '../predictiveEcho'
import { quickKeyBytes, type QuickKey } from '../quickKeys'
import { isPhone, isWeb, keyPlatform, usePhone } from '../web'
import { currentTheme, onTheme } from '../theme'
import { xtermTheme } from '@shared/themes'


/** Terminal views by pane id (one pane can show in Terminals and in Tasks at once), for ⌘F. */
const searchers = new Map<string, { search: SearchAddon; host: HTMLElement; term: Terminal }[]>()

/** The search of a pane's terminal on screen (else the last one opened), or null. */
export function terminalSearch(paneId: string): SearchAddon | null {
  const list = searchers.get(paneId) ?? []
  return (list.find((x) => x.host.offsetParent !== null) ?? list[list.length - 1])?.search ?? null
}

/** Phone quick keys: press a key in the pane's terminal on screen, through xterm's own input path (onData). */
export function terminalKey(paneId: string, k: QuickKey): void {
  const t = (searchers.get(paneId) ?? []).find((x) => x.host.offsetParent !== null)?.term
  t?.input(quickKeyBytes(k, t.modes.applicationCursorKeysMode), true)
}

/** The key that makes a click open a link: ⌘ on a Mac, Ctrl elsewhere. */
const linkMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (keyPlatform() === 'darwin' ? e.metaKey : e.ctrlKey)

interface Props {
  paneId: string
  spec: PaneSpec
  /** Visible panes fit themselves; hidden ones keep running and refit when shown. */
  visible: boolean
  focusOnShow?: boolean
  /** Bumped by the parent to force a fresh PTY (Reattach). */
  generation?: number
  onExit?: (code: number) => void
  /** ⌘-click (Ctrl-click elsewhere) on a file path in the output: a session opens it as a tab. Web links open in the browser. */
  onOpenPath?: (path: string) => void
}

export function TerminalView({ paneId, spec, visible, focusOnShow, generation = 0, onExit, onOpenPath }: Props) {
  const onPathRef = useRef(onOpenPath)
  onPathRef.current = onOpenPath
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  // Web only: predictive local echo (Settings → Instant typing); null when off.
  const pred = useRef<Predictor | null>(null)
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
      // A phone gets ~45 columns at 12px; everything else keeps 13.
      fontSize: isPhone() ? 12 : 13,
      lineHeight: 1.15,
      theme: xtermTheme(currentTheme()),
      // The light theme lifts colours a program picked for a dark terminal (Claude Code's own dark theme).
      minimumContrastRatio: currentTheme().termMinContrast,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      macOptionIsMeta: true,
      // OSC 8 links (separate display text): only http/https (xterm drops the rest), and only with the modifier.
      // ponytail: xterm underlines these on hover without the modifier too; its decorations are not ours to set.
      linkHandler: {
        activate: (e, uri) => {
          if (linkMod(e) && isWebLink(uri)) deck().openLink(uri)
        },
      },
    })
    const f = new FitAddon()
    t.loadAddon(f)
    // Scans the scrollback only when searched (⌘F); highlights at most 1000 matches.
    const search = new SearchAddon({ highlightLimit: 1000 })
    t.loadAddon(search)
    t.open(host.current)
    const entry = { search, host: host.current, term: t }
    searchers.set(paneId, [...(searchers.get(paneId) ?? []), entry])
    term.current = t
    fit.current = f
    try {
      f.fit()
    } catch {
      // hidden on mount; fitted when shown
    }
    let disposed = false
    const offTheme = onTheme(() => {
      const th = currentTheme()
      t.options.theme = xtermTheme(th)
      t.options.minimumContrastRatio = th.termMinContrast
    })
    // Created before any output so it tracks the pen and cursor state from the start; switched on by the setting.
    pred.current = isWeb() ? createPredictor(t, { enabled: false }) : null
    const setInstant = (on: boolean) => !disposed && pred.current?.setEnabled(on)
    // A Mac on an older version has no instantTyping: on by default.
    const offState = isWeb() ? deck().onState((s) => setInstant(s.settings.instantTyping !== false)) : () => {}
    if (isWeb()) void deck().getSettings().then((s) => setInstant(s.instantTyping !== false))
    // On the web all output goes through the predictor: it takes its overlay off first, and tracks the screen state.
    const write = (d: string) => (pred.current ? pred.current.write(d) : t.write(d))
    // Data that arrives before ptyOpen answers is queued, then dropped if the replay covers it.
    let ready = false
    let replaySeq = 0
    const queued: [string, number][] = []
    const offData = deck().onPtyData(paneId, (d, seq) => {
      if (!ready) queued.push([d, seq])
      else if (seq > replaySeq) write(d)
    })
    const offExit = deck().onPtyExit(paneId, (code) => onExitRef.current?.(code))
    void deck()
      .ptyOpen(paneId, spec, visibleRef.current ? t.cols : 0, visibleRef.current ? t.rows : 0)
      .then((r) => {
        if (disposed) return
        if (!r.ok) setError(r.message ?? 'could not start the terminal')
        else if (r.replay) write(r.replay)
        replaySeq = r.seq
        ready = true
        for (const [d, seq] of queued) if (seq > replaySeq) write(d)
        queued.length = 0
        if (r.ok && r.exited) onExitRef.current?.(0)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    const input = t.onData((d) => {
      pred.current?.onInput(d)
      deck().ptyWrite(paneId, d)
    })
    const resize = t.onResize(({ cols, rows }) => visibleRef.current && deck().ptyResize(paneId, cols, rows))
    // Web links and file paths in the output open on ⌘-click (Ctrl-click elsewhere): underlined, with a
    // pointer, only while the modifier is held. A wrapped line is read as one, through its cells.
    let modHeld = false
    let hovered: ILink | null = null
    const showMod = (on: boolean) => {
      modHeld = on
      if (hovered?.decorations) {
        hovered.decorations.underline = on
        hovered.decorations.pointerCursor = on
      }
    }
    const onMod = (e: KeyboardEvent | MouseEvent) => showMod(linkMod(e))
    const offMod = () => showMod(false)
    const hostEl = host.current
    hostEl.addEventListener('mousemove', onMod)
    window.addEventListener('keydown', onMod, true)
    window.addEventListener('keyup', onMod, true)
    window.addEventListener('blur', offMod)
    const links = t.registerLinkProvider({
      provideLinks(y, done) {
        const line = logicalLine(t.buffer.active, y)
        const urls = findUrls(line.text)
        const paths = onPathRef.current ? findPaths(line.text).filter((p) => !urls.some((u) => p.start < u.end && p.end > u.start)) : []
        const found = [
          ...urls.map((u) => ({ start: u.start, end: u.end, open: () => deck().openLink(u.url) })),
          ...paths.map((p) => ({ start: p.start, end: p.end, open: () => onPathRef.current?.(p.path) })),
        ]
        const out = found
          .map((f) => ({ ...f, range: cellRange(line, f.start, f.end) }))
          .filter((f) => f.range.start.y <= y && f.range.end.y >= y)
          .map((f) => {
            const link: ILink = {
              range: f.range,
              text: line.text.slice(f.start, f.end),
              decorations: { pointerCursor: modHeld, underline: modHeld },
              activate: (e) => {
                if (linkMod(e)) f.open()
              },
              // xterm swaps in its own decorations right after hover: set them once it has.
              hover: () => {
                hovered = link
                queueMicrotask(() => hovered === link && showMod(modHeld))
              },
              leave: () => {
                if (hovered === link) hovered = null
              },
            }
            return link
          })
        done(out.length ? out : undefined)
      },
    })
    // Cmd+C copies a selection instead of sending ^C; Cmd+V pastes.
    t.attachCustomKeyEventHandler((e) => {
      const o = keyOverride(e)
      if (o) {
        if (o !== 'swallow') {
          pred.current?.onInput(o.send)
          deck().ptyWrite(paneId, o.send)
        }
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
      // A resize reflows the screen: take predictions off first.
      const refit = () => {
        try {
          f.fit()
        } catch {
          // not laid out yet
        }
      }
      if (pred.current) pred.current.clear(refit)
      else refit()
    })
    ro.observe(host.current)
    return () => {
      disposed = true
      ro.disconnect()
      input.dispose()
      resize.dispose()
      links.dispose()
      hostEl.removeEventListener('mousemove', onMod)
      window.removeEventListener('keydown', onMod, true)
      window.removeEventListener('keyup', onMod, true)
      window.removeEventListener('blur', offMod)
      offData()
      offExit()
      offState()
      offTheme()
      pred.current?.dispose()
      pred.current = null
      const rest = (searchers.get(paneId) ?? []).filter((x) => x !== entry)
      if (rest.length) searchers.set(paneId, rest)
      else searchers.delete(paneId)
      t.dispose()
      term.current = null
    }
    // The PTY outlives this view; only the owner (tab close) closes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, specKey, generation])

  // Phone width came or went (rotation, a resized window): change the font, then refit.
  const phone = usePhone()
  useEffect(() => {
    const t = term.current
    const size = phone ? 12 : 13
    if (!t || t.options.fontSize === size) return
    t.options.fontSize = size
    try {
      fit.current?.fit()
    } catch {
      // hidden; fitted when shown
    }
  }, [phone])

  useEffect(() => {
    if (!visible) return
    let live = true
    const shown = () => {
      if (!live) return
      try {
        fit.current?.fit()
      } catch {
        // ignore
      }
      // Take the PTY's size back: another view may have shown it at its own size meanwhile.
      if (term.current) deck().ptyResize(paneId, term.current.cols, term.current.rows)
      if (focusOnShow) term.current?.focus()
    }
    const id = requestAnimationFrame(() => (pred.current ? pred.current.clear(shown) : shown()))
    return () => {
      live = false
      cancelAnimationFrame(id)
      // Hidden or gone: this view no longer holds the PTY's size (cols 0 resizes nothing; spec §4 size rule).
      deck().ptyResize(paneId, 0, 0)
    }
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
