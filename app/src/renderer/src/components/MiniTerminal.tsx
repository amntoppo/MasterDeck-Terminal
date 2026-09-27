import { Terminal } from '@xterm/xterm'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PaneSpec } from '@shared/types'
import { deck } from '../deck'
import { THEME } from './TerminalView'

interface Props {
  paneId: string
  /** Starts the pane when no view has yet; null only mirrors a pane that is already open. */
  spec: PaneSpec | null
  /** What to show when there is nothing to mirror (no pane, and `spec` is null). */
  placeholder?: React.ReactNode
  onExit?: () => void
}

/** Size a pane gets when the Canvas starts it; the Terminals view refits it when it opens. */
const START_COLS = 120
const START_ROWS = 34

/**
 * A read-only, scaled-down copy of a terminal. It shares the pane (and its PTY) with the full
 * terminal view: it copies the PTY's size instead of fitting itself, so it never resizes what the
 * full view shows, and it scales the result down to fit its box.
 */
export function MiniTerminal({ paneId, spec, placeholder, onExit }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.4)
  const [status, setStatus] = useState<'loading' | 'live' | 'none' | 'exited' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const specKey = JSON.stringify(spec)

  useLayoutEffect(() => {
    if (!box.current || !host.current) return
    const outer = box.current
    const inner = host.current
    const measure = () => {
      const screen = inner.querySelector<HTMLElement>('.xterm-screen')
      if (!screen || !screen.offsetWidth || !outer.clientWidth) return
      setScale(Math.min(outer.clientWidth / screen.offsetWidth, outer.clientHeight / screen.offsetHeight))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(outer)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!host.current) return
    const t = new Terminal({
      fontFamily: deck().platform === 'win32' ? 'Cascadia Mono, Consolas, monospace' : 'SF Mono, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      theme: { ...THEME, cursor: THEME.background },
      cursorBlink: false,
      disableStdin: true,
      scrollback: 0,
      allowProposedApi: true,
    })
    t.open(host.current)
    let disposed = false
    let ready = false
    let replaySeq = 0
    const queued: [string, number][] = []
    const offData = deck().onPtyData(paneId, (d, seq) => {
      if (!ready) queued.push([d, seq])
      else if (seq > replaySeq) t.write(d)
    })
    const offSize = deck().onPtySize(paneId, (cols, rows) => t.resize(cols, rows))
    const offExit = deck().onPtyExit(paneId, () => {
      setStatus('exited')
      onExitRef.current?.()
    })
    let retry: ReturnType<typeof setTimeout> | undefined
    const offClosed = deck().onPtyClosed(paneId, () => {
      ready = false
      queued.length = 0
      t.reset()
      setStatus('loading')
      // Give a view that is reopening the pane (Reattach) the first go, at its own size.
      retry = setTimeout(() => void load().catch(() => setStatus('error')), 400)
    })
    const load = async () => {
      let r = await deck().ptyPeek(paneId)
      if (!r && spec) r = await deck().ptyOpen(paneId, spec, START_COLS, START_ROWS)
      if (disposed) return
      if (!r) {
        setStatus('none')
        return
      }
      if (!r.ok) {
        setStatus('error')
        setMessage(r.message ?? 'could not start the terminal')
        return
      }
      if (r.cols && r.rows) t.resize(r.cols, r.rows)
      if (r.replay) t.write(r.replay)
      replaySeq = r.seq
      ready = true
      for (const [d, seq] of queued) if (seq > replaySeq) t.write(d)
      queued.length = 0
      setStatus(r.exited ? 'exited' : 'live')
    }
    load().catch((e) => {
      if (disposed) return
      setStatus('error')
      setMessage(String(e))
    })
    return () => {
      disposed = true
      clearTimeout(retry)
      offClosed()
      offData()
      offSize()
      offExit()
      t.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, specKey])

  return (
    <div className="mini-term" ref={box}>
      <div className="mini-scale" ref={host} style={{ transform: `scale(${scale})` }} />
      {status === 'none' && <div className="mini-over">{placeholder}</div>}
      {status === 'error' && <div className="mini-over">{message}</div>}
      {status === 'exited' && <div className="mini-over dim">Detached</div>}
    </div>
  )
}
