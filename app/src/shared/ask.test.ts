import { describe, expect, it } from 'vitest'
import { answeredInSession, answerKeys, withoutReport, menuOnScreen, parseMenuScreen, reportQuestion, sessionAsk, textOptions, type ScreenMenu } from './ask'

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
const user = (s: number, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', timestamp: t(s), message: { role: 'user', content: text }, ...extra })
const said = (s: number, text: string) => JSON.stringify({ type: 'assistant', timestamp: t(s), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const tool = (s: number, name: string, input: unknown, id = 'toolu_1') =>
  JSON.stringify({ type: 'assistant', timestamp: t(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (s: number, id = 'toolu_1') =>
  JSON.stringify({ type: 'user', timestamp: t(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'The user answered' }] } })

const MENU = {
  questions: [
    { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
    { question: 'Which pets?', header: 'Pets', multiSelect: true, options: [{ label: 'Cat', description: '' }, { label: 'Dog', description: '' }, { label: 'Fish', description: '' }] },
  ],
}

describe('sessionAsk', () => {
  it('reads a question report to master-agent and the full question asked after it', () => {
    const a = sessionAsk([
      user(0, 'You own #12'),
      said(1, 'Looking around.'),
      tool(2, 'SendMessage', { to: 'master-agent', message: '#12: question — which option?' }, 'toolu_s'),
      said(3, 'Which should we use?\n\n1. Postgres\n2. SQLite\n   small and local\n3. Neither'),
    ])
    expect(a.report).toMatchObject({ issue: 12, at: Date.parse(t(2)) })
    expect(reportQuestion(a.report!)).toBe('which option?')
    expect(a.said?.text).toBe('Which should we use?\n\n1. Postgres\n2. SQLite\n   small and local\n3. Neither')
    expect(a.said?.options).toEqual([
      { key: '1', text: 'Postgres' },
      { key: '2', text: 'SQLite' },
      { key: '3', text: 'Neither' },
    ])
  })

  it('knows when the user answered in the session', () => {
    const lines = [tool(2, 'SendMessage', { to: 'master-agent', message: '#12: question — A or B?' }), said(3, 'A or B?')]
    expect(answeredInSession(sessionAsk(lines), { repo: null, number: 12 })).toBe(false)
    expect(answeredInSession(sessionAsk([...lines, user(4, 'A')]), { repo: null, number: 12 })).toBe(true)
    // Another issue's report, hooks and other sessions' messages are not answers.
    expect(answeredInSession(sessionAsk([...lines, user(4, 'A')]), { repo: null, number: 13 })).toBe(false)
    expect(answeredInSession(sessionAsk([...lines, user(4, '<cross-session-message from="m">hi</cross-session-message>')]), { repo: null, number: 12 })).toBe(false)
    expect(answeredInSession(sessionAsk([...lines, user(4, 'Base directory for this skill: /x')]), { repo: null, number: 12 })).toBe(false)
    expect(answeredInSession(sessionAsk([...lines, user(4, 'note', { isMeta: true })]), { repo: null, number: 12 })).toBe(false)
  })

  it('does not count what MasterDeck types in (PR watch, monitors) as the user writing', () => {
    const lines = [user(1, 'Fix the login bug'), said(2, 'Opened the PR.')]
    expect(sessionAsk(lines).userAt).toBe(Date.parse(t(1)))
    // The PR watch's "merged" message comes after the merge: it must not read as new instructions (Rework).
    expect(sessionAsk([...lines, user(3, '[MasterDeck PR watch] acme/web#83: merged. The PR watch has ended.')]).userAt).toBe(Date.parse(t(1)))
    expect(sessionAsk([...lines, user(3, '[MasterDeck monitor: deploy]\nok')]).userAt).toBe(Date.parse(t(1)))
    expect(sessionAsk([...lines, user(3, 'Now also fix logout')]).userAt).toBe(Date.parse(t(3)))
  })

  it('reads a report said in the session itself (no master-agent)', () => {
    const a = sessionAsk([said(1, '#7: question — ship it today?')])
    expect(a.report?.issue).toBe(7)
    expect(a.said?.text).toBe('#7: question — ship it today?')
  })

  it('skips sidechain lines and bad JSON', () => {
    const side = JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: t(1), message: { content: [{ type: 'text', text: '#3: question — x?' }] } })
    expect(sessionAsk(['{"message":', side]).report).toBeNull()
  })
})

describe('textOptions', () => {
  it('reads lettered and bold options', () => {
    expect(textOptions('Pick one?\n**A.** Mirror the list\n**B.** Add a flag')).toEqual([
      { key: 'A', text: 'Mirror the list' },
      { key: 'B', text: 'Add a flag' },
    ])
    expect(textOptions('Which?\n- Option A: one\n- Option B: two')).toEqual([
      { key: 'A', text: 'one' },
      { key: 'B', text: 'two' },
    ])
  })

  it('needs a question and a list in order', () => {
    expect(textOptions('Done:\n1. this\n2. that')).toEqual([])
    expect(textOptions('Which?\n2. two\n3. three')).toEqual([])
    expect(textOptions('Which?\n1. only one')).toEqual([])
  })

  it('takes the last list', () => {
    expect(textOptions('Steps:\n1. a\n2. b\n\nWhich now?\nA) x\nB) y').map((o) => o.key)).toEqual(['A', 'B'])
  })
})

const COLOUR = `❯ Use the AskUserQuestion tool to ask me two questions
──────────────────────────────────────────────
←  ☐ Colour  ☐ Pets  ✔ Submit  →

What's your favourite colour?

❯ 1. Red
     Warm and vibrant
  2. Green
     Calm and natural
  3. Blue
  4. Type something.
──────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`

const PETS = `←  ☒ Colour  ☐ Pets  ✔ Submit  →

Which pets do you like?

❯ 1. [✔] Cat
         Independent
  2. [ ] Dog
  3. [✔] Fish
  4. [ ] Type something
     Submit
──────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`

const REVIEW = `←  ☒ Colour  ☒ Pets  ✔ Submit  →
Review your answers
 ● What's your favourite colour?
   → Green
 ● Which pets do you like?
   → Cat, Fish
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel`

const SINGLE_SCREEN = `❯ Use the AskUserQuestion tool to ask me one question
──────────────────────────────────────────────
 ☐ Colour

What's your favourite colour?

❯ 1. Red
     Warm, energetic, bold
  2. Green
  3. Blue
  4. Type something.
──────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`

describe('parseMenuScreen', () => {
  it('reads a one-question menu (no tab row, just its header)', () => {
    const m = parseMenuScreen(SINGLE_SCREEN)!
    expect(m.tabs).toEqual([{ label: 'Colour', answered: false }])
    expect(m.question).toMatchObject({ question: "What's your favourite colour?", header: 'Colour', multiSelect: false })
    expect(m.question!.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue'])
    expect(menuOnScreen(SINGLE_SCREEN)).toBe(true)
  })

  it('reads the question on screen, its options and descriptions', () => {
    expect(parseMenuScreen(COLOUR)).toEqual({
      tabs: [
        { label: 'Colour', answered: false },
        { label: 'Pets', answered: false },
      ],
      question: {
        question: "What's your favourite colour?",
        header: 'Colour',
        multiSelect: false,
        options: [
          { label: 'Red', description: 'Warm and vibrant' },
          { label: 'Green', description: 'Calm and natural' },
          { label: 'Blue', description: '' },
        ],
      },
      checked: [],
      review: null,
    })
  })

  it('reads a multi-select and what is ticked', () => {
    const m = parseMenuScreen(PETS)!
    expect(m.question).toMatchObject({ header: 'Pets', multiSelect: true })
    expect(m.question!.options.map((o) => o.label)).toEqual(['Cat', 'Dog', 'Fish'])
    expect(m.checked).toEqual([1, 3])
  })

  it('reads the review screen', () => {
    expect(parseMenuScreen(REVIEW)).toMatchObject({
      question: null,
      review: [
        { question: "What's your favourite colour?", answer: 'Green' },
        { question: 'Which pets do you like?', answer: 'Cat, Fish' },
      ],
    })
  })

  it('is null without a menu', () => {
    expect(parseMenuScreen('❯ Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBeNull()
  })
})

describe('answerKeys', () => {
  const colour = parseMenuScreen(COLOUR)!
  const pets = parseMenuScreen(PETS)!
  it('picks by digit, or types through "Type something"', () => {
    expect(answerKeys(colour, { picks: [1] })).toEqual([{ keys: '2', wait: 700 }])
    expect(answerKeys(colour, { picks: [], text: 'Purple\nplease' })).toEqual([
      { keys: '4', wait: 500 },
      { keys: 'Purple please', wait: 300 },
      { keys: '\r', wait: 700 },
    ])
  })

  it('toggles a multi-select from what is ticked to what was picked, then moves on', () => {
    // Ticked: Cat, Fish. Wanted: Dog, Fish.
    expect(answerKeys(pets, { picks: [1, 2] })).toEqual([
      { keys: '1', wait: 300 },
      { keys: '2', wait: 300 },
      { keys: '\x1b[C', wait: 700 },
    ])
  })

  it('submits only from the review screen', () => {
    expect(answerKeys(parseMenuScreen(REVIEW)!, 'submit')).toEqual([{ expect: /Submit answers/, keys: '\r', wait: 500 }])
    expect(answerKeys(colour, 'submit')).toMatch(/not ready/)
  })

  it('refuses answers that do not fit', () => {
    expect(answerKeys(colour, { picks: [5] })).toBe('no such option')
    expect(answerKeys(colour, { picks: [0, 1] })).toBe('pick one option')
    expect(answerKeys(pets, { picks: [] })).toMatch(/at least one/)
    expect(answerKeys(pets, { picks: [0], text: 'x' })).toMatch(/options only/)
    expect(answerKeys(parseMenuScreen(REVIEW)! as ScreenMenu, { picks: [0] })).toBe('no question on screen')
  })
})

describe('menuOnScreen', () => {
  it('sees the menu footer through escape codes', () => {
    expect(menuOnScreen('← \x1b[48;2;1;1;1m ☐ Colour \x1b[14G☐\x1b[16GPets\x1b[22G✔\x1b[24GSubmit\x1b[32G→')).toBe(true)
    expect(menuOnScreen('❯ ready')).toBe(false)
    // A live screen places words with cursor moves: no spaces between them.
    expect(menuOnScreen('\x1b[2G☐\x1b[4GColour\x1b[9;1HEnter\x1b[7Gto\x1b[10Gselect\x1b[20GEsc\x1b[24Gto\x1b[27Gcancel')).toBe(true)
  })
})

describe('textOptions with details under each option', () => {
  it('reads bold numbered options with bullets between them', () => {
    const text = '## Options\n\n**1. Hidden switcher (recommended)**\n- a flag\n- Pros: x\n\n**2. Signed link**\n- key management\n\n**3. Passcode menu**\n\nWhich option?'
    expect(textOptions(text)).toEqual([
      { key: '1', text: 'Hidden switcher (recommended)' },
      { key: '2', text: 'Signed link' },
      { key: '3', text: 'Passcode menu' },
    ])
  })
})

describe('withoutReport', () => {
  it('drops a leading report prefix only', () => {
    expect(withoutReport('#99: question — Which one?\n1. a')).toBe('Which one?\n1. a')
    expect(withoutReport('Intro. #99: question — x')).toBe('Intro. #99: question — x')
  })
})
