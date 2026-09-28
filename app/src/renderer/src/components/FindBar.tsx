import { useEffect, useRef, useState } from 'react'
import { terminalSearch } from './TerminalView'

/** What a find bar searches: a terminal's scrollback, or the text of a screen (Board, PRs). */
export type FindTarget = { kind: 'terminal'; paneId: string } | { kind: 'dom'; root: () => HTMLElement | null }

interface Result {
  index: number
  count: number
}

/** Terminal matches past this many are found but not all highlighted (xterm's limit). */
const TERMINAL_HIGHLIGHTS = 1000
/** Screen matches collected at most (a Board or PR list has far fewer). */
const DOM_MATCHES = 2000

/**
 * ⌘F: find in the terminal or screen on show. Terminals use xterm's search (it scans the
 * scrollback only when searching, and decorates at most 1000 matches); screens use the CSS Custom
 * Highlight API, which marks text without changing the page. Enter / ⇧Enter or ↑ ↓ move between
 * matches, Esc closes.
 */
export function FindBar({ target, onClose }: { target: FindTarget; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<Result>({ index: -1, count: 0 })
  const input = useRef<HTMLInputElement>(null)
  const dom = useRef<{ ranges: Range[]; at: number }>({ ranges: [], at: -1 })
  // The parent builds a new target object on every render: effects follow its identity, not the object.
  const tkey = target.kind === 'terminal' ? `t:${target.paneId}` : 'dom'
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [tkey])

  // Terminal: results come from the addon's event.
  useEffect(() => {
    if (target.kind !== 'terminal') return
    const s = terminalSearch(target.paneId)
    if (!s) return
    const off = s.onDidChangeResults((r) => setRes({ index: r.resultIndex, count: r.resultCount }))
    return () => {
      off.dispose()
      s.clearDecorations()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey])

  const termFind = (dir: 1 | -1, incremental = false) => {
    if (target.kind !== 'terminal') return
    const s = terminalSearch(target.paneId)
    if (!s) return
    if (!q) {
      s.clearDecorations()
      setRes({ index: -1, count: 0 })
      return
    }
    const opts = {
      incremental,
      decorations: {
        matchBackground: '#5a4a1a',
        matchOverviewRuler: '#d9a441',
        activeMatchBackground: '#d9a441',
        activeMatchColorOverviewRuler: '#ffcf6b',
      },
    }
    const found = dir > 0 ? s.findNext(q, opts) : s.findPrevious(q, opts)
    if (!found) setRes({ index: -1, count: 0 })
  }

  // Screens: collect the text ranges holding the query, and mark them.
  const domScan = () => {
    if (target.kind !== 'dom') return
    const root = target.root()
    const ranges: Range[] = []
    const needle = q.toLowerCase()
    if (root && needle) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest('.find-bar, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      })
      for (let n = walker.nextNode(); n && ranges.length < DOM_MATCHES; n = walker.nextNode()) {
        const text = n.nodeValue?.toLowerCase() ?? ''
        for (let i = text.indexOf(needle); i >= 0 && ranges.length < DOM_MATCHES; i = text.indexOf(needle, i + needle.length)) {
          const r = document.createRange()
          r.setStart(n, i)
          r.setEnd(n, i + needle.length)
          ranges.push(r)
        }
      }
    }
    const at = ranges.length ? Math.min(Math.max(dom.current.at, 0), ranges.length - 1) : -1
    dom.current = { ranges, at }
    paint()
  }
  const paint = () => {
    const { ranges, at } = dom.current
    const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (hl && H) {
      hl.set('md-find', new H(...ranges))
      if (at >= 0) hl.set('md-find-current', new H(ranges[at]))
      else hl.delete('md-find-current')
    }
    setRes({ index: at, count: ranges.length })
  }
  const domGo = (dir: 1 | -1) => {
    const d = dom.current
    if (!d.ranges.length) return
    d.at = (d.at + dir + d.ranges.length) % d.ranges.length
    paint()
    d.ranges[d.at].startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  }

  // Search as you type (debounced); screens rescan when they change (debounced).
  useEffect(() => {
    const id = setTimeout(() => {
      if (target.kind === 'terminal') termFind(1, true)
      else {
        dom.current.at = 0
        domScan()
        const r = dom.current.ranges[0]
        r?.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
      }
    }, 150)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tkey])
  useEffect(() => {
    const tg = targetRef.current
    if (tg.kind !== 'dom') return
    const root = tg.root()
    if (!root) return
    let t: ReturnType<typeof setTimeout> | undefined
    const mo = new MutationObserver((list) => {
      if (list.every((m) => (m.target as Element).closest?.('.find-bar'))) return
      clearTimeout(t)
      t = setTimeout(domScan, 300)
    })
    mo.observe(root, { subtree: true, childList: true, characterData: true })
    return () => {
      clearTimeout(t)
      mo.disconnect()
      const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
      hl?.delete('md-find')
      hl?.delete('md-find-current')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey, q])

  const go = (dir: 1 | -1) => (target.kind === 'terminal' ? termFind(dir) : domGo(dir))
  const label = !q ? '' : res.count === 0 ? 'No matches' : res.index < 0 ? `${res.count >= TERMINAL_HIGHLIGHTS ? `${TERMINAL_HIGHLIGHTS}+` : res.count} matches` : `${res.index + 1} / ${res.count}`

  return (
    <div className="find-bar" role="search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter') {
            e.preventDefault()
            go(e.shiftKey ? -1 : 1)
          }
        }}
        placeholder={target.kind === 'terminal' ? 'Find in terminal' : 'Find on this screen'}
        aria-label="Find"
        spellCheck={false}
      />
      <span className={`find-count ${q && res.count === 0 ? 'none' : ''}`}>{label}</span>
      <button className="find-btn" onClick={() => go(-1)} disabled={!res.count} aria-label="Previous match" title="Previous match  ⇧↵">
        ↑
      </button>
      <button className="find-btn" onClick={() => go(1)} disabled={!res.count} aria-label="Next match" title="Next match  ↵">
        ↓
      </button>
      <button className="find-btn" onClick={onClose} aria-label="Close find" title="Close  Esc">
        ×
      </button>
    </div>
  )
}
