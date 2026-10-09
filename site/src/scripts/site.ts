// Every page's behaviour. Each part looks for its own markup and does nothing without it, and
// the pages read fine before (or without) this script.

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll<T>(s)]

// ---------- theme ----------
$('[data-theme-toggle]')?.addEventListener('click', () => {
  const root = document.documentElement
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  root.dataset.theme = dark ? 'light' : 'dark'
  try { localStorage.setItem('theme', root.dataset.theme) } catch {}
})

// ---------- header ----------
const header = $('[data-header]')
const onScroll = () => header?.classList.toggle('scrolled', scrollY > 8)
addEventListener('scroll', onScroll, { passive: true })
onScroll()

const menu = $('[data-menu]')
const mobile = $('[data-mobile-nav]')
menu?.addEventListener('click', () => {
  const open = !mobile?.classList.contains('open')
  mobile?.classList.toggle('open', open)
  menu.setAttribute('aria-expanded', String(open))
})
$$('a', mobile ?? document.createElement('div')).forEach((a) =>
  a.addEventListener('click', () => {
    mobile?.classList.remove('open')
    menu?.setAttribute('aria-expanded', 'false')
  }),
)

// ---------- copy buttons ----------
$$('[data-copy]').forEach((b) =>
  b.addEventListener('click', async () => {
    const text = b.dataset.copy ?? ''
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    const label = b.querySelector('span')
    const was = label?.textContent
    b.setAttribute('data-copied', '')
    if (label) label.textContent = 'Copied'
    setTimeout(() => {
      b.removeAttribute('data-copied')
      if (label && was) label.textContent = was
    }, 1600)
  }),
)

// ---------- reveals ----------
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.classList.add('in')
      io.unobserve(e.target)
    }
  },
  { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
)
$$('[data-reveal]').forEach((el) => (reduced ? el.classList.add('in') : io.observe(el)))

// Headline words rise in one after another.
$$('[data-split]').forEach((el) => {
  if (reduced) return
  const walk = (node: Node, n: { i: number }) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment()
        for (const part of (child.textContent ?? '').split(/(\s+)/)) {
          if (!part) continue
          if (/^\s+$/.test(part)) { frag.append(part); continue }
          const s = document.createElement('span')
          s.className = 'split-word'
          s.style.setProperty('--w', String(n.i++))
          s.textContent = part
          frag.append(s)
        }
        child.replaceWith(frag)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const elc = child as HTMLElement
        // A gradient word keeps its own span so the gradient spans the word.
        if (elc.classList.contains('grad')) {
          elc.classList.add('split-word')
          elc.style.setProperty('--w', String(n.i++))
        } else walk(child, n)
      }
    }
  }
  walk(el, { i: 0 })
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('split-done')))
})

// ---------- spotlight cards ----------
$$('.card').forEach((c) =>
  c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect()
    c.style.setProperty('--mx', `${e.clientX - r.left}px`)
    c.style.setProperty('--my', `${e.clientY - r.top}px`)
  }),
)

// ---------- scroll-linked: hero tilt, step line ----------
const heroWin = $('.hero-window')
const steps = $('.steps')
let ticking = false
const linked = () => {
  ticking = false
  if (heroWin && !reduced && innerWidth > 760) {
    const p = Math.min(1, Math.max(0, scrollY / (innerHeight * 0.7)))
    heroWin.style.setProperty('--tilt', `${18 * (1 - p)}deg`)
    heroWin.style.setProperty('--zoom', String(0.94 + 0.06 * p))
  }
  if (steps) {
    const r = steps.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, (innerHeight * 0.85 - r.top) / (r.height + innerHeight * 0.3)))
    steps.style.setProperty('--p', String(reduced ? 1 : p))
  }
}
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(linked) } }, { passive: true })
linked()

// ---------- hero terminal ----------
type Line = { t: string; c?: string; pause?: number }
const term = $('[data-term]')
if (term) {
  const script: Line[] = JSON.parse(term.dataset.term ?? '[]')
  const out = term
  const caret = document.createElement('span')
  caret.className = 'caret'
  const run = async () => {
    out.textContent = ''
    for (const line of script) {
      const el = document.createElement('div')
      el.className = `l ${line.c ?? ''}`
      out.append(el)
      el.append(caret)
      const typed = line.t.startsWith('› ')
      if (typed && !reduced) {
        for (const ch of line.t) {
          caret.before(ch)
          await sleep(18 + Math.random() * 40)
        }
      } else {
        caret.before(line.t)
      }
      await sleep(reduced ? 0 : line.pause ?? 380)
    }
    if (!reduced) {
      await sleep(4200)
      run()
    }
  }
  // Start when it scrolls into view, once.
  const tio = new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting)) { tio.disconnect(); run() }
  })
  tio.observe(out)
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

// ---------- product tour (sticky screens follow the step in view) ----------
const tourSteps = $$('[data-tour-step]')
if (tourSteps.length) {
  const shots = $$('[data-tour-shot]')
  const dots = $$('[data-tour-dot]')
  const show = (i: number) => {
    tourSteps.forEach((s, j) => s.classList.toggle('active', i === j))
    shots.forEach((s, j) => s.classList.toggle('on', i === j))
    dots.forEach((s, j) => s.classList.toggle('on', i === j))
  }
  const tio = new IntersectionObserver(
    (es) => {
      for (const e of es) if (e.isIntersecting) show(tourSteps.indexOf(e.target as HTMLElement))
    },
    { rootMargin: '-45% 0px -45% 0px' },
  )
  tourSteps.forEach((s) => tio.observe(s))
  show(0)
}

// ---------- workflow playground: drag the blocks, the arrows follow ----------
const pg = $('[data-playground]')
if (pg) {
  const edgesSvg = $<SVGSVGElement>('svg.edges', pg)!
  const nodes = new Map($$('[data-node]', pg).map((n) => [n.dataset.node!, n]))
  const edges: { from: string; to: string; kind: string; path: SVGPathElement }[] = JSON.parse(pg.dataset.edges ?? '[]').map(
    (e: { from: string; to: string; kind: string }) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('class', `${e.kind} flow`)
      edgesSvg.append(path)
      return { ...e, path }
    },
  )
  // Positions are fractions of the canvas, so the layout scales with its width.
  // A narrow canvas has its own two-column layout, and its arrows run top to bottom.
  const pos = new Map<string, { x: number; y: number }>()
  let compact: boolean | null = null

  const layout = () => {
    const W = pg.clientWidth, H = pg.clientHeight
    if (compact !== W < 600) {
      compact = W < 600
      nodes.forEach((n, id) =>
        pos.set(id, compact ? { x: +n.dataset.mx!, y: +n.dataset.my! } : { x: +n.dataset.x!, y: +n.dataset.y! }),
      )
    }
    nodes.forEach((n, id) => {
      const p = pos.get(id)!
      const x = Math.min(Math.max(0, p.x * W - n.offsetWidth / 2), W - n.offsetWidth)
      const y = Math.min(Math.max(44, p.y * H - n.offsetHeight / 2), H - n.offsetHeight)
      n.style.transform = `translate(${x}px, ${y}px)`
      n.dataset.px = String(x)
      n.dataset.py = String(y)
    })
    for (const e of edges) {
      const a = nodes.get(e.from)!, b = nodes.get(e.to)!
      const ax = +a.dataset.px!, ay = +a.dataset.py!, bx = +b.dataset.px!, by = +b.dataset.py!
      if (e.kind === 'loop' && compact) {
        // Out of the loop's right side and back into the start's right side.
        const x1 = ax + a.offsetWidth, y1 = ay + a.offsetHeight / 2
        const x2 = bx + b.offsetWidth, y2 = by + b.offsetHeight / 2
        const out = Math.max(x1, x2) + 18
        e.path.setAttribute('d', `M${x1},${y1} C${out},${y1} ${out},${y2} ${x2},${y2}`)
        continue
      }
      if (e.kind === 'loop') {
        // Back from the end of the loop to its start, under both blocks.
        const x1 = ax + a.offsetWidth / 2, y1 = ay + a.offsetHeight
        const x2 = bx + b.offsetWidth / 2, y2 = by + b.offsetHeight
        const dip = Math.max(y1, y2) + 56
        e.path.setAttribute('d', `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2}`)
        continue
      }
      if (compact && Math.abs(by - ay) > a.offsetHeight) {
        const x1 = ax + a.offsetWidth / 2, y1 = ay + a.offsetHeight
        const x2 = bx + b.offsetWidth / 2, y2 = by
        const dy = Math.max(30, Math.abs(y2 - y1) / 2)
        e.path.setAttribute('d', `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`)
        continue
      }
      const x1 = ax + a.offsetWidth, y1 = ay + a.offsetHeight / 2
      const x2 = bx, y2 = by + b.offsetHeight / 2
      const dx = Math.max(40, Math.abs(x2 - x1) / 2)
      e.path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`)
    }
  }

  let drag: { id: string; n: HTMLElement; ox: number; oy: number } | null = null
  nodes.forEach((n, id) => {
    n.addEventListener('pointerdown', (e) => {
      const r = n.getBoundingClientRect()
      drag = { id, n, ox: e.clientX - r.left - r.width / 2, oy: e.clientY - r.top - r.height / 2 }
      n.setPointerCapture(e.pointerId)
      n.classList.add('drag')
    })
    n.addEventListener('pointermove', (e) => {
      if (!drag || drag.n !== n) return
      const r = pg.getBoundingClientRect()
      pos.set(id, { x: (e.clientX - r.left - drag.ox) / r.width, y: (e.clientY - r.top - drag.oy) / r.height })
      layout()
    })
    const end = () => { n.classList.remove('drag'); drag = null }
    n.addEventListener('pointerup', end)
    n.addEventListener('pointercancel', end)
    // Keyboard: arrows move a focused block.
    n.addEventListener('keydown', (e) => {
      const step = 0.02
      const p = pos.get(id)!
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (!d[e.key]) return
      e.preventDefault()
      pos.set(id, { x: p.x + d[e.key][0], y: p.y + d[e.key][1] })
      layout()
    })
  })

  // A pulse walks the flow so the canvas reads as running.
  const order = (pg.dataset.order ?? '').split(',')
  let k = 0
  if (!reduced) setInterval(() => {
    nodes.forEach((n) => n.classList.remove('lit'))
    nodes.get(order[k % order.length])?.classList.add('lit')
    k++
  }, 900)

  new ResizeObserver(layout).observe(pg)
  layout()
}

// ---------- docs: table of contents follows the section in view ----------
const tocLinks = $$<HTMLAnchorElement>('.toc a')
if (tocLinks.length) {
  const byId = new Map(tocLinks.map((a) => [a.hash.slice(1), a]))
  const sio = new IntersectionObserver(
    (es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue
        tocLinks.forEach((a) => a.classList.remove('on'))
        byId.get(e.target.id)?.classList.add('on')
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  )
  byId.forEach((_, id) => { const s = document.getElementById(id); if (s) sio.observe(s) })
}

// ---------- download: point at this visitor's build ----------
const dls = $$('[data-os]')
if (dls.length) {
  const ua = navigator.userAgent
  const os = /Windows/.test(ua) ? 'win' : /Mac/.test(ua) ? 'mac-arm' : ''
  // Browsers report Intel for every Mac; Apple silicon is the likely one today, both are offered.
  dls.forEach((d) => d.classList.toggle('mine', d.dataset.os === os))
}
