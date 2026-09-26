/**
 * babysit-proof: a screenshot after every page action, taken while the test runs.
 *
 * Import `test` and `expect` from this file instead of '@playwright/test'. The `page` fixture is
 * wrapped so that each action (goto, click, fill, press, check, selectOption, ...) on the page or
 * on a locator is followed by a screenshot, plus one at the end of the test. Nothing is run twice.
 * Screenshots go to $PROOF_DIR/steps/<test title>/NN-<action>.png (the test's output dir without
 * PROOF_DIR), so a normal run without the skill still works and just keeps them locally.
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ACTIONS = new Set(['goto', 'reload', 'goBack', 'goForward', 'setContent', 'click', 'dblclick', 'tap', 'fill', 'press', 'pressSequentially', 'type', 'check', 'uncheck', 'setChecked', 'selectOption', 'setInputFiles', 'hover', 'dragTo', 'clear'])
const CHAIN = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'first', 'last', 'nth', 'filter', 'and', 'or'])

/** A readable step name: `click getByRole button "Add"`, `fill getByPlaceholder "What" "Buy milk"`. */
function label(prop: string, args: unknown[], what: string): string {
  const parts = [prop, what]
  for (const x of args) {
    if (typeof x === 'string' && prop !== 'setContent') parts.push(prop === 'goto' ? x.slice(0, 60) : `"${x.slice(0, 40)}"`)
    else if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') parts.push(`"${(x as { name: string }).name.slice(0, 40)}"`)
  }
  return parts.filter(Boolean).join(' ')
}

function wrap<T extends object>(target: T, page: Page, shot: (l: string) => Promise<void>, what: string): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, t)
      if (typeof v !== 'function' || typeof prop !== 'string') return v
      return (...args: unknown[]) => {
        const r = v.apply(t, args)
        if (CHAIN.has(prop) && r && typeof r === 'object') return wrap(r as Locator, page, shot, `${what ? what + ' → ' : ''}${label(prop, args, '')}`)
        if (ACTIONS.has(prop) && r instanceof Promise) return r.then(async (res) => (await shot(label(prop, args, what)), res))
        return r
      }
    },
  })
}

export const test = base.extend({
  page: async ({ page }, use, info) => {
    const dir = join(process.env.PROOF_DIR ?? info.outputDir, 'steps', info.titlePath.slice(1).join(' › ').replace(/[^\w.-]+/g, '-').slice(0, 80))
    mkdirSync(dir, { recursive: true })
    let n = 0
    const shot = async (l: string) => {
      n++
      await page.screenshot({ path: join(dir, `${String(n).padStart(2, '0')}-${l.replace(/[^\w.-]+/g, '-').slice(0, 60)}.png`) }).catch(() => undefined)
    }
    await use(wrap(page, page, shot, ''))
    // How the test left the screen, after its last expectations.
    await shot('final')
  },
})
export { expect }
