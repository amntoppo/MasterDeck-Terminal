import { describe, expect, it } from 'vitest'
import { composePrompt } from './prompt'

describe('composePrompt', () => {
  it('is the system prompt alone when there are no instructions', () => {
    expect(composePrompt('  You own #9.\n', '   ')).toBe('You own #9.')
  })
  it('appends the instructions under a heading and overrides the ask-first step', () => {
    const p = composePrompt('You own #9.\n3. Then stop and ask the user.', 'Fix the web half only.\n')
    expect(p.startsWith('You own #9.')).toBe(true)
    expect(p).toContain('follow them instead of stopping to ask in step 3')
    expect(p.endsWith("## The user's first instructions\n\nFix the web half only.")).toBe(true)
  })
})
