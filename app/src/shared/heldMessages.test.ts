import { describe, expect, it } from 'vitest'
import { heldAnswer, heldViews, isCommand, isTyping, promptDraft } from './heldMessages'

const TOP = `${'─'.repeat(50)} acme-fix-12 ─`
const RULE = '─'.repeat(70)

describe('promptDraft', () => {
  it('reads what is typed in the box, and an empty box (its dim placeholder already blanked)', () => {
    expect(promptDraft(['⏺ Done.', '', TOP, '❯ refactor the login', RULE, '  ⏵⏵ auto mode on'])).toBe('refactor the login')
    expect(promptDraft(['⏺ Done.', '', TOP, '❯', RULE, '  ⏵⏵ auto mode on'])).toBe('')
    expect(promptDraft([TOP, '❯                ', RULE])).toBe('')
    // Claude Code's own: a no-break space after the glyph.
    expect(promptDraft([TOP, '❯ refactor the login', RULE])).toBe('refactor the login')
  })

  it('reads a draft of several lines, and shell mode as text', () => {
    expect(promptDraft([TOP, '❯ first line', '  second line', RULE])).toBe('first line\nsecond line')
    expect(promptDraft([TOP, '! ls', RULE])).toBe('!ls')
    expect(promptDraft([TOP, '!', RULE])).toBe('!')
  })

  it('takes the last box on screen, not a rule in the transcript', () => {
    expect(promptDraft([RULE, 'some output', RULE, '', TOP, '❯ mine', RULE, 'footer'])).toBe('mine')
  })

  it('says it does not know when no box is on screen', () => {
    expect(promptDraft(['⏺ Working…', '  Esc to cancel'])).toBe(null)
    expect(promptDraft([RULE, 'Do you want to proceed?', RULE])).toBe(null)
    expect(promptDraft([])).toBe(null)
  })
})

describe('isTyping', () => {
  it('counts keys, not the terminal reports a click or a window switch sends', () => {
    expect(isTyping('a')).toBe(true)
    expect(isTyping('\x7f')).toBe(true)
    expect(isTyping('\x1b[D')).toBe(true)
    expect(isTyping('\x1b[I')).toBe(false)
    expect(isTyping('\x1b[O\x1b[I')).toBe(false)
    expect(isTyping('\x1b[<0;12;5M\x1b[<0;12;5m')).toBe(false)
    expect(isTyping('\x1b[?1;2c')).toBe(false)
    expect(isTyping('\x1b[12;40R')).toBe(false)
    expect(isTyping('\x1b]11;rgb:0000/0000/0000\x07')).toBe(false)
  })
})

describe('held messages', () => {
  it('commands are typed, never submitted as words', () => {
    expect(isCommand('/compact')).toBe(true)
    expect(isCommand('!ls')).toBe(true)
    expect(isCommand('[MasterDeck PR watch] review')).toBe(false)
  })

  it('the UI gets a preview, not the whole text', () => {
    const [v] = heldViews([{ id: 'a', key: 'k', text: 'x'.repeat(500), from: 'PR watch', at: 1, reason: 'draft' }])
    expect(v.sessionKey).toBe('k')
    expect(v.preview.length).toBe(240)
    expect(v.preview.endsWith('…')).toBe(true)
  })

  it('the Stop hook hands it over as a block with the text', () => {
    const a = heldAnswer('PR #3 has a review', 1) as { decision: string; reason: string; systemMessage: string }
    expect(a.decision).toBe('block')
    expect(a.reason).toMatch(/1 more waiting/)
    expect(a.reason.endsWith('PR #3 has a review')).toBe(true)
    expect(a.systemMessage).toBe('▶ MasterDeck: PR #3 has a review')
  })
})
