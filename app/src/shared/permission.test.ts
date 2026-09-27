import { describe, expect, it } from 'vitest'
import { menuOnScreen, parseMenuScreen, parsePermissionScreen } from './ask'

// Rendered from a real `claude logs` of a session waiting on a Bash permission (Claude Code 2.1).
const BASH = `
❯ Run exactly this shell command with the Bash tool and nothing else: curl -sI
  https://example.com -o /dev/null -w '%{http_code}'

⏺ Running 1 shell command…
  ⎿  $ curl -sI https://example.com -o /dev/null -w '%{http_code}'

─────────────────────────────────────────────────────────────────────────────────────────────
 Bash command

   curl -sI https://example.com -o /dev/null -w '%{http_code}'
   Run shell command

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: curl *
   3. No

 Esc to cancel · Tab to amend
`

describe('parsePermissionScreen', () => {
  it('reads what it wants to run, why, the question and the options', () => {
    expect(parsePermissionScreen(BASH)).toEqual({
      title: 'Bash command',
      lines: ["curl -sI https://example.com -o /dev/null -w '%{http_code}'", 'Run shell command'],
      reason: 'This command requires approval',
      question: 'Do you want to proceed?',
      options: ['Yes', 'Yes, and don’t ask again for: curl *', 'No'],
    })
    // Not an AskUserQuestion menu.
    expect(parseMenuScreen(BASH)).toBeNull()
  })
  it('reads an edit prompt, with wrapped option text', () => {
    const edit = `──────────────────────────────
 Edit file
 src/app.ts
 Do you want to make this edit to app.ts?
 ❯ 1. Yes
   2. Yes, allow all edits during this session
      (shift+tab)
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel`
    expect(parsePermissionScreen(edit)).toMatchObject({
      title: 'Edit file',
      lines: ['src/app.ts'],
      reason: null,
      question: 'Do you want to make this edit to app.ts?',
      options: ['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No, and tell Claude what to do differently (esc)'],
    })
  })
  it('is null without a prompt, or once answered', () => {
    expect(parsePermissionScreen('⏺ Done.\n\n❯ ')).toBeNull()
    expect(parsePermissionScreen(BASH.replace(/ Esc to cancel.*\n/, ''))).toBeNull()
  })
})

describe('menuOnScreen', () => {
  it('sees a permission prompt, even with the spaces the live screen drops', () => {
    expect(menuOnScreen(BASH)).toBe(true)
    expect(menuOnScreen(BASH.replace(/ +/g, ''))).toBe(true)
    expect(menuOnScreen('⏺ Done.')).toBe(false)
  })
})
