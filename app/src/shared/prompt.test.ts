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
  it('adds the ticket description before the instructions', () => {
    const p = composePrompt('You own #9.', 'Web only.', '  Bell shows no count.\n')
    expect(p).toContain("The ticket's description and the user's first instructions are below; follow them instead")
    expect(p.endsWith("## The ticket's description\n\nBell shows no count.\n\n## The user's first instructions\n\nWeb only.")).toBe(true)
  })
  it('says what MasterDeck already set up right after the system prompt', () => {
    expect(composePrompt('You own #9.', '', '', '', ' You are in the worktree. ')).toBe('You own #9.\n\nYou are in the worktree.')
    const p = composePrompt('You own #9.', 'Web only.', '', '', 'You are in the worktree.')
    expect(p.startsWith("You own #9.\n\nYou are in the worktree.\n\nThe user's first instructions are below")).toBe(true)
  })
  it('uses the description alone as the instructions', () => {
    const p = composePrompt('You own #9.', ' ', 'Bell shows no count.')
    expect(p).toBe("You own #9.\n\nThe ticket's description is below; follow it instead of stopping to ask in step 3.\n\n## The ticket's description\n\nBell shows no count.")
  })
})

describe('composePrompt peers', () => {
  it('adds the linked sessions block after the earlier-sessions block', () => {
    const p = composePrompt('SYS', '', '', 'EARLIER', '', '## Linked sessions\n\n### x')
    expect(p.indexOf('EARLIER')).toBeLessThan(p.indexOf('## Linked sessions'))
  })
})
