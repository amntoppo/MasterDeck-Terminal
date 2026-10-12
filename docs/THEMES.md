# Themes

MasterDeck draws every colour from a **theme**: a named set of token values in
[`app/src/shared/themes.ts`](../app/src/shared/themes.ts). v1 ships two, **Dark** (the original
look) and **Light**, and a Light / Dark / System setting (issue #105). This page has the exploration
behind the design, the light palette, the token table and how to add a theme.

## Exploration: how comparable apps do it

| App | How themes work | What MasterDeck takes from it |
|---|---|---|
| **VS Code** | A theme is a JSON file of named colour keys (`editor.background`, `terminal.ansiRed` …) with `"type": "light" \| "dark"`. With "auto detect colour scheme" on, it picks a preferred light or dark theme by the OS. | One flat set of named keys per theme. The terminal's 16 ANSI colours are theme keys. A theme says whether it is light or dark. |
| **Warp** | A theme is a YAML file: `background`, `foreground`, `accent`, and `terminal_colors.normal` / `.bright` (8 + 8). | The terminal palette belongs to the theme, not to a separate setting. |
| **Linear** | Themes are generated from a few inputs (base, accent, contrast) in LCH. Light, Dark and System are the first choice in the menu. | System as a first-class choice. A small set of semantic tokens. |
| **GitHub (Primer)** | Semantic tokens (`fgColor-default`, `bgColor-muted`, `borderColor-default`, `fgColor-success` …) with light, dark, dimmed and high-contrast value sets, checked for WCAG. Light / Dark / Sync with system. | Names that describe a role (surface, text, border, status), not a hue. Primer light is the starting point for the light palette, which is checked for AA in a test. |

## How it works

- **Tokens** live in TypeScript. `TOKENS` lists every name. A `Theme` is
  `{ id, label, scheme, tokens, termMinContrast }`, and `tokens` is a
  `Record<Token, string>`, so the type checker rejects a theme that leaves a token out.
- **CSS reads only `var(--token)`.** At startup and on every change, `renderer/src/theme.ts`
  (`applyTheme`) writes the theme's tokens on `<html>` as custom properties, along with
  `color-scheme` (for native controls and scrollbars), `data-theme` and the `theme-color` meta.
  `styles.css` and `web.css` contain no colour values.
- **Tints are derived.** A soft fill is `color-mix(in srgb, var(--red) 16%, transparent)`, so a
  theme needs one value per hue, not a value for every tint.
- **The terminal** builds its xterm theme from the same tokens (`xtermTheme`). Open terminals
  switch at once (`onTheme`). `termMinContrast` becomes xterm's `minimumContrastRatio`: in the
  light theme (4.5), text that a program coloured for a dark background, such as Claude Code's
  own dark theme, is darkened until it is readable.
- **The setting.** In the Mac's window, Settings → General → **Appearance** saves
  `settings.theme` (`'light' | 'dark' | 'system'`, default `'dark'`). Main passes it to
  `nativeTheme.themeSource`, so native menus, dialogs and the renderer's `prefers-color-scheme`
  follow it, and sets the window's background colour to the theme's `bg`. **System** resolves
  through `matchMedia('(prefers-color-scheme: dark)')` and follows the OS live.
- **The web app** keeps its own choice per browser, in `localStorage` (`md.theme`). A phone and the
  Mac can differ, and a save from the web never changes the Mac's theme (`remoteSettings` keeps it).
- **First paint.** `bootTheme()` runs before React renders and applies the last choice from
  `localStorage` (the window mirrors its setting there), so the app never flashes the wrong theme.
- **Guards.**
  - `shared/themes.test.ts` checks that every theme has every token, and runs the WCAG AA checks for
    the light theme: text and status colours on every surface, text on solid fills, badge text on
    its own tint, focus and selection borders, switch thumbs, and the terminal.
  - `shared/themes.lint.test.ts` fails on any colour literal (`#hex`, `rgb()`, `hsl()`) in
    `renderer/src` or `src/web`.

## Tokens

| Group | Tokens | Used for |
|---|---|---|
| Surfaces | `bg`, `bg-2`, `bg-3`, `bg-4` | The page; panels and the sidebar; cards, inputs and hovers; raised popovers and tooltips |
| Lines | `line`, `line-2`, `line-3` | Hairline borders; stronger borders; hovered borders |
| Text | `text`, `text-2`, `text-3`, `muted`, `faint` | Body text; snippets; tool output; labels and hints; the least important text |
| Accent | `accent`, `accent-soft`, `on-accent`, `knob` | Selection, focus, links and primary buttons; the selected tint; text on any solid colour fill; a switch's thumb |
| Status and category | `green`, `green-2`, `amber`, `red`, `purple`, `purple-2`, `grey`, `orange`, `teal`, `aqua`, `violet`, `claude` | Session states, badges, PR states, board columns, workflow blocks, the Claude mark |
| Overlays | `scrim`, `shadow`, `veil` | The dialog backdrop; drop shadows; the cover over a terminal |
| Find | `mark`, `mark-soft`, `on-mark` | The current match; other matches; text on the current match |
| Terminal | `term-bg`, `term-fg`, `term-cursor`, `term-selection`, `term-black` … `term-bright-white` (16), `term-match`, `term-match-active`, `term-match-ruler` | xterm's theme and the ⌘F highlights |

## The light palette

The base is Primer light. Status colours are a little darker than Primer's so that they also pass
AA as text on their own 16–18 % badge tint.

| Token | Light | Dark | | Token | Light | Dark |
|---|---|---|---|---|---|---|
| `bg` | `#ffffff` | `#0b0c0f` | | `accent` | `#0756b5` | `#79a8ff` |
| `bg-2` | `#f6f8fa` | `#101217` | | `green` | `#16692c` | `#4fd49a` |
| `bg-3` | `#eef1f4` | `#161922` | | `amber` | `#7c5300` | `#d9a441` |
| `bg-4` | `#e6eaef` | `#1c1f28` | | `red` | `#ac1924` | `#ff7a7a` |
| `line` | `#d8dee4` | `#1f222b` | | `purple` | `#6a3ebe` | `#b08cff` |
| `line-2` | `#c4ccd5` | `#2a2d37` | | `orange` | `#9a3d00` | `#f28b50` |
| `text` | `#1f2328` | `#e8e8ec` | | `teal` | `#0a665e` | `#4fd1c5` |
| `muted` | `#4b535d` | `#7c808c` | | `claude` | `#944224` | `#d97757` |
| `faint` | `#545c66` | `#5d616c` | | `term-bg` / `term-fg` | `#ffffff` / `#1f2328` | `#0b0c0f` / `#e6e9ef` |

The light terminal uses GitHub's light ANSI palette. `themes.ts` has every value.

## Adding a theme

1. In `app/src/shared/themes.ts`, add its id to `ThemeId`, write a `Theme` (copy `DARK` or
   `LIGHT` and change the values: `scheme` says whether native controls should be light or dark,
   and `termMinContrast` is usually 1 for dark themes and 4.5 for light ones), and add it to
   `THEMES`. The type checker lists any token you missed.
2. Add the id to `THEME_PREFS` so Settings → Appearance offers it. `resolveTheme` decides what
   **System** maps to: change it if the new theme should be System's light or dark choice.
3. Run `npx vitest run src/shared/themes` from `app/`. To hold a light theme to AA, point the
   contrast block in `themes.test.ts` at it as well.

That is all: no CSS or component changes. If a new screen needs a colour no token describes, add
a token (to `TOKENS` and every theme) rather than writing a value into CSS. The lint test fails on
a literal.

## Not in v1

More themes (dimmed, high contrast), themes loaded from a user file, a custom accent colour, and a
web choice that follows the Mac. The token set is the extension point for each of them.
