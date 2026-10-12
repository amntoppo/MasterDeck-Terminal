import { describe, expect, it } from 'vitest'
import { blend, contrast, DARK, isThemePref, LIGHT, parseColor, resolveTheme, THEMES, themeVars, TOKENS, xtermTheme, type Token } from './themes'

describe('themes', () => {
  it('every theme names every token with a colour', () => {
    for (const t of Object.values(THEMES)) {
      expect(Object.keys(t.tokens).sort()).toEqual([...TOKENS].sort())
      for (const k of TOKENS) expect(() => parseColor(t.tokens[k]), `${t.id} ${k}`).not.toThrow()
    }
  })

  it('resolves a preference', () => {
    expect(resolveTheme('light', true)).toBe(LIGHT)
    expect(resolveTheme('dark', false)).toBe(DARK)
    expect(resolveTheme('system', true)).toBe(DARK)
    expect(resolveTheme('system', false)).toBe(LIGHT)
    expect(isThemePref('system')).toBe(true)
    expect(isThemePref('light')).toBe(true)
    expect(isThemePref('toString')).toBe(false)
    expect(isThemePref(undefined)).toBe(false)
  })

  it('writes CSS variables and an xterm theme', () => {
    expect(themeVars(DARK)['--bg']).toBe('#0b0c0f')
    expect(xtermTheme(LIGHT).background).toBe('#ffffff')
    expect(xtermTheme(DARK).brightWhite).toBe('#ffffff')
  })

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
    expect(blend('rgba(0, 0, 0, 0.5)', '#ffffff')).toBe('#808080')
  })
})

/** WCAG AA in the light theme (#105): text 4.5:1, meaningful UI boundaries 3:1. */
describe('light theme contrast (WCAG AA)', () => {
  const k = LIGHT.tokens
  const surfaces: Token[] = ['bg', 'bg-2', 'bg-3', 'bg-4']
  const texts: Token[] = ['text', 'text-2', 'text-3', 'muted', 'faint']
  const hues: Token[] = ['accent', 'green', 'green-2', 'amber', 'red', 'purple', 'purple-2', 'grey', 'orange', 'teal', 'aqua', 'violet', 'claude']
  const fails: string[] = []
  const need = (what: string, fg: string, bg: string, min: number) => {
    const r = contrast(fg, bg)
    if (r < min) fails.push(`${what}: ${r.toFixed(2)} < ${min}`)
  }

  it('text and hues as text on every surface', () => {
    for (const s of surfaces) {
      for (const t of [...texts, ...hues]) need(`${t} on ${s}`, k[t], k[s], 4.5)
      // The accent tint (selected rows, chips) under body text.
      for (const t of texts) need(`${t} on accent-soft over ${s}`, k[t], blend(k['accent-soft'], k[s]), 4.5)
    }
    expect(fails).toEqual([])
  })

  it('text on solid hue fills (buttons, badges, kind tags)', () => {
    fails.length = 0
    for (const h of ['accent', 'green', 'amber', 'red', 'purple', 'grey', 'orange', 'teal'] as Token[]) need(`on-accent on ${h}`, k['on-accent'], k[h], 4.5)
    need('on-mark on mark', k['on-mark'], k.mark, 4.5)
    // A switch's thumb against its track, off and on (a UI component: 3:1).
    need('knob on line-3', k.knob, k['line-3'], 3)
    need('knob on green', k.knob, k.green, 3)
    need('on-mark on mark-soft', k['on-mark'], blend(k['mark-soft'], k.bg), 4.5)
    expect(fails).toEqual([])
  })

  it('status badges: a hue on its own tint', () => {
    fails.length = 0
    // .badge.* draws color-mix(hue 16%, transparent) on a card (bg-3) or a panel (bg-2).
    for (const s of ['bg-2', 'bg-3'] as Token[]) for (const h of hues) need(`${h} on its tint over ${s}`, k[h], blend(k[h], k[s], 0.18), 4.5)
    expect(fails).toEqual([])
  })

  it('focus, selection and form borders are visible', () => {
    fails.length = 0
    for (const s of surfaces) need(`accent boundary on ${s}`, k.accent, k[s], 3)
    for (const s of ['bg', 'bg-2'] as Token[]) need(`line-3 (hovered border) on ${s}`, k['line-3'], k[s], 3)
    expect(fails).toEqual([])
  })

  it('terminal: foreground and the normal ANSI colours on its background', () => {
    fails.length = 0
    need('term-fg', k['term-fg'], k['term-bg'], 4.5)
    for (const c of ['term-red', 'term-green', 'term-yellow', 'term-blue', 'term-magenta', 'term-cyan', 'term-black', 'term-bright-black'] as Token[]) need(c, k[c], k['term-bg'], 4.5)
    need('term-fg on selection', k['term-fg'], blend(k['term-selection'], k['term-bg']), 4.5)
    expect(fails).toEqual([])
  })
})
