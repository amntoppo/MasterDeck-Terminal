/**
 * Markdown as GitHub writes it in an issue, parsed to a small tree a view can draw without ever
 * building HTML from the text: headings, paragraphs (a line end is a line break, as in an issue),
 * bullet / numbered / task lists (nested), fenced code, quotes, rules, tables, and inline code,
 * bold, italic, strikethrough, links and images. Raw HTML is not run: `<img>` and `<br>` are read
 * as what they mean, comments are dropped, anything else stays text. Links and images keep only
 * addresses that are safe to open (`safeHref`, `safeImage`). With `html: false` (the user's notes) no
 * tag is read at all: `<img>`, `<br>` and comments stay the text they are.
 */

export interface MarkdownOptions {
  /** Read `<img>`, `<br>` and comments as GitHub does (default). False: every tag is text. */
  html?: boolean
}

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'image'; src: string; alt: string }

export interface ListItem {
  /** A task list item: checked or not. null: an ordinary item. */
  task: boolean | null
  c: Block[]
}

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }

/** An address a click may open: https, the only kind the app opens. Anything else (javascript:, file:, http:, a relative path) is null. */
export function safeHref(href: string): string | null {
  const h = href.trim()
  return /^https:\/\/[^\s]+$/i.test(h) ? h : null
}

/** An image address the view may load: https only. */
export function safeImage(src: string): string | null {
  const s = src.trim()
  return /^https:\/\/[^\s]+$/i.test(s) ? s : null
}

const SPECIAL = new Set(['\\', '\n', '`', '!', '[', '<', '*', '_', '~', 'h'])
// Every pattern below looks ahead a bounded distance: issue text is not ours, and an unbounded
// one tried at each mark of a long line takes time that grows with the square of its length.
const LINK = /^\[((?:[^[\]]|\[[^[\]]{0,300}\]){0,500})\]\(\s{0,20}<?([^)\s>]{0,2000})>?(?:\s{1,20}(?:"[^"]{0,500}"|'[^']{0,500}'))?\s{0,20}\)/
const IMAGE = /^!\[([^\]]{0,500})\]\(\s{0,20}<?([^)\s>]{0,2000})>?(?:\s{1,20}(?:"[^"]{0,500}"|'[^']{0,500}'))?\s{0,20}\)/
const attr = (tag: string, name: string): string => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find((x) => x !== undefined) ?? ''

export function parseInline(src: string, depth = 0, html = true): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const text = (s: string) => {
    buf += s
  }
  const push = (n: Inline) => {
    if (buf) out.push({ t: 'text', v: buf })
    buf = ''
    out.push(n)
  }
  const inner = (s: string) => (depth < 6 ? parseInline(s, depth + 1, html) : [{ t: 'text', v: s } as Inline])
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (!SPECIAL.has(ch)) {
      buf += ch
      i++
      continue
    }
    const rest = src.slice(i)
    let m: RegExpExecArray | null
    if (ch === '\\' && /^\\[\\`*_{}[\]()#+\-.!~|<>]/.test(rest)) {
      text(src[i + 1])
      i += 2
      continue
    }
    if (ch === '\n') {
      buf = buf.trimEnd()
      push({ t: 'br' })
      i++
      continue
    }
    if (ch === '`' && (m = /^(`{1,10})(?!`)([\s\S]{0,5000}?[^`])\1(?!`)/.exec(rest))) {
      push({ t: 'code', v: m[2].replace(/\n/g, ' ').replace(/^ (.*) $/, '$1') })
    } else if (ch === '!' && (m = IMAGE.exec(rest))) {
      const s = safeImage(m[2])
      if (s) push({ t: 'image', src: s, alt: m[1] })
      // A note shows what was typed; an issue only the words.
      else text(html ? m[1] || m[2] : m[0])
    } else if (ch === '[' && (m = LINK.exec(rest))) {
      const h = safeHref(m[2])
      if (h) push({ t: 'link', href: h, c: inner(m[1]) })
      else if (!html) text(m[0])
      else for (const n of inner(m[1])) n.t === 'text' ? text(n.v) : push(n)
    } else if (html && ch === '<' && (m = /^<!--[\s\S]{0,5000}?-->/.exec(rest))) {
      // A comment: an issue template's hint to its author, never shown.
    } else if (html && ch === '<' && (m = /^<br\s{0,5}\/?>/i.exec(rest))) {
      push({ t: 'br' })
    } else if (html && ch === '<' && (m = /^<img\b[^>]{0,2000}>/i.exec(rest))) {
      const s = safeImage(attr(m[0], 'src'))
      if (s) push({ t: 'image', src: s, alt: attr(m[0], 'alt') })
      else text(m[0])
    } else if (ch === '<' && (m = /^<(https:\/\/[^\s<>]+)>/i.exec(rest))) {
      push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] })
    } else if (ch === 'h' && !/[A-Za-z0-9]/.test(buf.slice(-1)) && (m = /^https:\/\/[^\s<>]+/i.exec(rest))) {
      // A bare address; what ends the sentence around it is not part of it.
      const url = m[0].replace(/[.,;:!?'"]+$/, '').replace(/\)+$/, (p) => (m![0].includes('(') ? p : ''))
      m = [url] as unknown as RegExpExecArray
      push({ t: 'link', href: url, c: [{ t: 'text', v: url }] })
    } else if ((ch === '*' || ch === '_') && (m = /^(\*\*|__)(?=\S)([\s\S]{0,1000}?\S)\1/.exec(rest)) && wordEdge(ch, buf, rest, m[0].length)) {
      push({ t: 'strong', c: inner(m[2]) })
    } else if ((ch === '*' || ch === '_') && (m = /^([*_])(?=\S)([\s\S]{0,1000}?\S)\1/.exec(rest)) && m[2] !== ch && wordEdge(ch, buf, rest, m[0].length)) {
      push({ t: 'em', c: inner(m[2]) })
    } else if (ch === '~' && (m = /^~~(?=\S)([\s\S]{0,1000}?\S)~~/.exec(rest))) {
      push({ t: 'del', c: inner(m[1]) })
    } else {
      text(ch)
      i++
      continue
    }
    i += m![0].length
  }
  if (buf) out.push({ t: 'text', v: buf })
  return out
}

/** `_` marks emphasis only at a word's edge (snake_case_names stay as typed); `*` anywhere. */
function wordEdge(ch: string, before: string, rest: string, len: number): boolean {
  if (ch !== '_') return true
  return !/[A-Za-z0-9]/.test(before.slice(-1)) && !/^[A-Za-z0-9]/.test(rest.slice(len, len + 1))
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEAD_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?: +(.*)|\s*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const SEP_RE = /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?$/

/** The line that opens fenced code: its fence and the language named after it. A backtick fence cannot have a backtick after it. */
function fence(l: string): { mark: string; lang: string } | null {
  const m = FENCE_RE.exec(l)
  if (!m) return null
  const info = m[2].trim()
  if (m[1][0] === '`' && info.includes('`')) return null
  return { mark: m[1], lang: info.split(/\s/)[0] }
}

/** A heading line: its level and its text, without the closing `#`s some write after it. */
function heading(l: string): { level: number; text: string } | null {
  const m = HEAD_RE.exec(l)
  if (!m) return null
  let t = (m[2] ?? '').trim()
  let end = t.length
  while (end > 0 && t[end - 1] === '#') end--
  if (end < t.length && (end === 0 || t[end - 1] === ' ' || t[end - 1] === '\t')) t = t.slice(0, end).trimEnd()
  return { level: m[1].length, text: t }
}

/** The line under a table's header: `|---|:-:|`. */
const separator = (l: string): boolean => SEP_RE.test(l.trim())
const blank = (l: string) => l.trim() === ''
const indent = (l: string) => /^ */.exec(l)![0].length

function cells(row: string): string[] {
  const r = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** Does this line start a block that ends the paragraph above it? (A numbered list only from 1, as in CommonMark.) */
function startsBlock(l: string): boolean {
  if (fence(l) || heading(l) || HR.test(l) || QUOTE.test(l)) return true
  const m = ITEM.exec(l)
  return !!m && m[3] !== undefined && (!/\d/.test(m[2]) || /^1[.)]$/.test(m[2]))
}

/** Text over this size is shown as one paragraph: nothing an issue holds needs more, and parsing stays quick. */
export const MAX_MARKDOWN = 200_000

export function parseMarkdown(src: string, opts: MarkdownOptions = {}): Block[] {
  if (src.length > MAX_MARKDOWN) return [{ t: 'para', c: [{ t: 'text', v: src }] }]
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)))
  return blocks(lines, 0, opts.html !== false)
}

function blocks(lines: string[], depth: number, html: boolean): Block[] {
  const out: Block[] = []
  const inl = (s: string) => parseInline(s, 0, html)
  if (depth > 8) return lines.some((l) => !blank(l)) ? [{ t: 'para', c: inl(lines.join('\n').trim()) }] : out
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    let m: RegExpExecArray | null
    const f = fence(l)
    const h = f ? null : heading(l)
    if (blank(l)) {
      i++
    } else if (html && /^\s*<!--/.test(l) && !/-->\s*\S/.test(l)) {
      // A comment on its own lines (an issue template's hint): skipped up to where it closes.
      while (i < lines.length && !lines[i].includes('-->')) i++
      i++
    } else if (f) {
      const close = new RegExp(`^ {0,3}${f.mark[0]}{${f.mark.length},}\\s*$`)
      const body: string[] = []
      const pad = indent(l)
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i].slice(Math.min(pad, indent(lines[i]))))
      i++
      out.push({ t: 'code', lang: f.lang, v: body.join('\n') })
    } else if (HR.test(l)) {
      out.push({ t: 'hr' })
      i++
    } else if (h) {
      out.push({ t: 'heading', level: h.level, c: inl(h.text) })
      i++
    } else if (QUOTE.test(l)) {
      const body: string[] = []
      for (; i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines[i])); i++)
        body.push(QUOTE.exec(lines[i])?.[1] ?? lines[i])
      out.push({ t: 'quote', c: blocks(body, depth + 1, html) })
    } else if ((m = ITEM.exec(l))) {
      const ordered = /\d/.test(m[2])
      const list: Block & { t: 'list' } = { t: 'list', ordered, start: ordered ? parseInt(m[2], 10) : 1, items: [] }
      while (i < lines.length && (m = ITEM.exec(lines[i])) && /\d/.test(m[2]) === ordered && !HR.test(lines[i])) {
        const width = m[1].length + m[2].length + 1
        const body = [m[3] ?? '']
        for (i++; i < lines.length; i++) {
          const x = lines[i]
          if (blank(x)) {
            // A blank line stays in the item only when what follows is still indented under it.
            let j = i
            while (j < lines.length && blank(lines[j])) j++
            if (j < lines.length && indent(lines[j]) >= width) body.push('')
            else break
          } else if (indent(x) >= width) body.push(x.slice(width))
          else if (startsBlock(x) || ITEM.test(x)) break
          else body.push(x.trim())
        }
        const task = /^\[([ xX])\](?:\s+|$)/.exec(body[0])
        if (task) body[0] = body[0].slice(task[0].length)
        list.items.push({ task: task ? task[1] !== ' ' : null, c: blocks(body, depth + 1, html) })
        while (i < lines.length && blank(lines[i])) i++
      }
      out.push(list)
    } else if (l.includes('|') && i + 1 < lines.length && separator(lines[i + 1]) && cells(l).length === cells(lines[i + 1]).length) {
      const head = cells(l).map(inl)
      const rows: Inline[][][] = []
      for (i += 2; i < lines.length && !blank(lines[i]) && lines[i].includes('|'); i++) {
        const r = cells(lines[i]).slice(0, head.length)
        while (r.length < head.length) r.push('')
        rows.push(r.map(inl))
      }
      out.push({ t: 'table', head, rows })
    } else {
      const body = [l.trim()]
      for (i++; i < lines.length && !blank(lines[i]) && !startsBlock(lines[i]); i++) body.push(lines[i].trim())
      const c = inl(body.join('\n'))
      // A line that held only a comment leaves no empty line behind.
      while (c[0]?.t === 'br') c.shift()
      while (c[c.length - 1]?.t === 'br') c.pop()
      if (c.length) out.push({ t: 'para', c })
    }
  }
  return out
}

function inlineText(c: Inline[]): string {
  return c.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : n.t === 'image' ? n.alt : inlineText(n.c))).join('')
}

function blockText(b: Block): string {
  switch (b.t) {
    case 'heading':
    case 'para':
      return inlineText(b.c)
    case 'code':
      return b.v
    case 'quote':
      return b.c.map(blockText).join(' ')
    case 'list':
      return b.items.map((it) => (it.task === null ? '' : it.task ? '☑ ' : '☐ ') + it.c.map(blockText).join(' ')).join(' · ')
    case 'table':
      return [b.head, ...b.rows].map((r) => r.map(inlineText).join(' | ')).join(' · ')
    case 'hr':
      return ''
  }
}

/** Markdown read as one line of plain text (marks, link addresses and tags gone; `html: false`): a short preview of it. */
export function markdownText(src: string): string {
  return parseMarkdown(src, { html: false }).map(blockText).join(' ').replace(/\s+/g, ' ').trim()
}
