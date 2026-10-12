/**
 * Themes: every colour MasterDeck draws comes from one of these token sets. The renderer writes a
 * theme's tokens on <html> as CSS custom properties (`--bg`, `--text` …) and CSS reads only
 * `var(--…)`; the terminal builds its xterm theme from the same object. A new theme is a new
 * `Theme` in THEMES (the type makes it name every token). See docs/THEMES.md.
 */

export const TOKENS = [
  // Surfaces, darkest to lightest in dark (lightest to darkest in light): page, panels, cards and hovers, raised.
  'bg',
  'bg-2',
  'bg-3',
  'bg-4',
  // Borders: hairline, stronger, hovered.
  'line',
  'line-2',
  'line-3',
  // Text: body, softer body (snippets, tool output), muted (labels, hints), faint (least important).
  'text',
  'text-2',
  'text-3',
  'muted',
  'faint',
  // The accent (selection, focus, links, primary buttons), its tint, and text on any solid hue fill.
  'accent',
  'accent-soft',
  'on-accent',
  // The thumb of a switch, on its track (line-3 off, green on).
  'knob',
  // Status and category hues; tints are color-mix() of these.
  'green',
  'green-2',
  'amber',
  'red',
  'purple',
  'purple-2',
  'grey',
  'orange',
  'teal',
  'aqua',
  'violet',
  'claude',
  // Overlays: dialog backdrop, drop shadows, the veil over a terminal.
  'scrim',
  'shadow',
  'veil',
  // Find highlights in screens.
  'mark',
  'mark-soft',
  'on-mark',
  // The terminal.
  'term-bg',
  'term-fg',
  'term-cursor',
  'term-selection',
  'term-black',
  'term-red',
  'term-green',
  'term-yellow',
  'term-blue',
  'term-magenta',
  'term-cyan',
  'term-white',
  'term-bright-black',
  'term-bright-red',
  'term-bright-green',
  'term-bright-yellow',
  'term-bright-blue',
  'term-bright-magenta',
  'term-bright-cyan',
  'term-bright-white',
  'term-match',
  'term-match-active',
  'term-match-ruler',
] as const

export type Token = (typeof TOKENS)[number]

export interface Theme {
  id: ThemeId
  label: string
  /** Native controls, scrollbars and `prefers-color-scheme` follow this. */
  scheme: 'light' | 'dark'
  tokens: Record<Token, string>
  /** xterm's minimumContrastRatio: lifts colours a program picked for another background (1 = off). */
  termMinContrast: number
}

export type ThemeId = 'dark' | 'light'
/** What the user picks; System follows the OS. */
export type ThemePref = 'system' | ThemeId

export const DARK: Theme = {
  id: 'dark',
  label: 'Dark',
  scheme: 'dark',
  termMinContrast: 1,
  tokens: {
    bg: '#0b0c0f',
    'bg-2': '#101217',
    'bg-3': '#161922',
    'bg-4': '#1c1f28',
    line: '#1f222b',
    'line-2': '#2a2d37',
    'line-3': '#3a3e4b',
    text: '#e8e8ec',
    'text-2': '#c9cbd3',
    'text-3': '#aeb2bd',
    muted: '#7c808c',
    faint: '#5d616c',
    accent: '#79a8ff',
    'accent-soft': 'rgba(121, 168, 255, 0.14)',
    'on-accent': '#0b1020',
    knob: '#e8e8ec',
    green: '#4fd49a',
    'green-2': '#9ae6b4',
    amber: '#d9a441',
    red: '#ff7a7a',
    purple: '#b08cff',
    'purple-2': '#c4b5fd',
    grey: '#6b7280',
    orange: '#f28b50',
    teal: '#4fd1c5',
    aqua: '#2dd4bf',
    violet: '#c084fc',
    claude: '#d97757',
    scrim: 'rgba(0, 0, 0, 0.55)',
    shadow: 'rgba(0, 0, 0, 0.45)',
    veil: 'rgba(15, 17, 23, 0.88)',
    mark: '#d9a441',
    'mark-soft': 'rgba(217, 164, 65, 0.38)',
    'on-mark': '#111111',
    'term-bg': '#0b0c0f',
    'term-fg': '#e6e9ef',
    'term-cursor': '#6aa9ff',
    'term-selection': 'rgba(106, 169, 255, 0.35)',
    'term-black': '#1c2130',
    'term-red': '#f26d6d',
    'term-green': '#3ecf8e',
    'term-yellow': '#f5b83d',
    'term-blue': '#6aa9ff',
    'term-magenta': '#a78bfa',
    'term-cyan': '#4fd1c5',
    'term-white': '#e6e9ef',
    'term-bright-black': '#5d6579',
    'term-bright-red': '#ff8a8a',
    'term-bright-green': '#6ee7b7',
    'term-bright-yellow': '#fcd34d',
    'term-bright-blue': '#93c5fd',
    'term-bright-magenta': '#c4b5fd',
    'term-bright-cyan': '#81e6d9',
    'term-bright-white': '#ffffff',
    'term-match': '#5a4a1a',
    'term-match-active': '#d9a441',
    'term-match-ruler': '#ffcf6b',
  },
}

/** GitHub Primer's light palette as the base, tuned for WCAG AA on every surface (themes.test.ts). */
export const LIGHT: Theme = {
  id: 'light',
  label: 'Light',
  scheme: 'light',
  termMinContrast: 4.5,
  tokens: {
    bg: '#ffffff',
    'bg-2': '#f6f8fa',
    'bg-3': '#eef1f4',
    'bg-4': '#e6eaef',
    line: '#d8dee4',
    'line-2': '#c4ccd5',
    'line-3': '#818b96',
    text: '#1f2328',
    'text-2': '#31363d',
    'text-3': '#424a53',
    muted: '#4b535d',
    faint: '#545c66',
    accent: '#0756b5',
    'accent-soft': 'rgba(9, 105, 218, 0.12)',
    'on-accent': '#ffffff',
    knob: '#ffffff',
    green: '#16692c',
    'green-2': '#1e6836',
    amber: '#7c5300',
    red: '#ac1924',
    purple: '#6a3ebe',
    'purple-2': '#6639ba',
    grey: '#545c65',
    orange: '#9a3d00',
    teal: '#0a665e',
    aqua: '#0c627c',
    violet: '#822cbb',
    claude: '#944224',
    scrim: 'rgba(31, 35, 40, 0.4)',
    shadow: 'rgba(31, 35, 40, 0.16)',
    veil: 'rgba(255, 255, 255, 0.9)',
    mark: '#f5d35b',
    'mark-soft': 'rgba(245, 196, 40, 0.4)',
    'on-mark': '#1f2328',
    'term-bg': '#ffffff',
    'term-fg': '#1f2328',
    'term-cursor': '#0969da',
    'term-selection': 'rgba(9, 105, 218, 0.22)',
    'term-black': '#24292f',
    'term-red': '#cf222e',
    'term-green': '#116329',
    'term-yellow': '#4d2d00',
    'term-blue': '#0969da',
    'term-magenta': '#8250df',
    'term-cyan': '#1b7c83',
    'term-white': '#6e7781',
    'term-bright-black': '#57606a',
    'term-bright-red': '#a40e26',
    'term-bright-green': '#1a7f37',
    'term-bright-yellow': '#633c01',
    'term-bright-blue': '#218bff',
    'term-bright-magenta': '#a475f9',
    'term-bright-cyan': '#3192aa',
    'term-bright-white': '#8c959f',
    'term-match': '#fff1a8',
    'term-match-active': '#f5d35b',
    'term-match-ruler': '#bf8700',
  },
}

export const THEMES: Record<ThemeId, Theme> = { dark: DARK, light: LIGHT }

export const THEME_PREFS: ThemePref[] = ['light', 'dark', 'system']

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'system' || (typeof v === 'string' && Object.hasOwn(THEMES, v))
}

/** The theme to draw for a preference; System picks by the OS's dark mode. */
export function resolveTheme(pref: ThemePref, osDark: boolean): Theme {
  if (pref === 'system') return osDark ? DARK : LIGHT
  return THEMES[pref] ?? DARK
}

/** The CSS custom properties of a theme: `{ '--bg': '#0b0c0f', … }`. */
export function themeVars(t: Theme): Record<string, string> {
  return Object.fromEntries(TOKENS.map((k) => [`--${k}`, t.tokens[k]]))
}

/** The xterm.js theme (ITheme) of a theme. */
export function xtermTheme(t: Theme): Record<string, string> {
  const k = t.tokens
  return {
    background: k['term-bg'],
    foreground: k['term-fg'],
    cursor: k['term-cursor'],
    cursorAccent: k['term-bg'],
    selectionBackground: k['term-selection'],
    black: k['term-black'],
    red: k['term-red'],
    green: k['term-green'],
    yellow: k['term-yellow'],
    blue: k['term-blue'],
    magenta: k['term-magenta'],
    cyan: k['term-cyan'],
    white: k['term-white'],
    brightBlack: k['term-bright-black'],
    brightRed: k['term-bright-red'],
    brightGreen: k['term-bright-green'],
    brightYellow: k['term-bright-yellow'],
    brightBlue: k['term-bright-blue'],
    brightMagenta: k['term-bright-magenta'],
    brightCyan: k['term-bright-cyan'],
    brightWhite: k['term-bright-white'],
  }
}

// ── Contrast (WCAG 2.x), for the tests and anyone tuning a palette ────────────────────────────

type Rgba = [number, number, number, number]

/** `#rgb`, `#rrggbb` or `rgb()/rgba()` → [r, g, b, a] (0-255, alpha 0-1). */
export function parseColor(c: string): Rgba {
  const s = c.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join('') : hex[1]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (fn) {
    const [r, g, b, a] = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return [r, g, b, a ?? 1]
  }
  throw new Error(`not a colour: ${c}`)
}

/** `top` at `alpha` (default: its own) over an opaque `under`, as #rrggbb. */
export function blend(top: string, under: string, alpha?: number): string {
  const [r1, g1, b1, a1] = parseColor(top)
  const [r2, g2, b2] = parseColor(under)
  const a = alpha ?? a1
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a))
  return '#' + [mix(r1, r2), mix(g1, g2), mix(b1, b2)].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function luminance(c: string): number {
  const [r, g, b] = parseColor(c).map((v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The WCAG contrast ratio of two opaque colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
