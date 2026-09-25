import { describe, expect, it } from 'vitest'
import { looksLikePrompt } from './promptGuard'

describe('looksLikePrompt', () => {
  it('spots permission and choice prompts, through ANSI codes', () => {
    expect(looksLikePrompt('Bash command\n\x1b[1mgit push\x1b[0m\nDo you want to proceed?\n❯ 1. Yes\n  2. No')).toBe(true)
    expect(looksLikePrompt('Edit file\nDo you want to make this edit to a.ts?\n❯ 1. Yes\n  2. Yes, allow all\n  3. No')).toBe(true)
  })
  it('an idle prompt box is not a permission prompt', () => {
    expect(looksLikePrompt('● OK\n\n────────\n❯ \n────────\n  ⏵⏵ auto mode on')).toBe(false)
  })
})
