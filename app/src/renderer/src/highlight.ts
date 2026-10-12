import hljs from 'highlight.js/lib/common'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

hljs.registerLanguage('dockerfile', dockerfile)

/**
 * Above this a file is shown as plain text: highlighting is synchronous and a huge file would hold
 * the window. ponytail: highlight in a worker if large files need colour.
 */
export const HIGHLIGHT_MAX_BYTES = 300_000

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c])

/**
 * A file's text as one HTML string per line (highlight.js's output: its spans around escaped
 * text), each line closing the spans it opened and reopening the ones carried over, so every line
 * stands alone next to its number.
 */
export function highlightLines(text: string, lang: string | null): string[] {
  if (!lang || !hljs.getLanguage(lang) || text.length > HIGHLIGHT_MAX_BYTES) return text.split('\n').map(escapeHtml)
  const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  const out: string[] = []
  const open: string[] = []
  let line = ''
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue
    if (part === '\n') {
      out.push(line + '</span>'.repeat(open.length))
      line = open.join('')
    } else if (part.startsWith('<span')) {
      open.push(part)
      line += part
    } else if (part === '</span>') {
      open.pop()
      line += part
    } else line += part
  }
  out.push(line + '</span>'.repeat(open.length))
  // A line that only reopens and closes spans is empty.
  return out.map((l) => (l.replace(/<span[^>]*>|<\/span>/g, '') === '' ? '' : l))
}
