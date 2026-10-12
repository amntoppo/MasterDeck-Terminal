import { describe, expect, it } from 'vitest'
import { escapeHtml, highlightLines, HIGHLIGHT_MAX_BYTES } from './highlight'

describe('highlightLines', () => {
  it('gives one line of HTML per line of text', () => {
    const lines = highlightLines('const a = 1\n// two\nlet b = "x"\n', 'typescript')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('hljs-keyword')
    expect(lines[3]).toBe('')
  })
  it('escapes markup in the code', () => {
    const lines = highlightLines('<script>alert(1)</script>', 'javascript')
    expect(lines.join('')).not.toContain('<script>')
    expect(lines.join('')).toContain('&lt;script&gt;')
  })
  it('closes and reopens spans that cross a line end', () => {
    const lines = highlightLines('/* one\ntwo */ x', 'javascript')
    expect(lines[0]).toMatch(/^<span class="hljs-comment">\/\* one<\/span>$/)
    expect(lines[1]).toMatch(/^<span class="hljs-comment">two \*\/<\/span> x$/)
  })
  it('falls back to escaped text for no or an unknown language, and for big files', () => {
    expect(highlightLines('a < b', null)).toEqual(['a &lt; b'])
    expect(highlightLines('a < b', 'no-such-language')).toEqual(['a &lt; b'])
    const big = 'x\n'.repeat(HIGHLIGHT_MAX_BYTES / 2 + 1)
    expect(highlightLines(big, 'typescript')[0]).toBe('x')
  })
  it('highlights Dockerfiles and Makefiles', () => {
    expect(highlightLines('FROM node:20', 'dockerfile')[0]).toContain('hljs-')
    expect(highlightLines('all:\n\techo hi', 'makefile').join('')).toContain('hljs-')
  })
})

describe('escapeHtml', () => {
  it('escapes the five characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })
})
