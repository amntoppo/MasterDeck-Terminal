/** Web links in terminal output (⌘-click / Ctrl-click opens them in the browser). */

/** Longest address MasterDeck opens. */
export const LINK_MAX = 2048

/** An address the browser may open: http or https with a host, no spaces or control characters. */
export function isWebLink(url: unknown): url is string {
  // eslint-disable-next-line no-control-regex
  if (typeof url !== 'string' || url.length > LINK_MAX || /[\s\x00-\x1f\x7f]/.test(url)) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== ''
  } catch {
    return false
  }
}

export interface FoundUrl {
  url: string
  /** Offsets in the text: [start, end). */
  start: number
  end: number
}

// Up to a space, a quote, an angle bracket, a control character or box drawing (a TUI's border).
// eslint-disable-next-line no-control-regex
const URL_RE = /(?<![\w.+-])https?:\/\/[^\s"'`<>\x00-\x1f\x7f─-▟]+/gi
const TRAILING = /[.,;:!?*]$/
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

const count = (s: string, c: string) => s.split(c).length - 1

/** Drops punctuation that ends a sentence, and a closing bracket the address did not open. */
function trimUrl(s: string): string {
  for (;;) {
    const last = s[s.length - 1]
    if (TRAILING.test(s)) s = s.slice(0, -1)
    else if (OPENER[last] && count(s, OPENER[last]) < count(s, last)) s = s.slice(0, -1)
    else return s
  }
}

/** The http/https addresses in a line of terminal text (a wrapped line joined into one). */
export function findUrls(text: string): FoundUrl[] {
  const found: FoundUrl[] = []
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    if (!isWebLink(url)) continue
    const start = m.index ?? 0
    found.push({ url, start, end: start + url.length })
  }
  return found
}
