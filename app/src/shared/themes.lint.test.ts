import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

/**
 * #105: every colour comes from a theme token (shared/themes.ts). Any colour literal in the renderer, the web
 * shell or their CSS fails here: use `var(--token)`, or `color-mix(in srgb, var(--token) N%, transparent)` for a tint.
 */
const ROOTS = ['src/renderer/src', 'src/web']
const SKIP = /\.test\.tsx?$|[/\\]public[/\\]|[/\\]preview[/\\]/
const COLOUR = /#[0-9a-fA-F]{3,8}\b(?![\w-])|\b(?:rgba?|hsla?)\(/g

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(n) && !SKIP.test(p) ? [p] : []
  })
}

it('no colour literal outside the theme tokens', () => {
  const root = join(__dirname, '../..')
  const hits: string[] = []
  for (const f of ROOTS.flatMap((r) => files(join(root, r)))) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // A comment may name a colour or an issue number (#105).
        const code = line.replace(/\/\*.*?\*\/|\/\/.*$/g, '')
        for (const m of code.matchAll(COLOUR)) {
          // An issue number in UI text ("#123"), not a colour: digits only, and not in CSS.
          if (/^#\d+$/.test(m[0]) && !f.endsWith('.css')) continue
          hits.push(`${relative(root, f)}:${i + 1}: ${m[0]}`)
        }
      })
  }
  expect(hits).toEqual([])
})
