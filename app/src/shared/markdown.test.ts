import { describe, expect, it } from 'vitest'
import { MAX_MARKDOWN, parseInline, parseMarkdown, safeHref, safeImage, type Block, type Inline } from './markdown'

const t = (v: string): Inline => ({ t: 'text', v })
const p = (...c: Inline[]): Block => ({ t: 'para', c })

describe('parseInline', () => {
  it('reads code, bold, italic and strikethrough', () => {
    expect(parseInline('a `b*c*` **d** *e* ~~f~~ __g__ _h_')).toEqual([
      t('a '), { t: 'code', v: 'b*c*' }, t(' '), { t: 'strong', c: [t('d')] }, t(' '), { t: 'em', c: [t('e')] }, t(' '),
      { t: 'del', c: [t('f')] }, t(' '), { t: 'strong', c: [t('g')] }, t(' '), { t: 'em', c: [t('h')] },
    ])
  })
  it('leaves snake_case, lone marks and escapes as typed', () => {
    expect(parseInline('snake_case_name and 2 * 3 * 4')).toEqual([t('snake_case_name and 2 * 3 * 4')])
    expect(parseInline('\\*not\\* \\`code\\`')).toEqual([t('*not* `code`')])
    expect(parseInline('`<number>-<slug>`')).toEqual([{ t: 'code', v: '<number>-<slug>' }])
  })
  it('nests marks', () => {
    expect(parseInline('**a *b* `c`**')).toEqual([{ t: 'strong', c: [t('a '), { t: 'em', c: [t('b')] }, t(' '), { t: 'code', v: 'c' }] }])
  })
  it('reads links, bare addresses and autolinks', () => {
    expect(parseInline('[the **doc**](https://acme.test/a "title")')).toEqual([{ t: 'link', href: 'https://acme.test/a', c: [t('the '), { t: 'strong', c: [t('doc')] }] }])
    expect(parseInline('see https://acme.test/x_y?a=1, then <https://acme.test/z>.')).toEqual([
      t('see '), { t: 'link', href: 'https://acme.test/x_y?a=1', c: [t('https://acme.test/x_y?a=1')] }, t(', then '),
      { t: 'link', href: 'https://acme.test/z', c: [t('https://acme.test/z')] }, t('.'),
    ])
    expect(parseInline('(https://acme.test/a)')).toEqual([t('('), { t: 'link', href: 'https://acme.test/a', c: [t('https://acme.test/a')] }, t(')')])
  })
  it('keeps only addresses that are safe to open', () => {
    // The address is dropped, its words stay (here with the bracket the address ended at).
    expect(parseInline('[x](javascript:alert(1))')).toEqual([t('x)')])
    expect(parseInline('[x](file:///etc/passwd) [y](../up)')).toEqual([t('x y')])
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull()
    expect(safeHref(' data:text/html,x')).toBeNull()
    expect(safeHref('mailto:a@acme.test')).toBeNull()
    expect(safeHref('http://acme.test')).toBeNull()
    expect(parseInline('http://acme.test <http://acme.test>')).toEqual([t('http://acme.test <http://acme.test>')])
    expect(safeHref('https://acme.test/a')).toBe('https://acme.test/a')
    expect(safeImage('http://acme.test/a.png')).toBeNull()
    expect(safeImage('data:image/png;base64,AAAA')).toBeNull()
  })
  it('reads images, as Markdown and as the <img> GitHub writes for an upload', () => {
    expect(parseInline('![a shot](https://acme.test/a.png)')).toEqual([{ t: 'image', src: 'https://acme.test/a.png', alt: 'a shot' }])
    expect(parseInline('<img width="400" alt="Shot" src="https://acme.test/b.png">')).toEqual([{ t: 'image', src: 'https://acme.test/b.png', alt: 'Shot' }])
    expect(parseInline('![x](javascript:1)')).toEqual([t('x')])
  })
  it('never runs HTML: it stays text, comments go, <br> breaks the line', () => {
    expect(parseInline('<script>alert(1)</script> <b>x</b>')).toEqual([t('<script>alert(1)</script> <b>x</b>')])
    expect(parseInline('a<!-- hint -->b<br>c')).toEqual([t('ab'), { t: 'br' }, t('c')])
    expect(parseInline('<img src="javascript:1" onerror="x">')).toEqual([t('<img src="javascript:1" onerror="x">')])
  })
  it('breaks the line where the text does', () => {
    expect(parseInline('a  \nb')).toEqual([t('a'), { t: 'br' }, t('b')])
  })
})

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and rules', () => {
    expect(parseMarkdown('# One\n\ntext\nmore\n\n---\n### Three ###\n#nothash')).toEqual([
      { t: 'heading', level: 1, c: [t('One')] }, p(t('text'), { t: 'br' }, t('more')), { t: 'hr' },
      { t: 'heading', level: 3, c: [t('Three')] }, p(t('#nothash')),
    ])
  })
  it('reads bullet, numbered and task lists', () => {
    expect(parseMarkdown('- a\n- b\n\n3. c\n4. d\n\n- [ ] todo\n- [x] done **now**')).toEqual([
      { t: 'list', ordered: false, start: 1, items: [{ task: null, c: [p(t('a'))] }, { task: null, c: [p(t('b'))] }] },
      { t: 'list', ordered: true, start: 3, items: [{ task: null, c: [p(t('c'))] }, { task: null, c: [p(t('d'))] }] },
      { t: 'list', ordered: false, start: 1, items: [{ task: false, c: [p(t('todo'))] }, { task: true, c: [p(t('done '), { t: 'strong', c: [t('now')] })] }] },
    ])
  })
  it('nests lists and keeps an item\'s own paragraphs and code', () => {
    const b = parseMarkdown('- a\n  - b\n    - c\n- d\n\n  more of d\n\n  ```\n  code\n  ```\n\nafter')
    expect(b).toEqual([
      {
        t: 'list', ordered: false, start: 1, items: [
          { task: null, c: [p(t('a')), { t: 'list', ordered: false, start: 1, items: [{ task: null, c: [p(t('b')), { t: 'list', ordered: false, start: 1, items: [{ task: null, c: [p(t('c'))] }] }] }] }] },
          { task: null, c: [p(t('d')), p(t('more of d')), { t: 'code', lang: '', v: 'code' }] },
        ],
      },
      p(t('after')),
    ])
  })
  it('reads the list under a paragraph, as an issue writes it', () => {
    expect(parseMarkdown('Do this:\n- one\n- two')).toEqual([
      p(t('Do this:')),
      { t: 'list', ordered: false, start: 1, items: [{ task: null, c: [p(t('one'))] }, { task: null, c: [p(t('two'))] }] },
    ])
    // A number that is not 1 does not cut a paragraph.
    expect(parseMarkdown('In\n2026. it')).toEqual([p(t('In'), { t: 'br' }, t('2026. it'))])
  })
  it('keeps code as typed, marks and all', () => {
    expect(parseMarkdown('```ts\nconst a = "**x**"\n\n  <b>\n```\n~~~\n```\n~~~')).toEqual([
      { t: 'code', lang: 'ts', v: 'const a = "**x**"\n\n  <b>' }, { t: 'code', lang: '', v: '```' },
    ])
    // Never closed: the rest is the code.
    expect(parseMarkdown('```\na\nb')).toEqual([{ t: 'code', lang: '', v: 'a\nb' }])
  })
  it('reads quotes and tables', () => {
    expect(parseMarkdown('> a\n> - b\n\n| x | y |\n|---|:-:|\n| 1 | `2` |\n| 3 |')).toEqual([
      { t: 'quote', c: [p(t('a')), { t: 'list', ordered: false, start: 1, items: [{ task: null, c: [p(t('b'))] }] }] },
      { t: 'table', head: [[t('x')], [t('y')]], rows: [[[t('1')], [{ t: 'code', v: '2' }]], [[t('3')], []]] },
    ])
  })
  it('drops a template\'s comment, on one line or many', () => {
    expect(parseMarkdown('<!-- describe\nthe bug -->\nIt broke.\n<!-- one -->')).toEqual([p(t('It broke.'))])
  })
  it('takes Windows line ends, an empty text and a huge one', () => {
    expect(parseMarkdown('a\r\n\r\nb')).toEqual([p(t('a')), p(t('b'))])
    expect(parseMarkdown('')).toEqual([])
    const big = 'x'.repeat(MAX_MARKDOWN + 1)
    expect(parseMarkdown(big)).toEqual([p(t(big))])
  })
  it('stays quick on long hostile lines (an issue body is up to 65 KB of anyone\'s text)', () => {
    const n = 65_000
    const hostile = [
      '# a' + ' '.repeat(n) + 'b',
      '~~~' + 'a'.repeat(n) + '`',
      '*a '.repeat(n / 3),
      '!['.repeat(n / 2),
      '~~a '.repeat(n / 4),
      '| a |\n' + ' '.repeat(n) + 'x',
      'a' + ' '.repeat(n) + 'x\nb',
      'h'.repeat(n),
      '_a'.repeat(n / 2),
      '`'.repeat(n) + 'a',
      '<!--'.repeat(n / 4),
      '['.repeat(n / 2) + '](',
      '#'.repeat(n) + 'a',
      '# ' + '#'.repeat(n) + 'a',
    ]
    for (const src of hostile) {
      const t0 = performance.now()
      parseMarkdown(src)
      expect(performance.now() - t0, src.slice(0, 12)).toBeLessThan(1500)
    }
  })
  it('does not hang or overflow on hostile nesting', () => {
    expect(parseMarkdown('> '.repeat(500) + 'x').length).toBe(1)
    expect(parseInline('*'.repeat(2000) + 'a').length).toBeGreaterThan(0)
    expect(parseInline('['.repeat(2000)).length).toBeGreaterThan(0)
  })
})
